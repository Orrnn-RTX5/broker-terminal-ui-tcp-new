package clientcore

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
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

type wsOrderTestHarness struct {
	client       *DesktopClient
	localURL     string
	fastOrderURL string
	fastWSURL    string
	lastTokenMu  sync.Mutex
	lastToken    string
	cleanup      func()
}

func startWSOrderTestHarness(tb testing.TB) *wsOrderTestHarness {
	tb.Helper()

	prevGW := rtx5tcp.GetDefaultBinaryOrderGatewayAddr()

	// 1. Mock Raw Binary TCP Gateway (:8190 equivalent)
	gwLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}

	h := &wsOrderTestHarness{}

	go func() {
		for {
			conn, aerr := gwLn.Accept()
			if aerr != nil {
				return
			}
			if tc, ok := conn.(*net.TCPConn); ok {
				_ = tc.SetNoDelay(true)
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReaderSize(c, 64*1024)
				var hdr [rtx5tcp.RTOFrameHeaderSize]byte
				writeBuf := make([]byte, 0, 512)
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
					if op != rtx5tcp.RTOOpBinaryOrder {
						return
					}
					var req rtx5tcp.BinaryOrderFastReq
					var resp rtx5tcp.BinaryOrderFastResp
					if derr := rtx5tcp.DecodeBinaryOrderFastReqInto(payload, &req); derr != nil {
						resp = rtx5tcp.BinaryOrderFastResp{
							Status:    rtx5tcp.BinaryOrderStatusBadRequest,
							ErrorCode: "BAD_FRAME",
							Message:   derr.Error(),
						}
					} else if req.AuthToken == "" {
						resp = rtx5tcp.BinaryOrderFastResp{
							Action:    req.Action,
							Status:    rtx5tcp.BinaryOrderStatusUnauthorized,
							ErrorCode: "NO_GW_TOKEN",
							Message:   "gateway missing auth token",
						}
					} else {
						h.lastTokenMu.Lock()
						h.lastToken = req.AuthToken
						h.lastTokenMu.Unlock()

						ticket := req.Ticket
						if ticket <= 0 {
							ticket = 500000 + int64(reqID)
						}
						resp = rtx5tcp.BinaryOrderFastResp{
							Action:         req.Action,
							Status:         rtx5tcp.BinaryOrderStatusOK,
							ExecMicros:     15,
							OrderTicket:    ticket,
							PositionTicket: ticket,
							DealTicket:     ticket + 200000,
							FillPrice:      3989.84,
							Volume:         req.Volume,
							SL:             req.SL,
							TP:             req.TP,
							Symbol:         req.Symbol,
							ClientOrderID:  req.ClientOrderID,
						}
					}
					writeBuf = writeBuf[:rtx5tcp.RTOFrameHeaderSize]
					writeBuf[0] = 'R'
					writeBuf[1] = 'T'
					writeBuf[2] = 'O'
					writeBuf[3] = rtx5tcp.RTOOpBinaryOrder
					binary.LittleEndian.PutUint32(writeBuf[4:8], reqID)
					writeBuf = rtx5tcp.AppendBinaryOrderFastResp(writeBuf, resp)
					binary.LittleEndian.PutUint32(writeBuf[8:12], uint32(len(writeBuf)-rtx5tcp.RTOFrameHeaderSize))
					if _, werr := c.Write(writeBuf); werr != nil {
						return
					}
				}
			}(conn)
		}
	}()

	rtx5tcp.SetDefaultBinaryOrderGatewayAddr(gwLn.Addr().String())
	rtx5tcp.PrewarmBinaryOrderGatewayPool()

	// 2. Mock Broker TCP Access Server (:4443 equivalent) supporting RoleTraderTerminalClient & RoleTraderOrderFastLane
	brokerLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = gwLn.Close()
		tb.Fatal(err)
	}
	go func() {
		for {
			raw, aerr := brokerLn.Accept()
			if aerr != nil {
				return
			}
			go func(c net.Conn) {
				tc, herr := rtx5tcp.AcceptTunnel(c, 5*time.Second)
				if herr != nil {
					_ = c.Close()
					return
				}
				sess := rtx5tcp.NewMuxSession(tc, true, nil, nil)
				sess.SetBinaryOrderGate(func() (bool, string) { return true, "" })
				_ = sess.ServeLoop()
			}(raw)
		}
	}()

	// 3. Ephemeral TCP_NODELAY loopback listeners for DesktopClient (primary + fastOrderPort)
	rawLocalLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = brokerLn.Close()
		_ = gwLn.Close()
		tb.Fatal(err)
	}
	localPort := rawLocalLn.Addr().(*net.TCPAddr).Port
	localLn := tcpNoDelayListener{Listener: rawLocalLn}

	rawFastLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = localLn.Close()
		_ = brokerLn.Close()
		_ = gwLn.Close()
		tb.Fatal(err)
	}
	fastPort := rawFastLn.Addr().(*net.TCPAddr).Port
	fastLn := tcpNoDelayListener{Listener: rawFastLn}

	dc := &DesktopClient{
		cfg: AppConfig{
			Kind:     KindTerminal,
			PeerRole: rtx5tcp.RoleTraderTerminalClient,
		},
		localOrigin:      fmt.Sprintf("http://127.0.0.1:%d", localPort),
		localHost:        "127.0.0.1",
		localPort:        localPort,
		fastOrderOrigin:  fmt.Sprintf("http://127.0.0.1:%d", fastPort),
		fastOrderPort:    fastPort,
		targetTCPAddr:    brokerLn.Addr().String(),
		activeBrokerID:   "fxtrust-tcp",
		activeBrokerName: "FXTrust-TCP-Live",
		binHub:           newClientBinaryMarketHub(),
	}

	// Pre-warm both tunnels concurrently just like startup
	_, _ = dc.getOrDialSession()
	_, _ = dc.getOrDialOrderSession()

	localSrv := &http.Server{Handler: http.HandlerFunc(dc.serveHTTP)}
	fastSrv := &http.Server{Handler: http.HandlerFunc(dc.serveFastOrderHTTP)}
	go func() { _ = localSrv.Serve(localLn) }()
	go func() { _ = fastSrv.Serve(fastLn) }()

	h.client = dc
	h.localURL = dc.localOrigin
	h.fastOrderURL = dc.fastOrderOrigin + "/__rtx5_binary_order"
	h.fastWSURL = dc.getFastOrderWSURL()
	h.cleanup = func() {
		_ = fastSrv.Close()
		_ = localSrv.Close()
		if dc.orderMux != nil {
			_ = dc.orderMux.Close()
		}
		if dc.activeMux != nil {
			_ = dc.activeMux.Close()
		}
		_ = brokerLn.Close()
		_ = gwLn.Close()
		rtx5tcp.SetDefaultBinaryOrderGatewayAddr(prevGW)
	}
	return h
}

