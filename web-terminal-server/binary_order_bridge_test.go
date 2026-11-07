package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	rtx5tcp "rtx5-tcp-protocol"
)

func startCapturingRTOGateway(tb testing.TB) (addr string, lastPayload func() []byte, lastDecoded func() rtx5tcp.BinaryOrderFastReq, cleanup func()) {
	tb.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	var (
		mu      sync.Mutex
		rawLast []byte
		decLast rtx5tcp.BinaryOrderFastReq
	)
	go func() {
		for {
			conn, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReaderSize(c, 64*1024)
				var hdr [rtx5tcp.RTOFrameHeaderSize]byte
				for {
					if _, rerr := io.ReadFull(br, hdr[:]); rerr != nil {
						return
					}
					if hdr[0] != 'R' || hdr[1] != 'T' || hdr[2] != 'O' {
						return
					}
					op := hdr[3]
					reqID := binary.LittleEndian.Uint32(hdr[4:8])
					pLen := binary.LittleEndian.Uint32(hdr[8:12])
					payload := make([]byte, pLen)
					if pLen > 0 {
						if _, rerr := io.ReadFull(br, payload); rerr != nil {
							return
						}
					}
					if op == rtx5tcp.RTOOpVerifyAccountSub {
						var ack [rtx5tcp.RTOFrameHeaderSize + 2]byte
						ack[0], ack[1], ack[2], ack[3] = 'R', 'T', 'O', rtx5tcp.RTOOpVerifyAccountSub
						binary.LittleEndian.PutUint32(ack[4:8], reqID)
						binary.LittleEndian.PutUint32(ack[8:12], 2)
						binary.LittleEndian.PutUint16(ack[12:14], 200)
						_, _ = c.Write(ack[:])
						continue
					}
					if op != rtx5tcp.RTOOpBinaryOrder {
						return
					}
					var req rtx5tcp.BinaryOrderFastReq
					var resp rtx5tcp.BinaryOrderFastResp
					if derr := rtx5tcp.DecodeBinaryOrderFastReqInto(payload, &req); derr != nil {
						resp = rtx5tcp.BinaryOrderFastResp{
							Status:    rtx5tcp.BinaryOrderStatusBadRequest,
							ErrorCode: "GATEWAY_DECODE_ERR",
							Message:   derr.Error(),
						}
					} else {
						mu.Lock()
						rawLast = append(rawLast[:0], payload...)
						decLast = req
						mu.Unlock()
						resp = rtx5tcp.BinaryOrderFastResp{
							Action:         req.Action,
							Status:         rtx5tcp.BinaryOrderStatusOK,
							ExecMicros:     21,
							OrderTicket:    700001,
							PositionTicket: 700001,
							DealTicket:     800001,
							FillPrice:      1.08500,
							Volume:         req.Volume,
							Symbol:         req.Symbol,
							ClientOrderID:  req.ClientOrderID,
						}
					}
					out := make([]byte, rtx5tcp.RTOFrameHeaderSize, 256)
					out[0], out[1], out[2], out[3] = 'R', 'T', 'O', rtx5tcp.RTOOpBinaryOrder
					binary.LittleEndian.PutUint32(out[4:8], reqID)
					out = rtx5tcp.AppendBinaryOrderFastResp(out, resp)
					binary.LittleEndian.PutUint32(out[8:12], uint32(len(out)-rtx5tcp.RTOFrameHeaderSize))
					if _, werr := c.Write(out); werr != nil {
						return
					}
				}
			}(conn)
		}
	}()
	return ln.Addr().String(),
		func() []byte {
			mu.Lock()
			defer mu.Unlock()
			return append([]byte(nil), rawLast...)
		},
		func() rtx5tcp.BinaryOrderFastReq {
			mu.Lock()
			defer mu.Unlock()
			return decLast
		},
		func() { _ = ln.Close() }
}

