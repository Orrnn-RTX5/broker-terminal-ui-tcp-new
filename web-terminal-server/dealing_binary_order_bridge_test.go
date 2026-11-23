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

func startDealingCapturingRTOGateway(tb testing.TB, respExtraByAction map[uint8][]byte) (
	addr string,
	lastPayload func() []byte,
	lastDecoded func() rtx5tcp.BinaryOrderFastReq,
	cleanup func(),
) {
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
					var trailing []byte
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
							ExecMicros:     19,
							OrderTicket:    710001,
							PositionTicket: 710001,
							DealTicket:     810001,
							FillPrice:      req.Price,
							Volume:         req.Volume,
							Symbol:         req.Symbol,
							ClientOrderID:  req.ClientOrderID,
						}
						if respExtraByAction != nil {
							trailing = respExtraByAction[req.Action]
						}
					}
					out := make([]byte, rtx5tcp.RTOFrameHeaderSize, 256)
					out[0], out[1], out[2], out[3] = 'R', 'T', 'O', rtx5tcp.RTOOpBinaryOrder
					binary.LittleEndian.PutUint32(out[4:8], reqID)
					out = rtx5tcp.AppendBinaryOrderFastResp(out, resp)
					if len(trailing) > 0 {
						out = append(out, trailing...)
					}
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

func buildRawDealingFrame(req rtx5tcp.BinaryOrderFastReq, rawTLV []byte) []byte {
	if len(rawTLV) == 0 {
		req.Flags &^= rtx5tcp.BinaryOrderFlagHasExtras
		return rtx5tcp.EncodeBinaryOrderFastReq(req)
	}
	req.Flags &^= rtx5tcp.BinaryOrderFlagHasExtras
	base := rtx5tcp.EncodeBinaryOrderFastReq(req)
	binary.LittleEndian.PutUint16(base[4:6], req.Flags|rtx5tcp.BinaryOrderFlagHasExtras)
	var extLen [2]byte
	binary.LittleEndian.PutUint16(extLen[:], uint16(len(rawTLV)))
	out := make([]byte, 0, len(base)+2+len(rawTLV))
	out = append(out, base...)
	out = append(out, extLen[:]...)
	out = append(out, rawTLV...)
	return out
}

func buildModeAFrameFromCanonical(reqID uint32, canonicalNoTok []byte) []byte {
	tokLen := int(binary.LittleEndian.Uint16(canonicalNoTok[128:130]))
	tail := canonicalNoTok[rtx5tcp.BinaryOrderFastReqHeaderSize+2+tokLen:]
	frame := make([]byte, 4+rtx5tcp.BinaryOrderFastReqHeaderSize+len(tail))
	binary.LittleEndian.PutUint32(frame[0:4], reqID)
	copy(frame[4:132], canonicalNoTok[:rtx5tcp.BinaryOrderFastReqHeaderSize])
	if len(tail) > 0 {
		copy(frame[132:], tail)
	}
	return frame
}

