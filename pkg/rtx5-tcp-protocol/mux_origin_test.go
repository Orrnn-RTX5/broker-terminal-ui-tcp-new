package rtx5tcp

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func startMuxOriginTestPair(t *testing.T, resolver TargetResolver) (clientSess *MuxSession, cleanup func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var (
		mu         sync.Mutex
		serverSess *MuxSession
	)
	go func() {
		raw, aerr := ln.Accept()
		if aerr != nil {
			return
		}
		tc, terr := AcceptTunnel(raw, 5*time.Second)
		if terr != nil {
			_ = raw.Close()
			return
		}
		sess := NewMuxSession(tc, true, resolver, nil)
		mu.Lock()
		serverSess = sess
		mu.Unlock()
		_ = sess.ServeLoop()
	}()

	clientTC, err := DialTunnel(ln.Addr().String(), RoleTraderTerminalClient, 5*time.Second)
	if err != nil {
		_ = ln.Close()
		t.Fatalf("DialTunnel: %v", err)
	}
	clientSess = NewMuxSession(clientTC, false, nil, nil)
	go func() {
		_ = clientSess.ServeLoop()
	}()

	return clientSess, func() {
		_ = clientSess.Close()
		mu.Lock()
		ss := serverSess
		mu.Unlock()
		if ss != nil {
			_ = ss.Close()
		}
		_ = ln.Close()
	}
}

func TestMuxSession_HandleInboundRPCOriginSanitization(t *testing.T) {
	type capturedReq struct {
		host       string
		origin     string
		xRealIP    string
		auth       string
		brokerID   string
		proxyAuth  string
		connection string
	}
	gotCh := make(chan capturedReq, 4)

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCh <- capturedReq{
			host:       r.Host,
			origin:     r.Header.Get("Origin"),
			xRealIP:    r.Header.Get("X-Real-IP"),
			auth:       r.Header.Get("Authorization"),
			brokerID:   r.Header.Get("X-Broker-ID"),
			proxyAuth:  r.Header.Get("Proxy-Authorization"),
			connection: r.Header.Get("Connection"),
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer backend.Close()

	t.Run("strips spoofed Host and Origin and injects trustedOrigin", func(t *testing.T) {
		sess, cleanup := startMuxOriginTestPair(t, func(svc, _ string) (string, string, error) {
			return backend.URL, "http://127.0.0.1:18403", nil
		})
		defer cleanup()

		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18403/api/v2/instruments", nil)
		req.Header.Set("Origin", "file://")
		req.Header.Set("Host", "evil.example")
		req.Header.Set("Proxy-Authorization", "Basic secret")
		req.Header.Set("Authorization", "Bearer rpc-jwt-1")
		req.Header.Set("X-Broker-ID", "ind-broker")
		rec := httptest.NewRecorder()

		sess.ProxyHTTP(rec, req, "gateway")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}

		got := <-gotCh
		if got.origin != "http://127.0.0.1:18403" {
			t.Fatalf("backend Origin = %q, want http://127.0.0.1:18403", got.origin)
		}
		if got.host == "evil.example" || got.host == "" {
			t.Fatalf("backend Host = %q, must be backend target host", got.host)
		}
		if got.proxyAuth != "" {
			t.Fatalf("hop-by-hop Proxy-Authorization leaked: %q", got.proxyAuth)
		}
		if got.auth != "Bearer rpc-jwt-1" || got.brokerID != "ind-broker" {
			t.Fatalf("forwarded headers mismatch: auth=%q broker=%q", got.auth, got.brokerID)
		}
		if got.xRealIP != "127.0.0.1" {
			t.Fatalf("X-Real-IP = %q, want 127.0.0.1", got.xRealIP)
		}
	})

	t.Run("strips caller Origin even when trustedOrigin is empty", func(t *testing.T) {
		sess, cleanup := startMuxOriginTestPair(t, func(svc, _ string) (string, string, error) {
			return backend.URL, "", nil
		})
		defer cleanup()

		status, _, _, err := sess.RoundTripRPC("gateway", http.MethodGet, "/api/v2/instruments", map[string][]string{
			"Origin":        {"file://"},
			"Host":          {"spoofed.example"},
			"Authorization": {"Bearer rpc-jwt-2"},
		}, nil, 5*time.Second)
		if err != nil || status != http.StatusOK {
			t.Fatalf("RoundTripRPC failed: status=%d err=%v", status, err)
		}

		got := <-gotCh
		if got.origin != "" {
			t.Fatalf("backend Origin = %q, want empty when trustedOrigin is empty", got.origin)
		}
		if got.host == "spoofed.example" {
			t.Fatalf("spoofed Host leaked to backend")
		}
	})
}

