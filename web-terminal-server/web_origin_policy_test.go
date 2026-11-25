package main

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func applyTestOriginPolicy(tb testing.TB, allowedRaw, publicRaw string) []string {
	tb.Helper()
	restore, invalid, _ := setWebOriginPolicyForTest(allowedRaw, publicRaw)
	tb.Cleanup(restore)
	return invalid
}

func newOriginTestRequest(host, xfh, origin string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "https://placeholder.local/__rtx5_binary_order_ws", nil)
	req.Host = host
	if xfh != "" {
		req.Header.Set("X-Forwarded-Host", xfh)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return req
}

func TestIsAllowedWebTerminalOrigin_DerivedAndValidation(t *testing.T) {
	applyTestOriginPolicy(t, "", "")

	tests := []struct {
		name   string
		host   string
		xfh    string
		origin string
		want   bool
	}{
		// Brand-A (webterminal.orrnn.com) derived parent -> orrnn.com
		{name: "orrnn-like same host", host: "webterminal.orrnn.com", origin: "https://webterminal.orrnn.com", want: true},
		{name: "orrnn-like sibling subdomain", host: "webterminal.orrnn.com", origin: "https://admin.orrnn.com", want: true},
		{name: "orrnn-like apex", host: "webterminal.orrnn.com", origin: "https://orrnn.com", want: true},
		{name: "orrnn-like nested subdomain", host: "webterminal.orrnn.com", origin: "https://a.b.orrnn.com", want: true},
		{name: "orrnn-like lookalike prefix", host: "webterminal.orrnn.com", origin: "https://evilorrnn.com", want: false},
		{name: "orrnn-like lookalike suffix", host: "webterminal.orrnn.com", origin: "https://orrnn.com.evil.net", want: false},
		{name: "orrnn-like unrelated", host: "webterminal.orrnn.com", origin: "https://other.com", want: false},

		// Another broker (terminal.brokerx.io) derived parent -> brokerx.io
		{name: "brokerx same host", host: "terminal.brokerx.io", origin: "https://terminal.brokerx.io", want: true},
		{name: "brokerx sibling subdomain", host: "terminal.brokerx.io", origin: "https://admin.brokerx.io", want: true},
		{name: "brokerx apex", host: "terminal.brokerx.io", origin: "https://brokerx.io", want: true},
		{name: "brokerx nested subdomain", host: "terminal.brokerx.io", origin: "https://a.b.brokerx.io", want: true},
		{name: "brokerx refuses other broker subdomain", host: "terminal.brokerx.io", origin: "https://webterminal.orrnn.com", want: false},
		{name: "brokerx refuses other broker apex", host: "terminal.brokerx.io", origin: "https://orrnn.com", want: false},

		// Apex request host -> exact only
		{name: "apex host allows exact", host: "orrnn.com", origin: "https://orrnn.com", want: true},
		{name: "apex host refuses subdomain", host: "orrnn.com", origin: "https://admin.orrnn.com", want: false},

		// Public-suffix guard (.co.uk, .com.au, etc.)
		{name: "co.uk 2-label host exact allowed", host: "broker.co.uk", origin: "https://broker.co.uk", want: true},
		{name: "co.uk 2-label host subdomain refused", host: "broker.co.uk", origin: "https://admin.broker.co.uk", want: false},
		{name: "co.uk 2-label host sibling refused", host: "broker.co.uk", origin: "https://x.co.uk", want: false},
		{name: "co.uk 3-label host same allowed", host: "terminal.broker.co.uk", origin: "https://terminal.broker.co.uk", want: true},
		{name: "co.uk 3-label host parent allowed", host: "terminal.broker.co.uk", origin: "https://broker.co.uk", want: true},
		{name: "co.uk 3-label host sibling allowed", host: "terminal.broker.co.uk", origin: "https://admin.broker.co.uk", want: true},
		{name: "co.uk 3-label host other co.uk refused", host: "terminal.broker.co.uk", origin: "https://x.co.uk", want: false},
		{name: "co.uk 3-label host co.uk apex refused", host: "terminal.broker.co.uk", origin: "https://co.uk", want: false},
		{name: "com.au 2-label host subdomain refused", host: "broker.com.au", origin: "https://app.broker.com.au", want: false},

		// IPv4 and IPv6 request hosts -> exact only
		{name: "ipv4 exact allowed", host: "203.0.113.5", origin: "https://203.0.113.5", want: true},
		{name: "ipv4 with port exact allowed", host: "203.0.113.5:8443", origin: "https://203.0.113.5:9000", want: true},
		{name: "ipv4 subdomain refused", host: "203.0.113.5", origin: "https://sub.203.0.113.5", want: false},
		{name: "ipv4 parent apex refused", host: "203.0.113.5", origin: "https://0.113.5", want: false},
		{name: "ipv4 parent sibling refused", host: "203.0.113.5", origin: "https://x.0.113.5", want: false},
		{name: "ipv4 other ip refused", host: "203.0.113.5", origin: "https://203.0.113.6", want: false},
		{name: "ipv6 exact allowed", host: "[2001:db8::1]", origin: "https://[2001:db8::1]", want: true},
		{name: "ipv6 with port exact allowed", host: "[2001:db8::1]:8443", origin: "https://[2001:db8::1]:443", want: true},
		{name: "ipv6 other ip refused", host: "[2001:db8::1]", origin: "https://[2001:db8::2]", want: false},

		// Single-label host -> exact only
		{name: "single label exact allowed", host: "intranet", origin: "http://intranet:8080", want: true},
		{name: "single label subdomain refused", host: "intranet", origin: "http://app.intranet", want: false},
		{name: "single label other refused", host: "intranet", origin: "http://other", want: false},

		// X-Forwarded-Host comma list and ports (case-insensitive)
		{name: "xfh comma list and port", host: "internal.local:8443", xfh: "Terminal.BrokerX.io:443, edge.internal:8080", origin: "https://admin.brokerx.io:8443", want: true},
		{name: "xfh overrides host so host refused", host: "internal.local", xfh: "terminal.brokerx.io, edge.internal", origin: "https://internal.local", want: false},

		// Loopback
		{name: "loopback 127.0.0.1", host: "terminal.brokerx.io", origin: "http://127.0.0.1:5173", want: true},
		{name: "loopback localhost", host: "terminal.brokerx.io", origin: "https://localhost:3000", want: true},

		// Empty Origin
		{name: "empty origin allowed with host", host: "terminal.brokerx.io", origin: "", want: true},
		{name: "empty origin allowed without host", host: "", origin: "", want: true},

		// Malformed / disallowed Origin properties
		{name: "bad scheme ws", host: "terminal.brokerx.io", origin: "ws://terminal.brokerx.io", want: false},
		{name: "bad scheme ftp", host: "terminal.brokerx.io", origin: "ftp://terminal.brokerx.io", want: false},
		{name: "bad parse", host: "terminal.brokerx.io", origin: "http://[::1", want: false},
		{name: "empty origin host", host: "terminal.brokerx.io", origin: "https://", want: false},
		{name: "userinfo refused", host: "terminal.brokerx.io", origin: "https://user:pass@terminal.brokerx.io", want: false},
		{name: "userinfo empty pass refused", host: "terminal.brokerx.io", origin: "https://user@terminal.brokerx.io", want: false},
		{name: "bad port zero", host: "terminal.brokerx.io", origin: "https://terminal.brokerx.io:0", want: false},
		{name: "bad port too high", host: "terminal.brokerx.io", origin: "https://terminal.brokerx.io:65536", want: false},
		{name: "bad port on loopback", host: "terminal.brokerx.io", origin: "http://127.0.0.1:65536", want: false},
		{name: "leading dot origin refused", host: "terminal.brokerx.io", origin: "https://.brokerx.io", want: false},

		// Both XFH and Host empty -> fail closed except loopback (or env)
		{name: "empty host and xfh refuses non-loopback", host: "", xfh: "", origin: "https://terminal.brokerx.io", want: false},
		{name: "empty host and xfh allows loopback", host: "", xfh: "", origin: "http://127.0.0.1:5173", want: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := newOriginTestRequest(tc.host, tc.xfh, tc.origin)
			if got := isAllowedWebTerminalOrigin(req); got != tc.want {
				t.Fatalf("isAllowedWebTerminalOrigin(host=%q, xfh=%q, origin=%q) = %v, want %v",
					tc.host, tc.xfh, tc.origin, got, tc.want)
			}
		})
	}

	if isAllowedWebTerminalOrigin(nil) {
		t.Fatal("isAllowedWebTerminalOrigin(nil) = true, want false")
	}
}