func buildWSModeAFrame(reqID uint32, req rtx5tcp.BinaryOrderFastReq) []byte {
	req.AuthToken = ""
	enc := rtx5tcp.EncodeBinaryOrderFastReq(req) // 130 bytes (128B header + u16(0))
	frame := make([]byte, 132)
	binary.LittleEndian.PutUint32(frame[0:4], reqID)
	copy(frame[4:132], enc[:128])
	return frame
}

func buildWSModeBFrame(reqID uint32, req rtx5tcp.BinaryOrderFastReq) []byte {
	enc := rtx5tcp.EncodeBinaryOrderFastReq(req) // 128B header + u16 tokenLen + token
	frame := make([]byte, 4+len(enc))
	binary.LittleEndian.PutUint32(frame[0:4], reqID)
	copy(frame[4:], enc)
	return frame
}

func buildWSTokenSyncFrame(token string) []byte {
	frame := make([]byte, 6+len(token))
	binary.LittleEndian.PutUint32(frame[0:4], 0) // reqId = 0
	binary.LittleEndian.PutUint16(frame[4:6], uint16(len(token)))
	copy(frame[6:], token)
	return frame
}

func decodeWSOrderResponse(tb testing.TB, msg []byte) (uint32, rtx5tcp.BinaryOrderFastResp) {
	tb.Helper()
	if len(msg) < 144 {
		tb.Fatalf("expected WS binary response >= 144 bytes, got %d", len(msg))
	}
	reqID := binary.LittleEndian.Uint32(msg[0:4])
	resp, err := rtx5tcp.DecodeBinaryOrderFastResp(msg[4:])
	if err != nil {
		tb.Fatalf("DecodeBinaryOrderFastResp failed: %v", err)
	}
	return reqID, resp
}