func TestBinaryOrderBridgeForwardsExtras_ModeA_ModeB_HTTP(t *testing.T) {
	prevGW := rtx5tcp.GetDefaultBinaryOrderGatewayAddr()
	t.Cleanup(func() {
		rtx5tcp.SetDefaultBinaryOrderGatewayAddr(prevGW)
	})

	gwAddr, lastPayload, lastDecoded, closeGW := startCapturingRTOGateway(t)
	defer closeGW()
	rtx5tcp.SetDefaultBinaryOrderGatewayAddr(gwAddr)
	rtx5tcp.PrewarmBinaryOrderGatewayPool()

	srv := &WebTerminalServer{
		targetTCPAddr: "127.0.0.1:4443",
		sessionTokens: make(map[string]string),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/__rtx5_binary_order", srv.serveBinaryOrderHTTP)
	mux.HandleFunc("/__rtx5_binary_order_ws", srv.serveBinaryOrderWS)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	// 1. HTTP binary path (/ __rtx5_binary_order) with extras
	httpReqStruct := rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionPlaceMarket,
		Side:          rtx5tcp.BinaryOrderSideBuy,
		AccountLogin:  200074,
		Volume:        0.25,
		Symbol:        rtx5tcp.PackBinarySymbol("EURUSD"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("cid-http-extras-1"),
		AuthToken:     "jwt-http-token-001",
		Comment:       "http-fast-comment",
		Magic:         999003,
	}
	httpWire := rtx5tcp.EncodeBinaryOrderFastReq(httpReqStruct)
	httpResp, err := http.Post(ts.URL+"/__rtx5_binary_order", "application/octet-stream", bytes.NewReader(httpWire))
	if err != nil {
		t.Fatalf("HTTP POST failed: %v", err)
	}
	respBytes, _ := io.ReadAll(httpResp.Body)
	httpResp.Body.Close()
	decResp, err := rtx5tcp.DecodeBinaryOrderFastResp(respBytes)
	if err != nil || !decResp.IsOK() {
		t.Fatalf("HTTP binary order failed: resp=%+v err=%v", decResp, err)
	}
	gotHTTP := lastDecoded()
	if gotHTTP.Comment != "http-fast-comment" || gotHTTP.Magic != 999003 || gotHTTP.AuthToken != "jwt-http-token-001" {
		t.Fatalf("gateway decoded HTTP req = %+v, want comment=%q magic=%d", gotHTTP, "http-fast-comment", 999003)
	}
	if !bytes.Equal(lastPayload(), httpWire) {
		t.Fatalf("HTTP canonical payload mismatch:\ngot:  %x\nwant: %x", lastPayload(), httpWire)
	}

	// HTTP invalid extras rejected with 400 INVALID_BINARY_ORDER
	badHTTP := append([]byte(nil), httpWire[:rtx5tcp.BinaryOrderFastReqHeaderSize+2+len(httpReqStruct.AuthToken)]...)
	badHTTP = append(badHTTP, 0x05, 0x00, 0x01) // truncated extras block
	badResp, err := http.Post(ts.URL+"/__rtx5_binary_order", "application/octet-stream", bytes.NewReader(badHTTP))
	if err != nil {
		t.Fatalf("HTTP bad POST failed: %v", err)
	}
	badRespBytes, _ := io.ReadAll(badResp.Body)
	badResp.Body.Close()
	decBadHTTP, err := rtx5tcp.DecodeBinaryOrderFastResp(badRespBytes)
	if err != nil || decBadHTTP.Status != rtx5tcp.BinaryOrderStatusBadRequest || decBadHTTP.ErrorCode != "INVALID_BINARY_ORDER" {
		t.Fatalf("expected 400 INVALID_BINARY_ORDER on bad HTTP extras, got %+v (err=%v)", decBadHTTP, err)
	}

	// Open WebSocket connection for Mode A and Mode B tests
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/__rtx5_binary_order_ws"
	wsHeader := http.Header{"Origin": []string{ts.URL}}
	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, wsHeader)
	if err != nil {
		t.Fatalf("WS dial failed: %v", err)
	}
	defer wsConn.Close()

	// Pre-bind auth token via reqID = 0
	boundTok := "jwt-ws-prebound-token"
	prebind := make([]byte, 6+len(boundTok))
	binary.LittleEndian.PutUint32(prebind[0:4], 0)
	binary.LittleEndian.PutUint16(prebind[4:6], uint16(len(boundTok)))
	copy(prebind[6:], boundTok)
	if err := wsConn.WriteMessage(websocket.BinaryMessage, prebind); err != nil {
		t.Fatalf("WS prebind write failed: %v", err)
	}

	// 2. WS Mode A (token pre-bound, extras start at byte 132: [u32 reqId][128B header][u16 extrasLen][TLV])
	modeAReq := rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionPlaceMarket,
		Side:          rtx5tcp.BinaryOrderSideSell,
		AccountLogin:  200074,
		Volume:        0.50,
		Symbol:        rtx5tcp.PackBinarySymbol("XAUUSD"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("cid-ws-mode-a"),
		AuthToken:     "", // Mode A omits inline token
		Comment:       "ws-mode-a-comment",
		Magic:         777001,
	}
	canonicalNoTok := rtx5tcp.EncodeBinaryOrderFastReq(modeAReq)
	hdr128 := canonicalNoTok[:rtx5tcp.BinaryOrderFastReqHeaderSize]
	extrasBlock := canonicalNoTok[rtx5tcp.BinaryOrderFastReqHeaderSize+2:] // [u16 extrasLen][TLV]

	modeAFrame := make([]byte, 4+rtx5tcp.BinaryOrderFastReqHeaderSize+len(extrasBlock))
	binary.LittleEndian.PutUint32(modeAFrame[0:4], 101)
	copy(modeAFrame[4:132], hdr128)
	copy(modeAFrame[132:], extrasBlock)

	if err := wsConn.WriteMessage(websocket.BinaryMessage, modeAFrame); err != nil {
		t.Fatalf("WS Mode A write failed: %v", err)
	}
	_ = wsConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, wsRawRespA, err := wsConn.ReadMessage()
	if err != nil {
		t.Fatalf("WS Mode A read failed: %v", err)
	}
	if gotReqID := binary.LittleEndian.Uint32(wsRawRespA[0:4]); gotReqID != 101 {
		t.Fatalf("WS Mode A resp reqID = %d, want 101", gotReqID)
	}
	decRespA, err := rtx5tcp.DecodeBinaryOrderFastResp(wsRawRespA[4:])
	if err != nil || !decRespA.IsOK() {
		t.Fatalf("WS Mode A resp not OK: %+v err=%v", decRespA, err)
	}
	gotModeA := lastDecoded()
	if gotModeA.AuthToken != boundTok || gotModeA.Comment != "ws-mode-a-comment" || gotModeA.Magic != 777001 {
		t.Fatalf("gateway decoded Mode A = %+v, want tok=%q comment=%q magic=%d", gotModeA, boundTok, "ws-mode-a-comment", 777001)
	}

	// 3. WS Mode B (inline token + extras after token: [u32 reqId][128B header][u16 tokenLen][token][u16 extrasLen][TLV])
	modeBReq := rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionModifyPending,
		Ticket:        555123,
		Flags:         rtx5tcp.BinaryOrderFlagHasPrice,
		Price:         1.09123,
		AccountLogin:  200074,
		Symbol:        rtx5tcp.PackBinarySymbol("GBPUSD"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("cid-ws-mode-b"),
		AuthToken:     "jwt-ws-inline-mode-b-tok",
		Comment:       "ws-mode-b-comment",
		Magic:         888002,
	}
	canonicalModeB := rtx5tcp.EncodeBinaryOrderFastReq(modeBReq)
	modeBFrame := make([]byte, 4+len(canonicalModeB))
	binary.LittleEndian.PutUint32(modeBFrame[0:4], 202)
	copy(modeBFrame[4:], canonicalModeB)

	if err := wsConn.WriteMessage(websocket.BinaryMessage, modeBFrame); err != nil {
		t.Fatalf("WS Mode B write failed: %v", err)
	}
	_ = wsConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, wsRawRespB, err := wsConn.ReadMessage()
	if err != nil {
		t.Fatalf("WS Mode B read failed: %v", err)
	}
	if gotReqID := binary.LittleEndian.Uint32(wsRawRespB[0:4]); gotReqID != 202 {
		t.Fatalf("WS Mode B resp reqID = %d, want 202", gotReqID)
	}
	decRespB, err := rtx5tcp.DecodeBinaryOrderFastResp(wsRawRespB[4:])
	if err != nil || !decRespB.IsOK() {
		t.Fatalf("WS Mode B resp not OK: %+v err=%v", decRespB, err)
	}
	gotModeB := lastDecoded()
	if gotModeB.AuthToken != "jwt-ws-inline-mode-b-tok" || gotModeB.Comment != "ws-mode-b-comment" || gotModeB.Magic != 888002 {
		t.Fatalf("gateway decoded Mode B = %+v, want comment=%q magic=%d", gotModeB, "ws-mode-b-comment", 888002)
	}
	if !bytes.Equal(lastPayload(), canonicalModeB) {
		t.Fatalf("Mode B canonical payload mismatch:\ngot:  %x\nwant: %x", lastPayload(), canonicalModeB)
	}

	// 4. WS Mode A with flag set but missing extras (132 bytes) -> rejected with 400 INVALID_BINARY_ORDER
	badModeA := make([]byte, 132)
	binary.LittleEndian.PutUint32(badModeA[0:4], 303)
	copy(badModeA[4:132], hdr128) // hdr128 has BinaryOrderFlagHasExtras set
	if err := wsConn.WriteMessage(websocket.BinaryMessage, badModeA); err != nil {
		t.Fatalf("WS bad Mode A write failed: %v", err)
	}
	_, wsRawBadA, err := wsConn.ReadMessage()
	if err != nil {
		t.Fatalf("WS bad Mode A read failed: %v", err)
	}
	decBadA, err := rtx5tcp.DecodeBinaryOrderFastResp(wsRawBadA[4:])
	if err != nil || decBadA.Status != rtx5tcp.BinaryOrderStatusBadRequest || decBadA.ErrorCode != "INVALID_BINARY_ORDER" {
		t.Fatalf("expected 400 INVALID_BINARY_ORDER on bad WS Mode A extras, got %+v (err=%v)", decBadA, err)
	}
}