func TestIsAllowedWebTerminalOrigin_EnvConfigured(t *testing.T) {
	t.Run("suffix replaces derived rule", func(t *testing.T) {
		applyTestOriginPolicy(t, ".brokerx.io", "")

		cases := []struct {
			host   string
			origin string
			want   bool
		}{
			{host: "webterminal.orrnn.com", origin: "https://admin.orrnn.com", want: false},
			{host: "webterminal.orrnn.com", origin: "https://orrnn.com", want: false},
			{host: "webterminal.orrnn.com", origin: "https://webterminal.orrnn.com", want: true}, // same host stays
			{host: "webterminal.orrnn.com", origin: "https://a.brokerx.io", want: true},
			{host: "webterminal.orrnn.com", origin: "https://brokerx.io", want: true},
			{host: "webterminal.orrnn.com", origin: "https://evilbrokerx.io", want: false},
			{host: "webterminal.orrnn.com", origin: "https://brokerx.io.evil.net", want: false},
			{host: "webterminal.orrnn.com", origin: "http://localhost:5173", want: true}, // loopback stays
			{host: "", origin: "https://a.brokerx.io", want: true},                      // empty host allows env host
			{host: "", origin: "https://other.com", want: false},
		}
		for _, tc := range cases {
			req := newOriginTestRequest(tc.host, "", tc.origin)
			if got := isAllowedWebTerminalOrigin(req); got != tc.want {
				t.Fatalf("host=%q origin=%q: got %v, want %v", tc.host, tc.origin, got, tc.want)
			}
		}
	})

	t.Run("exact star and invalid entries", func(t *testing.T) {
		raw := " Exact.Partner.com , *.Star.io , https://bad.com , bad.com:8443 , bad.com/path , user@bad.com , bad host , , . , *. , *.*.bad.com "
		invalid := applyTestOriginPolicy(t, raw, "")
		if len(invalid) != 9 {
			t.Fatalf("expected 9 invalid entries skipped, got %d (%q)", len(invalid), invalid)
		}

		cases := []struct {
			origin string
			want   bool
		}{
			{origin: "https://exact.partner.com", want: true},
			{origin: "https://sub.exact.partner.com", want: false},
			{origin: "https://star.io", want: true},
			{origin: "https://app.star.io", want: true},
			{origin: "https://evilstar.io", want: false},
			{origin: "https://bad.com", want: false},
			{origin: "https://admin.orrnn.com", want: false},
		}
		for _, tc := range cases {
			req := newOriginTestRequest("webterminal.orrnn.com", "", tc.origin)
			if got := isAllowedWebTerminalOrigin(req); got != tc.want {
				t.Fatalf("origin=%q: got %v, want %v", tc.origin, got, tc.want)
			}
		}
	})

	t.Run("startup init logs one line on invalid entries", func(t *testing.T) {
		prev := currentWebOriginPolicy.Load()
		t.Cleanup(func() { currentWebOriginPolicy.Store(prev) })

		t.Setenv("RTX5_WEB_ALLOWED_ORIGIN_HOSTS", ".brokerx.io, https://bad.com, bad.com:8443, a/b, u@h, has space, ")
		t.Setenv("RTX5_WEB_PUBLIC_HOST", "")

		var buf bytes.Buffer
		prevOut := log.Writer()
		log.SetOutput(&buf)
		t.Cleanup(func() { log.SetOutput(prevOut) })

		initWebOriginPolicyFromEnv()

		lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
		if len(lines) != 1 || !strings.Contains(lines[0], "RTX5_WEB_ALLOWED_ORIGIN_HOSTS") {
			t.Fatalf("expected exactly one startup warning log line, got %d: %q", len(lines), buf.String())
		}
	})
}