func TestPersistentBinaryOrderWSProtocol(t *testing.T) {
	h := startWSOrderTestHarness(t)
	defer h.cleanup()

	// 1. Verify /runtime-config.js exposes BINARY_ORDER_URL and BINARY_ORDER_WS_URL
	rcResp, err := http.Get(h.localURL + "/runtime-config.js")
	if err != nil {
		t.Fatalf("GET /runtime-config.js failed: %v", err)
	}
	rcBody, _ := io.ReadAll(rcResp.Body)
	_ = rcResp.Body.Close()
	if !strings.Contains(string(rcBody), `"BINARY_ORDER_URL":"`+h.fastOrderURL+`"`) {
		t.Fatalf("missing BINARY_ORDER_URL in runtime-config.js: %s", string(rcBody))
	}
	if !strings.Contains(string(rcBody), `"BINARY_ORDER_WS_URL":"`+h.fastWSURL+`"`) {
		t.Fatalf("missing BINARY_ORDER_WS_URL in runtime-config.js: %s", string(rcBody))
	}

	// 2. Verify Loopback Origin Security rejects external web origins & domain-spoofing prefixes
	for _, badOrigin := range []string{"https://evil.example.com", "http://127.0.0.1.evil.com:8080", "null"} {
		hdr := http.Header{"Origin": []string{badOrigin}}
		badConn, badHTTPResp, derr := websocket.DefaultDialer.Dial(h.fastWSURL, hdr)
		if derr == nil {
			_ = badConn.Close()
			t.Fatalf("expected external origin %q to be rejected", badOrigin)
		}
		if badHTTPResp != nil {
			_ = badHTTPResp.Body.Close()
		}
	}

	// 3. Connect persistent Binary WebSocket from trusted loopback Origin
	dialer := websocket.Dialer{
		ReadBufferSize:  16 * 1024,
		WriteBufferSize: 16 * 1024,
	}
	wsConn, _, err := dialer.Dial(h.fastWSURL, http.Header{"Origin": []string{h.localURL}})
	if err != nil {
		t.Fatalf("WS dial failed: %v", err)
	}
	defer wsConn.Close()

	baseReq := rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionPlaceMarket,
		Side:          rtx5tcp.BinaryOrderSideBuy,
		AccountLogin:  200074,
		Ticket:        600101,
		Volume:        0.50,
		Symbol:        rtx5tcp.PackBinarySymbol("xauusd"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("ws-click-001"),
	}

	// 4. Test 401 AUTH_TOKEN_REQUIRED self-heal when sending 132B Mode A before token is cached
	modeA1 := buildWSModeAFrame(1, baseReq)
	if len(modeA1) != 132 {
		t.Fatalf("expected 132-byte Mode A frame, got %d", len(modeA1))
	}
	if err := wsConn.WriteMessage(websocket.BinaryMessage, modeA1); err != nil {
		t.Fatal(err)
	}
	_, rawMsg1, err := wsConn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	gotID1, resp1 := decodeWSOrderResponse(t, rawMsg1)
	if gotID1 != 1 || resp1.Status != 401 || resp1.Action != rtx5tcp.BinaryOrderActionPlaceMarket || resp1.ErrorCode != "AUTH_TOKEN_REQUIRED" {
		t.Fatalf("expected reqId=1 401 AUTH_TOKEN_REQUIRED, got reqId=%d resp=%+v", gotID1, resp1)
	}

	// 5. Retry with Mode B (134 + tokenLen inline token) -> should succeed AND cache token
	modeBReq := baseReq
	modeBReq.AuthToken = "jwt-inline-self-heal-token"
	modeB2 := buildWSModeBFrame(2, modeBReq)
	if err := wsConn.WriteMessage(websocket.BinaryMessage, modeB2); err != nil {
		t.Fatal(err)
	}
	_, rawMsg2, err := wsConn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	gotID2, resp2 := decodeWSOrderResponse(t, rawMsg2)
	if gotID2 != 2 || resp2.Status != 200 || resp2.OrderTicket != 600101 || resp2.SymbolString() != "XAUUSD" {
		t.Fatalf("Mode B order failed: reqId=%d resp=%+v", gotID2, resp2)
	}

	// 6. Subsequent 132-byte Mode A tokenless click must now succeed immediately using cached token!
	req3 := baseReq
	req3.Ticket = 600103
	if err := wsConn.WriteMessage(websocket.BinaryMessage, buildWSModeAFrame(3, req3)); err != nil {
		t.Fatal(err)
	}
	_, rawMsg3, err := wsConn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	gotID3, resp3 := decodeWSOrderResponse(t, rawMsg3)
	if gotID3 != 3 || resp3.Status != 200 || resp3.OrderTicket != 600103 {
		t.Fatalf("Mode A cached-token order failed: reqId=%d resp=%+v", gotID3, resp3)
	}

	// 7. Test reqId=0 Auth Token Sync Control Frame (must NOT emit a WS response, and must update token)
	if err := wsConn.WriteMessage(websocket.BinaryMessage, buildWSTokenSyncFrame("jwt-rotated-via-req0")); err != nil {
		t.Fatal(err)
	}
	req4 := baseReq
	req4.Ticket = 600104
	if err := wsConn.WriteMessage(websocket.BinaryMessage, buildWSModeAFrame(4, req4)); err != nil {
		t.Fatal(err)
	}
	_, rawMsg4, err := wsConn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	gotID4, resp4 := decodeWSOrderResponse(t, rawMsg4)
	if gotID4 != 4 || resp4.Status != 200 || resp4.OrderTicket != 600104 {
		t.Fatalf("expected reqId=4 immediately (no response for reqId=0), got reqId=%d resp=%+v", gotID4, resp4)
	}
	h.lastTokenMu.Lock()
	observedTok := h.lastToken
	h.lastTokenMu.Unlock()
	if observedTok != "jwt-rotated-via-req0" {
		t.Fatalf("expected gateway to receive rotated token %q, got %q", "jwt-rotated-via-req0", observedTok)
	}

	// 8. Test concurrent pipelined burst of 32 rapid 132-byte Mode A clicks without waiting
	const burst = 32
	for i := 0; i < burst; i++ {
		r := baseReq
		r.Ticket = int64(700000 + i)
		r.SetClientOrderID(fmt.Sprintf("pipe-%02d", i))
		if err := wsConn.WriteMessage(websocket.BinaryMessage, buildWSModeAFrame(uint32(100+i), r)); err != nil {
			t.Fatal(err)
		}
	}
	seen := make(map[uint32]bool, burst)
	for i := 0; i < burst; i++ {
		_, msg, rerr := wsConn.ReadMessage()
		if rerr != nil {
			t.Fatalf("burst read %d failed: %v", i, rerr)
		}
		rid, rresp := decodeWSOrderResponse(t, msg)
		if rid < 100 || rid >= 100+burst {
			t.Fatalf("unexpected burst reqId %d", rid)
		}
		idx := int(rid - 100)
		if rresp.Status != 200 || rresp.OrderTicket != int64(700000+idx) || rresp.ClientOrderIDString() != fmt.Sprintf("pipe-%02d", idx) {
			t.Fatalf("mismatched pipelined response for reqId=%d: %+v", rid, rresp)
		}
		seen[rid] = true
	}
	if len(seen) != burst {
		t.Fatalf("expected %d unique pipelined responses, got %d", burst, len(seen))
	}

	// 9. Test reqId=0 token clear (tokenLen=0) -> next 132B Mode A returns 401 AUTH_TOKEN_REQUIRED
	if err := wsConn.WriteMessage(websocket.BinaryMessage, buildWSTokenSyncFrame("")); err != nil {
		t.Fatal(err)
	}
	if err := wsConn.WriteMessage(websocket.BinaryMessage, buildWSModeAFrame(200, baseReq)); err != nil {
		t.Fatal(err)
	}
	_, rawMsgClear, err := wsConn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	gotIDClear, respClear := decodeWSOrderResponse(t, rawMsgClear)
	if gotIDClear != 200 || respClear.Status != 401 || respClear.ErrorCode != "AUTH_TOKEN_REQUIRED" {
		t.Fatalf("expected 401 after token clear, got reqId=%d resp=%+v", gotIDClear, respClear)
	}

	// 10. Test POST /__rtx5_binary_account_sub pre-caches AuthToken for a brand-new WS connection + primary port WS route
	subBytes := rtx5tcp.EncodeBinaryAccountSub(rtx5tcp.BinaryAccountSub{
		AccountLogin: 200074,
		AuthToken:    "jwt-from-account-sub",
	})
	subResp, err := http.Post(h.client.fastOrderOrigin+"/__rtx5_binary_account_sub", "application/octet-stream", bytes.NewReader(subBytes))
	if err != nil {
		t.Fatal(err)
	}
	_ = subResp.Body.Close()
	if subResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 from /__rtx5_binary_account_sub, got %d", subResp.StatusCode)
	}

	primaryWSURL := strings.Replace(h.localURL, "http://", "ws://", 1) + "/__rtx5_binary_order_ws"
	wsConn2, _, err := dialer.Dial(primaryWSURL, nil) // empty Origin allowed
	if err != nil {
		t.Fatalf("primary port WS dial failed: %v", err)
	}
	defer wsConn2.Close()

	reqSub := baseReq
	reqSub.Ticket = 800001
	if err := wsConn2.WriteMessage(websocket.BinaryMessage, buildWSModeAFrame(1, reqSub)); err != nil {
		t.Fatal(err)
	}
	_, rawMsgSub, err := wsConn2.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	gotIDSub, respSub := decodeWSOrderResponse(t, rawMsgSub)
	if gotIDSub != 1 || respSub.Status != 200 || respSub.OrderTicket != 800001 {
		t.Fatalf("expected 1st click on new WS to succeed via account_sub pre-cached token, got reqId=%d resp=%+v", gotIDSub, respSub)
	}

	// 11. Verify POST /__rtx5_binary_order HTTP fallback remains 100% functional
	httpReq := baseReq
	httpReq.Ticket = 900001
	httpReq.AuthToken = "jwt-http-fallback"
	httpResp, err := http.Post(h.fastOrderURL, "application/octet-stream", bytes.NewReader(rtx5tcp.EncodeBinaryOrderFastReq(httpReq)))
	if err != nil {
		t.Fatalf("HTTP fallback POST failed: %v", err)
	}
	httpBody, _ := io.ReadAll(httpResp.Body)
	_ = httpResp.Body.Close()
	decHTTP, err := rtx5tcp.DecodeBinaryOrderFastResp(httpBody)
	if err != nil || decHTTP.Status != 200 || decHTTP.OrderTicket != 900001 {
		t.Fatalf("HTTP fallback unexpected response: err=%v resp=%+v", err, decHTTP)
	}
}