func BenchmarkValidateBinaryOrderHeaderNoExtras(b *testing.B) {
	req := rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionPlaceMarket,
		Side:          rtx5tcp.BinaryOrderSideBuy,
		Flags:         rtx5tcp.BinaryOrderFlagHasSL | rtx5tcp.BinaryOrderFlagHasTP,
		AccountLogin:  200074,
		Ticket:        999001,
		Volume:        0.10,
		SL:            1.08000,
		TP:            1.09200,
		Symbol:        rtx5tcp.PackBinarySymbol("EURUSD"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("bench-bridge-001"),
	}
	encoded := rtx5tcp.EncodeBinaryOrderFastReq(req)
	hdr128 := encoded[:rtx5tcp.BinaryOrderFastReqHeaderSize]
	var out rtx5tcp.BinaryOrderFastReq
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if errCode, err := validateBinaryOrderHeaderZeroAlloc(hdr128, &out); err != nil || errCode != "" {
			b.Fatalf("validate failed: %s %v", errCode, err)
		}
	}
}

func BenchmarkValidateBinaryOrderHeaderWithExtras(b *testing.B) {
	req := rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionPlaceMarket,
		Side:          rtx5tcp.BinaryOrderSideBuy,
		Flags:         rtx5tcp.BinaryOrderFlagHasSL | rtx5tcp.BinaryOrderFlagHasTP,
		AccountLogin:  200074,
		Ticket:        999001,
		Volume:        0.10,
		SL:            1.08000,
		TP:            1.09200,
		Symbol:        rtx5tcp.PackBinarySymbol("EURUSD"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("bench-bridge-ext-001"),
		Comment:       "scalp-bot-v2",
		Magic:         20261107,
	}
	encoded := rtx5tcp.EncodeBinaryOrderFastReq(req)
	hdr128 := encoded[:rtx5tcp.BinaryOrderFastReqHeaderSize]
	extrasBlock := encoded[rtx5tcp.BinaryOrderFastReqHeaderSize+2:]
	var out rtx5tcp.BinaryOrderFastReq
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if errCode, _, err := validateBinaryOrderHeaderAndExtras(hdr128, extrasBlock, &out); err != nil || errCode != "" {
			b.Fatalf("validate with extras failed: %s %v", errCode, err)
		}
	}
}