func TestWebSocketUpgradersOriginEnforcement(t *testing.T) {
	applyTestOriginPolicy(t, "", "")

	t.Run("binaryOrderWSUpgrader", func(t *testing.T) {
		srv := &WebTerminalServer{
			sessionTokens: make(map[string]string),
		}
		srv.setDefaultBroker("", "", "127.0.0.1:4443")
		ts := httptest.NewServer(http.HandlerFunc(srv.serveBinaryOrderWS))
		defer ts.Close()

		wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/__rtx5_binary_order_ws"

		// Cross-origin upgrade must fail with 403 Forbidden.
		_, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
			"Origin": []string{"https://evil.example.com"},
		})
		if err == nil {
			t.Fatal("expected cross-origin dial to fail, but it succeeded")
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden on cross-origin upgrade, got resp=%v err=%v", resp, err)
		}

		// Same-host upgrade must succeed.
		conn, okResp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
			"Origin": []string{ts.URL},
		})
		if err != nil {
			t.Fatalf("expected same-host upgrade to succeed, got err=%v resp=%v", err, okResp)
		}
		_ = conn.Close()
	})

	t.Run("drawingSyncWSUpgrader", func(t *testing.T) {
		srv, _ := newTestDrawingServer(t, "brokerx")
		ts := httptest.NewServer(http.HandlerFunc(srv.serveDrawingSyncWS))
		defer ts.Close()

		tok := makeTestDrawingJWT("brokerx", 200010, time.Hour)
		wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/__rtx5_drawing_ws?token=" + tok + "&clientId=origin-test"

		// Cross-origin upgrade must fail with 403 Forbidden.
		_, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
			"Origin": []string{"https://evil.example.com"},
		})
		if err == nil {
			t.Fatal("expected cross-origin drawing WS dial to fail, but it succeeded")
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden on cross-origin drawing WS upgrade, got resp=%v err=%v", resp, err)
		}

		// Same-host upgrade must succeed.
		conn, okResp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
			"Origin": []string{ts.URL},
		})
		if err != nil {
			t.Fatalf("expected same-host drawing WS upgrade to succeed, got err=%v resp=%v", err, okResp)
		}
		_ = conn.Close()
	})
}