func TestMuxSession_ProxyWebSocketClientHeaderAllowlisting(t *testing.T) {
	type capturedWS struct {
		origin     string
		auth       string
		cookie     string
		userAgent  string
		brokerID   string
		acctLogin  string
		evilHeader string
		subproto   string
	}
	wsCh := make(chan capturedWS, 4)

	upgrader := websocket.Upgrader{
		CheckOrigin:  func(r *http.Request) bool { return true },
		Subprotocols: []string{"json"},
	}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		wsCh <- capturedWS{
			origin:     r.Header.Get("Origin"),
			auth:       r.Header.Get("Authorization"),
			cookie:     r.Header.Get("Cookie"),
			userAgent:  r.Header.Get("User-Agent"),
			brokerID:   r.Header.Get("X-Broker-ID"),
			acctLogin:  r.Header.Get("X-Account-Login"),
			evilHeader: r.Header.Get("X-Evil-Header"),
			subproto:   c.Subprotocol(),
		}
		mt, msg, rerr := c.ReadMessage()
		if rerr == nil {
			_ = c.WriteMessage(mt, append([]byte("ack:"), msg...))
		}
	}))
	defer backend.Close()

	runWSCase := func(t *testing.T, sendSameHostOrigin bool, trustedOrigin string) {
		t.Helper()
		sess, cleanup := startMuxOriginTestPair(t, func(svc, _ string) (string, string, error) {
			return backend.URL, trustedOrigin, nil
		})
		defer cleanup()

		proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sess.proxyWebSocketClient(w, r, "bridge")
		}))
		defer proxySrv.Close()

		wsURL := "ws" + strings.TrimPrefix(proxySrv.URL, "http") + "/ws/feed"
		hdr := http.Header{
			"Authorization":          {"Bearer ws-jwt"},
			"Cookie":                 {"sid=test-cookie"},
			"User-Agent":             {"rtx5-test-client"},
			"X-Broker-ID":            {"ind-broker"},
			"X-Account-Login":        {"200074"},
			"X-Evil-Header":          {"must-not-forward"},
			"Sec-WebSocket-Protocol": {"json"},
		}
		if sendSameHostOrigin {
			hdr.Set("Origin", proxySrv.URL)
		}
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
		if err != nil {
			t.Fatalf("WS dial failed: %v", err)
		}
		defer conn.Close()

		if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
			t.Fatalf("WS write failed: %v", err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, reply, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("WS read failed: %v", err)
		}
		if string(reply) != "ack:ping" {
			t.Fatalf("WS reply = %q, want ack:ping", string(reply))
		}

		got := <-wsCh
		if got.origin != trustedOrigin {
			t.Fatalf("backend WS Origin = %q, want %q", got.origin, trustedOrigin)
		}
		if got.auth != "Bearer ws-jwt" || got.cookie != "sid=test-cookie" ||
			got.userAgent != "rtx5-test-client" || got.brokerID != "ind-broker" ||
			got.acctLogin != "200074" {
			t.Fatalf("allowlisted WS headers mismatch: %+v", got)
		}
		if got.evilHeader != "" {
			t.Fatalf("non-allowlisted header leaked across proxyWebSocketClient: %q", got.evilHeader)
		}
		if got.subproto != "json" {
			t.Fatalf("negotiated subprotocol = %q, want json", got.subproto)
		}
	}

	t.Run("same-host Origin is replaced by trustedOrigin and only allowlisted headers forward", func(t *testing.T) {
		runWSCase(t, true, "http://127.0.0.1:18403")
	})

	t.Run("same-host Origin is stripped when trustedOrigin is empty", func(t *testing.T) {
		runWSCase(t, true, "")
	})

	t.Run("absent Origin receives trustedOrigin and only allowlisted headers forward", func(t *testing.T) {
		runWSCase(t, false, "http://127.0.0.1:18403")
	})
}