func BenchmarkPersistentBinaryOrderWSModeA(b *testing.B) {
	h := startWSOrderTestHarness(b)
	defer h.cleanup()

	dialer := websocket.Dialer{
		ReadBufferSize:  16 * 1024,
		WriteBufferSize: 16 * 1024,
	}
	wsConn, _, err := dialer.Dial(h.fastWSURL, nil)
	if err != nil {
		b.Fatal(err)
	}
	defer wsConn.Close()
	if tc, ok := wsConn.UnderlyingConn().(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}

	// Bind auth token once via reqId=0
	if err := wsConn.WriteMessage(websocket.BinaryMessage, buildWSTokenSyncFrame("jwt-bench-persistent-ws-token")); err != nil {
		b.Fatal(err)
	}

	frame := buildWSModeAFrame(1, rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionPlaceMarket,
		Side:          rtx5tcp.BinaryOrderSideBuy,
		AccountLogin:  200074,
		Ticket:        777001,
		Volume:        0.10,
		Symbol:        rtx5tcp.PackBinarySymbol("EURUSD"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("bench-ws-mode-a"),
	})

	// Warmup
	for i := 0; i < 16; i++ {
		binary.LittleEndian.PutUint32(frame[0:4], uint32(i+1))
		if err := wsConn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			b.Fatal(err)
		}
		if _, _, err := wsConn.ReadMessage(); err != nil {
			b.Fatal(err)
		}
	}

	b.ReportAllocs()
	b.ResetTimer()
	start := time.Now()
	for i := 0; i < b.N; i++ {
		reqID := uint32(i + 1)
		binary.LittleEndian.PutUint32(frame[0:4], reqID)
		if err := wsConn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			b.Fatal(err)
		}
		_, resp, rerr := wsConn.ReadMessage()
		if rerr != nil || len(resp) < 144 {
			b.Fatalf("iter %d failed: err=%v len=%d", i, rerr, len(resp))
		}
	}
	elapsed := time.Since(start)
	b.ReportMetric(float64(elapsed.Microseconds())/float64(b.N), "us/order")
}