func TestHTTPToHTTPSRedirectHandler(t *testing.T) {
	t.Run("empty host gives 400 when public host unset", func(t *testing.T) {
		applyTestOriginPolicy(t, "", "")
		req := httptest.NewRequest(http.MethodGet, "http://placeholder.local/trade?sym=EURUSD", nil)
		req.Host = ""
		rec := httptest.NewRecorder()

		httpToHTTPSRedirectHandler(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
	})

	t.Run("empty host uses RTX5_WEB_PUBLIC_HOST when set", func(t *testing.T) {
		applyTestOriginPolicy(t, "", "terminal.brokerx.io")
		req := httptest.NewRequest(http.MethodGet, "http://placeholder.local/trade?sym=EURUSD", nil)
		req.Host = ""
		rec := httptest.NewRecorder()

		httpToHTTPSRedirectHandler(rec, req)
		if rec.Code != http.StatusMovedPermanently {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusMovedPermanently)
		}
		if loc := rec.Header().Get("Location"); loc != "https://terminal.brokerx.io/trade?sym=EURUSD" {
			t.Fatalf("Location = %q, want %q", loc, "https://terminal.brokerx.io/trade?sym=EURUSD")
		}
	})

	t.Run("invalid RTX5_WEB_PUBLIC_HOST ignored and returns 400", func(t *testing.T) {
		applyTestOriginPolicy(t, "", "https://terminal.brokerx.io")
		req := httptest.NewRequest(http.MethodGet, "http://placeholder.local/trade", nil)
		req.Host = ""
		rec := httptest.NewRecorder()

		httpToHTTPSRedirectHandler(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
	})

	t.Run("normal host is unchanged", func(t *testing.T) {
		applyTestOriginPolicy(t, "", "fallback.brokerx.io")
		req := httptest.NewRequest(http.MethodGet, "http://app.brokerx.io:80/chart?id=1", nil)
		rec := httptest.NewRecorder()

		httpToHTTPSRedirectHandler(rec, req)
		if rec.Code != http.StatusMovedPermanently {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusMovedPermanently)
		}
		if loc := rec.Header().Get("Location"); loc != "https://app.brokerx.io/chart?id=1" {
			t.Fatalf("Location = %q, want %q", loc, "https://app.brokerx.io/chart?id=1")
		}
	})

	t.Run("xfh and ipv6 host redirect", func(t *testing.T) {
		applyTestOriginPolicy(t, "", "")
		req := httptest.NewRequest(http.MethodGet, "http://placeholder.local/ws", nil)
		req.Host = "[2001:db8::1]:80"
		rec := httptest.NewRecorder()
		httpToHTTPSRedirectHandler(rec, req)
		if loc := rec.Header().Get("Location"); loc != "https://[2001:db8::1]/ws" {
			t.Fatalf("IPv6 Location = %q, want %q", loc, "https://[2001:db8::1]/ws")
		}

		req2 := httptest.NewRequest(http.MethodGet, "http://internal.local:80/app", nil)
		req2.Header.Set("X-Forwarded-Host", "edge.brokerx.io:80, proxy.internal")
		rec2 := httptest.NewRecorder()
		httpToHTTPSRedirectHandler(rec2, req2)
		if loc := rec2.Header().Get("Location"); loc != "https://edge.brokerx.io/app" {
			t.Fatalf("XFH Location = %q, want %q", loc, "https://edge.brokerx.io/app")
		}
	})
}

func TestNoBrandInNonTestGoFiles(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob *.go: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("expected non-empty *.go file list")
	}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, rerr := os.ReadFile(f)
		if rerr != nil {
			t.Fatalf("read %s: %v", f, rerr)
		}
		if strings.Contains(strings.ToLower(string(raw)), "orrnn") {
			t.Fatalf("found hardcoded brand reference in non-test Go file %s", f)
		}
	}
}

func BenchmarkIsAllowedWebTerminalOrigin(b *testing.B) {
	b.Run("DerivedRule", func(b *testing.B) {
		applyTestOriginPolicy(b, "", "")
		req := newOriginTestRequest("webterminal.orrnn.com", "", "https://admin.orrnn.com")
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if !isAllowedWebTerminalOrigin(req) {
				b.Fatal("expected true")
			}
		}
	})

	b.Run("EnvSet", func(b *testing.B) {
		applyTestOriginPolicy(b, ".brokerx.io,exact.partner.io,*.portal.net", "")
		req := newOriginTestRequest("webterminal.orrnn.com", "", "https://a.brokerx.io")
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if !isAllowedWebTerminalOrigin(req) {
				b.Fatal("expected true")
			}
		}
	})
}