func TestMuxSession_HandleInboundWSOpenHeaderHandling(t *testing.T) {
	type capturedRawWS struct {
		origin    string
		auth      string
		brokerID  string
		acctLogin string
		subproto  string
	}
	wsCh := make(chan capturedRawWS, 4)

	upgrader := websocket.Upgrader{
		CheckOrigin:  func(r *http.Request) bool { return true },
		Subprotocols: []string{"json"},
	}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		wsCh <- capturedRawWS{
			origin:    r.Header.Get("Origin"),
			auth:      r.Header.Get("Authorization"),
			brokerID:  r.Header.Get("X-Broker-ID"),
			acctLogin: r.Header.Get("X-Account-Login"),
			subproto:  c.Subprotocol(),
		}
		_, _, _ = c.ReadMessage()
	}))
	defer backend.Close()

	sendRawWSOpen := func(t *testing.T, sess *MuxSession, payload []byte) WSOpenAckMeta {
		t.Helper()
		sid := sess.allocStreamID()
		wsStream := &wsTunnelStream{
			id:     sid,
			ackCh:  make(chan WSOpenAckMeta, 1),
			msgCh:  make(chan wsFrameMsg, 8),
			doneCh: make(chan struct{}),
		}
		sess.wsMu.Lock()
		sess.wsStreams[sid] = wsStream
		sess.wsMu.Unlock()
		defer func() {
			sess.wsMu.Lock()
			delete(sess.wsStreams, sid)
			sess.wsMu.Unlock()
			wsStream.closeLocal()
			_ = sess.tunnel.WriteMuxFrame(FrameWSClose, sid, FlagFIN, nil)
		}()

		if err := sess.tunnel.WriteMuxFrame(FrameWSOpen, sid, FlagNone, payload); err != nil {
			t.Fatalf("WriteMuxFrame(FrameWSOpen): %v", err)
		}
		select {
		case ack := <-wsStream.ackCh:
			return ack
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for FrameWSOpenAck")
			return WSOpenAckMeta{}
		}
	}

	t.Run("trustedOrigin overrides Origin present in raw FrameWSOpen", func(t *testing.T) {
		sess, cleanup := startMuxOriginTestPair(t, func(svc, _ string) (string, string, error) {
			return backend.URL, "http://127.0.0.1:18403", nil
		})
		defer cleanup()

		openBytes, err := json.Marshal(WSOpenMeta{
			TargetService: "bridge",
			PathWithQuery: "/ws/feed",
			Headers: map[string][]string{
				"Origin":          {"https://spoofed.example"},
				"Authorization":   {"Bearer raw-ws-jwt-1"},
				"X-Broker-ID":     {"ind-broker"},
				"X-Account-Login": {"200074"},
			},
			Subprotocols: []string{"json"},
		})
		if err != nil {
			t.Fatal(err)
		}

		ack := sendRawWSOpen(t, sess, openBytes)
		if !ack.Accepted || ack.Subprotocol != "json" {
			t.Fatalf("unexpected WSOpenAck: %+v", ack)
		}

		got := <-wsCh
		if got.origin != "http://127.0.0.1:18403" {
			t.Fatalf("backend Origin = %q, want http://127.0.0.1:18403", got.origin)
		}
		if got.auth != "Bearer raw-ws-jwt-1" || got.brokerID != "ind-broker" || got.acctLogin != "200074" {
			t.Fatalf("forwarded WSOpenMeta headers mismatch: %+v", got)
		}
		if got.subproto != "json" {
			t.Fatalf("subprotocol = %q, want json", got.subproto)
		}
	})

	t.Run("trustedOrigin empty with absent Origin leaves backend Origin empty", func(t *testing.T) {
		sess, cleanup := startMuxOriginTestPair(t, func(svc, _ string) (string, string, error) {
			return backend.URL, "", nil
		})
		defer cleanup()

		openBytes, err := json.Marshal(WSOpenMeta{
			TargetService: "bridge",
			PathWithQuery: "/ws/feed",
			Headers: map[string][]string{
				"Authorization": {"Bearer raw-ws-jwt-2"},
				"X-Broker-ID":   {"ind-broker"},
			},
			Subprotocols: []string{"json"},
		})
		if err != nil {
			t.Fatal(err)
		}

		ack := sendRawWSOpen(t, sess, openBytes)
		if !ack.Accepted || ack.Subprotocol != "json" {
			t.Fatalf("unexpected WSOpenAck: %+v", ack)
		}

		got := <-wsCh
		if got.origin != "" {
			t.Fatalf("backend Origin = %q, want empty when trustedOrigin is empty", got.origin)
		}
		if got.auth != "Bearer raw-ws-jwt-2" || got.brokerID != "ind-broker" {
			t.Fatalf("forwarded WSOpenMeta headers mismatch: %+v", got)
		}
	})

	t.Run("rejects malformed WSOpen metadata and resolver errors", func(t *testing.T) {
		sess, cleanup := startMuxOriginTestPair(t, func(svc, _ string) (string, string, error) {
			return "", "", http.ErrNotSupported
		})
		defer cleanup()

		badAck := sendRawWSOpen(t, sess, []byte("{malformed"))
		if badAck.Accepted || badAck.StatusCode != http.StatusBadRequest {
			t.Fatalf("malformed WSOpenAck = %+v, want rejected 400", badAck)
		}

		openBytes, _ := json.Marshal(WSOpenMeta{
			TargetService: "bridge",
			PathWithQuery: "/ws/feed",
		})
		resolverAck := sendRawWSOpen(t, sess, openBytes)
		if resolverAck.Accepted || resolverAck.StatusCode != http.StatusBadGateway {
			t.Fatalf("resolver error WSOpenAck = %+v, want rejected 502", resolverAck)
		}
	})
}