func BenchmarkHTTPBinaryOrderFallback(b *testing.B) {
	h := startWSOrderTestHarness(b)
	defer h.cleanup()

	tr := &http.Transport{
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 64,
		DisableCompression:  true,
	}
	client := &http.Client{Transport: tr, Timeout: 5 * time.Second}
	defer tr.CloseIdleConnections()

	rawPayload := rtx5tcp.EncodeBinaryOrderFastReq(rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionPlaceMarket,
		Side:          rtx5tcp.BinaryOrderSideBuy,
		AccountLogin:  200074,
		Ticket:        777002,
		Volume:        0.10,
		Symbol:        rtx5tcp.PackBinarySymbol("EURUSD"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("bench-http-fallback"),
		AuthToken:     "jwt-bench-http-fallback-token",
	})

	for i := 0; i < 8; i++ {
		resp, err := client.Post(h.fastOrderURL, "application/octet-stream", bytes.NewReader(rawPayload))
		if err != nil {
			b.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}

	b.ReportAllocs()
	b.ResetTimer()
	start := time.Now()
	for i := 0; i < b.N; i++ {
		resp, err := client.Post(h.fastOrderURL, "application/octet-stream", bytes.NewReader(rawPayload))
		if err != nil {
			b.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
	elapsed := time.Since(start)
	b.ReportMetric(float64(elapsed.Microseconds())/float64(b.N), "us/order")
}

func TestIsLoopbackOrderOriginEdgeCases(t *testing.T) {
	if isLoopbackOrderOrigin(nil) {
		t.Fatal("expected nil request to be rejected")
	}

	allowed := []string{
		"",
		"   ",
		"http://127.0.0.1",
		"http://127.0.0.1:1",
		"http://127.0.0.1:18403",
		"http://127.0.0.1:65535",
		"http://localhost",
		"http://localhost:5173",
		"http://LOCALHOST:8080",
	}
	for _, orig := range allowed {
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18403/__rtx5_binary_order_ws", nil)
		if orig != "" {
			req.Header.Set("Origin", orig)
		}
		if !isLoopbackOrderOrigin(req) {
			t.Fatalf("expected loopback Origin %q to be allowed", orig)
		}
	}

	rejected := []string{
		"https://127.0.0.1:18403",
		"https://localhost:5173",
		"ws://127.0.0.1:18403",
		"file://",
		"file://localhost",
		"http://user:pass@127.0.0.1:18403",
		"http://user@localhost:5173",
		"http://127.0.0.1:0",
		"http://127.0.0.1:65536",
		"http://127.0.0.1:abc",
		"http://[::1]:5173",
		"http://sub.localhost:5173",
		"http://127.0.0.1.evil.com:8080",
		"https://evil.example.com",
		"null",
		"://bad-url",
	}
	for _, orig := range rejected {
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18403/__rtx5_binary_order_ws", nil)
		req.Header.Set("Origin", orig)
		if isLoopbackOrderOrigin(req) {
			t.Fatalf("expected Origin %q to be rejected", orig)
		}
	}

	// Verify websocket.Upgrader enforcement rejects disallowed loopback variants over HTTP upgrade.
	h := startWSOrderTestHarness(t)
	defer h.cleanup()
	for _, badOrigin := range []string{"https://127.0.0.1:18403", "http://user:pass@localhost:5173", "http://[::1]:5173"} {
		conn, resp, err := websocket.DefaultDialer.Dial(h.fastWSURL, http.Header{"Origin": []string{badOrigin}})
		if err == nil {
			_ = conn.Close()
			t.Fatalf("expected WS upgrade for %q to fail", badOrigin)
		}
		if resp != nil {
			_ = resp.Body.Close()
		}
	}
}