func TestDealingBinaryOrderBridgeExtrasAndActions9To11(t *testing.T) {
	prevGW := rtx5tcp.GetDefaultBinaryOrderGatewayAddr()
	t.Cleanup(func() {
		rtx5tcp.SetDefaultBinaryOrderGatewayAddr(prevGW)
	})

	respExtras := map[uint8][]byte{
		rtx5tcp.BinaryOrderActionRequoteAccept: {0x20, 0x04, 0x11, 0x27, 0x00, 0x00}, // Retcode 10001
		rtx5tcp.BinaryOrderActionDealingSync:   {0x2A, 0x01, 0x01},                   // DealingEnabled=1 (D18)
	}
	gwAddr, lastPayload, lastDecoded, closeGW := startDealingCapturingRTOGateway(t, respExtras)
	defer closeGW()
	rtx5tcp.SetDefaultBinaryOrderGatewayAddr(gwAddr)
	rtx5tcp.PrewarmBinaryOrderGatewayPool()

	srv := &WebTerminalServer{
		sessionTokens: make(map[string]string),
	}
	srv.setDefaultBroker("", "", "127.0.0.1:4443")

	mux := http.NewServeMux()
	mux.HandleFunc("/__rtx5_binary_order", srv.serveBinaryOrderHTTP)
	mux.HandleFunc("/__rtx5_binary_order_ws", srv.serveBinaryOrderWS)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/__rtx5_binary_order_ws"
	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": []string{ts.URL}})
	if err != nil {
		t.Fatalf("WS dial failed: %v", err)
	}
	defer wsConn.Close()

	boundTok := "jwt-dealing-prebound-token"
	prebind := make([]byte, 6+len(boundTok))
	binary.LittleEndian.PutUint32(prebind[0:4], 0)
	binary.LittleEndian.PutUint16(prebind[4:6], uint16(len(boundTok)))
	copy(prebind[6:], boundTok)
	if err := wsConn.WriteMessage(websocket.BinaryMessage, prebind); err != nil {
		t.Fatalf("WS prebind write failed: %v", err)
	}

	var nextReqID uint32 = 100
	sendWS := func(frame []byte) []byte {
		t.Helper()
		nextReqID++
		_ = wsConn.SetReadDeadline(time.Now().Add(5 * time.Second))
		if err := wsConn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			t.Fatalf("WS write failed: %v", err)
		}
		_, resp, rerr := wsConn.ReadMessage()
		if rerr != nil {
			t.Fatalf("WS read failed: %v", rerr)
		}
		if len(resp) < 4 {
			t.Fatalf("truncated WS resp len=%d", len(resp))
		}
		return resp[4:]
	}

	sendHTTP := func(payload []byte) []byte {
		t.Helper()
		resp, herr := http.Post(ts.URL+"/__rtx5_binary_order", "application/octet-stream", bytes.NewReader(payload))
		if herr != nil {
			t.Fatalf("HTTP POST failed: %v", herr)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return body
	}

	assertCanonicalExtrasMatch := func(t *testing.T, label string, wantTok string, wantExtrasBlock []byte) {
		t.Helper()
		got := lastPayload()
		tokLen := int(binary.LittleEndian.Uint16(got[128:130]))
		if string(got[130:130+tokLen]) != wantTok {
			t.Fatalf("%s token = %q, want %q", label, string(got[130:130+tokLen]), wantTok)
		}
		gotExtras := got[130+tokLen:]
		if !bytes.Equal(gotExtras, wantExtrasBlock) {
			t.Fatalf("%s extras mismatch:\ngot:  %x\nwant: %x", label, gotExtras, wantExtrasBlock)
		}
	}

	// 1. Frame WITH extras (0x06 Reason=1 + 0x16 ClientCaps=1) across HTTP, WS Mode A, WS Mode B, WS Mode B tokenLen=0.
	tlvReasonAndCaps := []byte{
		0x06, 1, 1, // Tag 0x06 Reason = 1 (ORDER_REASON_EXPERT)
		0x16, 4, 1, 0, 0, 0, // Tag 0x16 ClientCaps = 1 (CLIENT_CAP_DEALING_V1)
	}
	wantReasonCapsBlock := append([]byte{byte(len(tlvReasonAndCaps)), 0}, tlvReasonAndCaps...)

	orderBase := rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionPlaceMarket,
		Side:          rtx5tcp.BinaryOrderSideBuy,
		AccountLogin:  200074,
		Volume:        0.25,
		Symbol:        rtx5tcp.PackBinarySymbol("EURUSD"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("cid-extras-06-16"),
	}

	// HTTP
	httpReq := orderBase
	httpReq.AuthToken = "jwt-http-dealing-01"
	httpPayload := buildRawDealingFrame(httpReq, tlvReasonAndCaps)
	rawResp := sendHTTP(httpPayload)
	decResp, err := rtx5tcp.DecodeBinaryOrderFastResp(rawResp)
	if err != nil || !decResp.IsOK() {
		t.Fatalf("HTTP order with 0x06+0x16 failed: %+v err=%v", decResp, err)
	}
	assertCanonicalExtrasMatch(t, "HTTP 0x06+0x16", httpReq.AuthToken, wantReasonCapsBlock)

	// WS Mode A
	modeACanon := buildRawDealingFrame(orderBase, tlvReasonAndCaps)
	nextReqID++
	wsRespA := sendWS(buildModeAFrameFromCanonical(nextReqID, modeACanon))
	if decA, derr := rtx5tcp.DecodeBinaryOrderFastResp(wsRespA); derr != nil || !decA.IsOK() {
		t.Fatalf("WS Mode A order with 0x06+0x16 failed: %+v err=%v", decA, derr)
	}
	assertCanonicalExtrasMatch(t, "WS Mode A 0x06+0x16", boundTok, wantReasonCapsBlock)

	// WS Mode B (inline token)
	modeBReq := orderBase
	modeBReq.AuthToken = "jwt-ws-mode-b-dealing"
	modeBPayload := buildRawDealingFrame(modeBReq, tlvReasonAndCaps)
	nextReqID++
	modeBFrame := append(make([]byte, 4), modeBPayload...)
	binary.LittleEndian.PutUint32(modeBFrame[0:4], nextReqID)
	wsRespB := sendWS(modeBFrame)
	if decB, derr := rtx5tcp.DecodeBinaryOrderFastResp(wsRespB); derr != nil || !decB.IsOK() {
		t.Fatalf("WS Mode B order with 0x06+0x16 failed: %+v err=%v", decB, derr)
	}
	assertCanonicalExtrasMatch(t, "WS Mode B 0x06+0x16", modeBReq.AuthToken, wantReasonCapsBlock)
	// Restore prebound token on the WS connection since inline token updates connToken.
	if err := wsConn.WriteMessage(websocket.BinaryMessage, prebind); err != nil {
		t.Fatalf("WS re-prebind write failed: %v", err)
	}

	// WS Mode B with tokenLen == 0 + extras (falls back to prebound token)
	nextReqID++
	modeBZeroTokFrame := append(make([]byte, 4), modeACanon...)
	binary.LittleEndian.PutUint32(modeBZeroTokFrame[0:4], nextReqID)
	wsRespBZ := sendWS(modeBZeroTokFrame)
	if decBZ, derr := rtx5tcp.DecodeBinaryOrderFastResp(wsRespBZ); derr != nil || !decBZ.IsOK() {
		t.Fatalf("WS Mode B tokenLen=0 with 0x06+0x16 failed: %+v err=%v", decBZ, derr)
	}
	assertCanonicalExtrasMatch(t, "WS Mode B tokLen=0 0x06+0x16", boundTok, wantReasonCapsBlock)

	// 2. Frame WITHOUT extras remains byte-identical (HTTP + WS Mode A 132B).
	noExtHTTP := orderBase
	noExtHTTP.AuthToken = "jwt-no-ext-http"
	noExtHTTPWire := buildRawDealingFrame(noExtHTTP, nil)
	if dec, derr := rtx5tcp.DecodeBinaryOrderFastResp(sendHTTP(noExtHTTPWire)); derr != nil || !dec.IsOK() {
		t.Fatalf("HTTP no-extras failed: %+v err=%v", dec, derr)
	}
	if !bytes.Equal(lastPayload(), noExtHTTPWire) {
		t.Fatalf("HTTP no-extras payload modified:\ngot:  %x\nwant: %x", lastPayload(), noExtHTTPWire)
	}
	noExtModeA := buildRawDealingFrame(orderBase, nil)
	nextReqID++
	wsNoExtFrame := buildModeAFrameFromCanonical(nextReqID, noExtModeA)
	if len(wsNoExtFrame) != 132 {
		t.Fatalf("expected 132-byte WS Mode A frame, got %d", len(wsNoExtFrame))
	}
	if dec, derr := rtx5tcp.DecodeBinaryOrderFastResp(sendWS(wsNoExtFrame)); derr != nil || !dec.IsOK() {
		t.Fatalf("WS Mode A no-extras failed: %+v err=%v", dec, derr)
	}
	assertCanonicalExtrasMatch(t, "WS Mode A no-extras", boundTok, nil)
	if (lastDecoded().Flags & rtx5tcp.BinaryOrderFlagHasExtras) != 0 {
		t.Fatalf("expected BinaryOrderFlagHasExtras clear on no-extras order")
	}

	// 3. Actions 9 (Accept) and 10 (Decline) pass across HTTP, WS Mode A, and WS Mode B with 0x14+0x15+0x16 intact.
	tlvDealingIDs := []byte{
		0x14, 16, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
		0x15, 16, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
		0x16, 4, 1, 0, 0, 0,
	}
	wantDealingIDsBlock := append([]byte{byte(len(tlvDealingIDs)), 0}, tlvDealingIDs...)

	for _, tc := range []struct {
		name   string
		action uint8
		price  float64
	}{
		{"Action 9 Accept", rtx5tcp.BinaryOrderActionRequoteAccept, 1.08650},
		{"Action 10 Decline", rtx5tcp.BinaryOrderActionRequoteDecline, 0},
	} {
		req := rtx5tcp.BinaryOrderFastReq{
			Action:        tc.action,
			Side:          rtx5tcp.BinaryOrderSideBuy,
			AccountLogin:  200074,
			Volume:        0.25,
			Price:         tc.price,
			Symbol:        rtx5tcp.PackBinarySymbol("EURUSD"),
			ClientOrderID: rtx5tcp.PackBinaryClientOrderID("cid-dealing-act"),
			AuthToken:     "jwt-dealing-http",
		}
		httpFrame := buildRawDealingFrame(req, tlvDealingIDs)
		hResp := sendHTTP(httpFrame)
		hDec, herr := rtx5tcp.DecodeBinaryOrderFastResp(hResp)
		if herr != nil || !hDec.IsOK() || hDec.Action != tc.action {
			t.Fatalf("%s HTTP failed: %+v err=%v", tc.name, hDec, herr)
		}
		assertCanonicalExtrasMatch(t, tc.name+" HTTP", req.AuthToken, wantDealingIDsBlock)
		if tc.action == rtx5tcp.BinaryOrderActionRequoteAccept && !bytes.HasSuffix(hResp, respExtras[tc.action]) {
			t.Fatalf("%s HTTP missing trailing ExecWire TLVs: %x", tc.name, hResp)
		}

		reqNoTok := req
		reqNoTok.AuthToken = ""
		modeA := buildRawDealingFrame(reqNoTok, tlvDealingIDs)
		nextReqID++
		wResp := sendWS(buildModeAFrameFromCanonical(nextReqID, modeA))
		wDec, werr := rtx5tcp.DecodeBinaryOrderFastResp(wResp)
		if werr != nil || !wDec.IsOK() || wDec.Action != tc.action {
			t.Fatalf("%s WS Mode A failed: %+v err=%v", tc.name, wDec, werr)
		}
		assertCanonicalExtrasMatch(t, tc.name+" WS Mode A", boundTok, wantDealingIDsBlock)
	}

	// 4. Action 11 (DealingSync, login-only) passes across HTTP and WS (with and without extras), preserving 0x2A TLV in 0x39 reply.
	syncReq := rtx5tcp.BinaryOrderFastReq{
		Action:       rtx5tcp.BinaryOrderActionDealingSync,
		AccountLogin: 200074,
		AuthToken:    "jwt-sync-http",
	}
	syncHTTPResp := sendHTTP(buildRawDealingFrame(syncReq, nil))
	syncHTTPDec, serr := rtx5tcp.DecodeBinaryOrderFastResp(syncHTTPResp)
	if serr != nil || !syncHTTPDec.IsOK() || syncHTTPDec.Action != rtx5tcp.BinaryOrderActionDealingSync {
		t.Fatalf("Action 11 HTTP failed: %+v err=%v", syncHTTPDec, serr)
	}
	if !bytes.HasSuffix(syncHTTPResp, respExtras[rtx5tcp.BinaryOrderActionDealingSync]) {
		t.Fatalf("Action 11 HTTP response missing 0x2A TLV suffix: %x", syncHTTPResp)
	}

	syncNoTok := rtx5tcp.BinaryOrderFastReq{Action: rtx5tcp.BinaryOrderActionDealingSync, AccountLogin: 200074}
	nextReqID++
	syncWSResp := sendWS(buildModeAFrameFromCanonical(nextReqID, buildRawDealingFrame(syncNoTok, nil)))
	if dec, derr := rtx5tcp.DecodeBinaryOrderFastResp(syncWSResp); derr != nil || !dec.IsOK() || dec.Action != rtx5tcp.BinaryOrderActionDealingSync {
		t.Fatalf("Action 11 WS Mode A failed: %+v err=%v", dec, derr)
	}
	if !bytes.HasSuffix(syncWSResp, respExtras[rtx5tcp.BinaryOrderActionDealingSync]) {
		t.Fatalf("Action 11 WS Mode A response missing 0x2A TLV suffix: %x", syncWSResp)
	}

	// 5. Malformed 134-byte WS frame with HasExtras set and n16=6 returns 400 INVALID_BINARY_ORDER without panicking.
	bad134 := make([]byte, 134)
	binary.LittleEndian.PutUint32(bad134[0:4], 901)
	bad134[4] = rtx5tcp.BinaryOrderCodecVersion
	bad134[5] = rtx5tcp.BinaryOrderActionPlaceMarket
	bad134[6] = rtx5tcp.BinaryOrderSideBuy
	binary.LittleEndian.PutUint16(bad134[8:10], rtx5tcp.BinaryOrderFlagHasExtras)
	binary.LittleEndian.PutUint64(bad134[12:20], 200074)
	binary.LittleEndian.PutUint16(bad134[132:134], 6)
	bad134Resp := sendWS(bad134)
	decBad134, err := rtx5tcp.DecodeBinaryOrderFastResp(bad134Resp)
	if err != nil || decBad134.Status != rtx5tcp.BinaryOrderStatusBadRequest || decBad134.ErrorCode != "INVALID_BINARY_ORDER" {
		t.Fatalf("expected 400 INVALID_BINARY_ORDER on truncated 134B hasExtras frame, got %+v err=%v", decBad134, err)
	}

	// 6. Invalid Action 11 (non-empty Symbol) rejected with 400 INVALID_ORDER_PARAMS, and connection remains healthy.
	badSync := rtx5tcp.BinaryOrderFastReq{
		Action:       rtx5tcp.BinaryOrderActionDealingSync,
		AccountLogin: 200074,
		Symbol:       rtx5tcp.PackBinarySymbol("EURUSD"),
		AuthToken:    "jwt-bad-sync",
	}
	decBadSync, err := rtx5tcp.DecodeBinaryOrderFastResp(sendHTTP(buildRawDealingFrame(badSync, nil)))
	if err != nil || decBadSync.Status != rtx5tcp.BinaryOrderStatusBadRequest || decBadSync.ErrorCode != "INVALID_ORDER_PARAMS" {
		t.Fatalf("expected 400 INVALID_ORDER_PARAMS on Action 11 with symbol, got %+v err=%v", decBadSync, err)
	}
}
