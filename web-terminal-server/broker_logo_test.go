package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func buildTestPNGInICO(pngPayload []byte) []byte {
	var buf bytes.Buffer
	// ICONDIR: reserved=0, type=1 (ICO), count=1
	_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1))
	// ICONDIRENTRY (16 bytes): 0x0 = 256x256, offset = 22
	buf.Write([]byte{0, 0, 0, 0})
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(32))
	_ = binary.Write(&buf, binary.LittleEndian, uint32(len(pngPayload)))
	_ = binary.Write(&buf, binary.LittleEndian, uint32(22))
	buf.Write(pngPayload)
	return buf.Bytes()
}

func TestBrokerLogoParsingAndICOPNGUnwrap(t *testing.T) {
	if id, ok := extractBrokerLogoID("/api/v1/brokers/orrnn/logo"); !ok || id != "orrnn" {
		t.Fatalf("expected orrnn, got %q (%v)", id, ok)
	}
	if id, ok := extractBrokerLogoID("/api/v2/brokers/alpha%20markets/logo"); !ok || id != "alpha markets" {
		t.Fatalf("expected decoded broker id, got %q (%v)", id, ok)
	}
	if _, ok := extractBrokerLogoID("/api/v1/brokers/../secret/logo"); ok {
		t.Fatalf("expected path traversal to be rejected")
	}

	fakePNG := append(append([]byte(nil), pngMagicBytes...), []byte("IHDR-fake-256x256-logo")...)
	ico := buildTestPNGInICO(fakePNG)
	ct, out, ok := normalizeBrokerLogoPayload("image/vnd.microsoft.icon", ico)
	if !ok || ct != "image/png" || !bytes.Equal(out, fakePNG) {
		t.Fatalf("expected ICO PNG unwrap to image/png, got ok=%v ct=%q len=%d", ok, ct, len(out))
	}

	if _, _, ok := normalizeBrokerLogoPayload("text/html; charset=utf-8", []byte("<html>404</html>")); ok {
		t.Fatalf("expected HTML error page to be rejected as logo")
	}
	if ct, _, ok := normalizeBrokerLogoPayload("", []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)); !ok || !strings.HasPrefix(ct, "image/svg+xml") {
		t.Fatalf("expected SVG sniffing to succeed, got ok=%v ct=%q", ok, ct)
	}
}

func TestDynamicBrokerLogoServedAndUpdatedFromSuperAdmin(t *testing.T) {
	var logoMu sync.RWMutex
	logoVersionNum := 1
	logoPNGv1 := append(append([]byte(nil), pngMagicBytes...), []byte("superadmin-logo-v1")...)
	logoPNGv2 := append(append([]byte(nil), pngMagicBytes...), []byte("superadmin-logo-v2-updated")...)
	currentBody := buildTestPNGInICO(logoPNGv1)
	currentCT := "image/vnd.microsoft.icon"
	currentETag := `W/"1795086875"`

	// Mock local HTTP server representing Super Admin Control Plane
	cpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/brokers/orrnn/logo" {
			http.NotFound(w, r)
			return
		}
		logoMu.RLock()
		body := currentBody
		ct := currentCT
		etag := currentETag
		logoMu.RUnlock()

		if r.Header.Get("If-None-Match") == etag {
			w.Header().Set("ETag", etag)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("ETag", etag)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	defer cpSrv.Close()

	// Mock Super Admin Binary TCP Hub (:9100) accepting RoleSuperAdminClient RPCs
	hubLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen mock superadmin hub: %v", err)
	}
	defer hubLn.Close()

	go func() {
		for {
			raw, aerr := hubLn.Accept()
			if aerr != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				tc, terr := rtx5tcp.AcceptTunnel(conn, 2*time.Second)
				if terr != nil {
					return
				}
				sess := rtx5tcp.NewMuxSession(tc, true, func(svc, _ string) (string, string, error) {
					if svc == "control-plane" {
						return cpSrv.URL, cpSrv.URL, nil
					}
					return "", "", http.ErrNotSupported
				}, nil)
				_ = sess.ServeLoop()
			}(raw)
		}
	}()

	embeddedFallback := append(append([]byte(nil), pngMagicBytes...), []byte("embedded-terminal-icon")...)
	srv := &WebTerminalServer{
		defaultPort:   18403,
		exeDir:        t.TempDir(),
		localUIOnly:   true,
		superAdminTCP: hubLn.Addr().String(),
		distRoot: fstest.MapFS{
			"brand/terminal-icon.png": &fstest.MapFile{Data: embeddedFallback},
		},
		cachedBrokers: []DiscoveredBroker{
			{BrokerID: "orrnn", BrokerName: "Orrnn", TCPAddr: "51.195.188.172:4443", Online: true},
		},
		cachedBrokersAt: time.Now(),
	}

	// 1. Directory payload returns dynamic /api/v1/brokers/orrnn/logo?v=<hash> (NOT hardcoded /brand/terminal-icon.png)
	dirReq := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18403/api/v2/broker/servers", nil)
	dirRec := httptest.NewRecorder()
	srv.serveHTTP(dirRec, dirReq)
	if dirRec.Code != http.StatusOK {
		t.Fatalf("directory status = %d", dirRec.Code)
	}
	var servers []map[string]any
	if err := json.Unmarshal(dirRec.Body.Bytes(), &servers); err != nil || len(servers) != 1 {
		t.Fatalf("unexpected directory body: %s (%v)", dirRec.Body.String(), err)
	}
	logoURL1, _ := servers[0]["logo_url"].(string)
	wantV1 := computeBrokerLogoVersion(logoPNGv1)
	if !strings.Contains(logoURL1, "/api/v1/brokers/orrnn/logo?v="+wantV1) {
		t.Fatalf("expected versioned superadmin logo URL with v=%s, got %q", wantV1, logoURL1)
	}

	// 2. Fetching the logo endpoint returns the unwrapped PNG bytes from SuperAdmin with no-cache & CORS
	logoReq1 := httptest.NewRequest(http.MethodGet, logoURL1, nil)
	logoRec1 := httptest.NewRecorder()
	srv.serveHTTP(logoRec1, logoReq1)
	if logoRec1.Code != http.StatusOK {
		t.Fatalf("logo v1 status = %d", logoRec1.Code)
	}
	if logoRec1.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("expected unwrapped image/png, got %q", logoRec1.Header().Get("Content-Type"))
	}
	if logoRec1.Header().Get("X-RTX5-Broker-Logo-Source") != "superadmin" {
		t.Fatalf("expected superadmin source, got %q", logoRec1.Header().Get("X-RTX5-Broker-Logo-Source"))
	}
	if !strings.Contains(logoRec1.Header().Get("Cache-Control"), "no-cache") {
		t.Fatalf("expected no-cache Cache-Control, got %q", logoRec1.Header().Get("Cache-Control"))
	}
	if logoRec1.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Fatalf("expected Access-Control-Allow-Origin header on logo response")
	}
	if !strings.Contains(logoRec1.Header().Get("Vary"), "Origin") {
		t.Fatalf("expected Vary: Origin header on logo response, got %q", logoRec1.Header().Get("Vary"))
	}
	if !bytes.Equal(logoRec1.Body.Bytes(), logoPNGv1) {
		t.Fatalf("logo v1 body mismatch")
	}

	// 3. SuperAdmin uploads a new logo -> cache expires -> directory & logo endpoint serve v2 immediately!
	logoMu.Lock()
	logoVersionNum++
	currentBody = logoPNGv2
	currentCT = "image/png"
	currentETag = `W/"1795099999"`
	logoMu.Unlock()

	srv.logoMu.Lock()
	srv.logoCache["orrnn"].fetchedAt = time.Now().Add(-10 * time.Second)
	srv.logoMu.Unlock()

	dirReq2 := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18403/api/v2/broker/servers", nil)
	dirRec2 := httptest.NewRecorder()
	srv.serveHTTP(dirRec2, dirReq2)
	var servers2 []map[string]any
	if err := json.Unmarshal(dirRec2.Body.Bytes(), &servers2); err != nil || len(servers2) != 1 {
		t.Fatalf("unexpected directory body v2: %s", dirRec2.Body.String())
	}
	logoURL2, _ := servers2[0]["logo_url"].(string)
	wantV2 := computeBrokerLogoVersion(logoPNGv2)
	if wantV2 == wantV1 || !strings.Contains(logoURL2, "/api/v1/brokers/orrnn/logo?v="+wantV2) {
		t.Fatalf("expected updated v2 logo URL (%s), got %q (v1=%s, rev=%d)", wantV2, logoURL2, wantV1, logoVersionNum)
	}

	logoReq2 := httptest.NewRequest(http.MethodGet, logoURL2, nil)
	logoRec2 := httptest.NewRecorder()
	srv.serveHTTP(logoRec2, logoReq2)
	if logoRec2.Code != http.StatusOK || !bytes.Equal(logoRec2.Body.Bytes(), logoPNGv2) {
		t.Fatalf("expected updated v2 logo bytes, got status=%d body=%q", logoRec2.Code, logoRec2.Body.String())
	}

	// 4. Unknown broker (404 on SuperAdmin) gracefully falls back to embedded terminal-icon.png
	missReq := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18403/api/v1/brokers/unknown-broker/logo", nil)
	missRec := httptest.NewRecorder()
	srv.serveHTTP(missRec, missReq)
	if missRec.Code != http.StatusOK || missRec.Header().Get("X-RTX5-Broker-Logo-Source") != "embedded" || !bytes.Equal(missRec.Body.Bytes(), embeddedFallback) {
		t.Fatalf("expected embedded fallback for missing broker logo, got status=%d src=%q", missRec.Code, missRec.Header().Get("X-RTX5-Broker-Logo-Source"))
	}
}

func TestRequestIsHTTPSAndOriginBehindProxies(t *testing.T) {
	srv := &WebTerminalServer{defaultPort: 18403}

	cases := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{
			name:    "plain http",
			headers: map[string]string{},
			want:    "http://terminal.orrnn.com",
		},
		{
			name:    "multi-hop X-Forwarded-Proto",
			headers: map[string]string{"X-Forwarded-Proto": "https, http"},
			want:    "https://terminal.orrnn.com",
		},
		{
			name:    "RFC 7239 Forwarded proto=https",
			headers: map[string]string{"Forwarded": "for=203.0.113.1;proto=https;host=terminal.orrnn.com"},
			want:    "https://terminal.orrnn.com",
		},
		{
			name:    "X-Forwarded-Ssl on",
			headers: map[string]string{"X-Forwarded-Ssl": "on"},
			want:    "https://terminal.orrnn.com",
		},
		{
			name:    "X-Url-Scheme https",
			headers: map[string]string{"X-Url-Scheme": "https"},
			want:    "https://terminal.orrnn.com",
		},
		{
			name:    "Cloudflare CF-Visitor https",
			headers: map[string]string{"CF-Visitor": `{"scheme":"https"}`},
			want:    "https://terminal.orrnn.com",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://terminal.orrnn.com/api/v2/broker/servers", nil)
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			gotOrigin, _, _, _ := srv.requestOrigin(req)
			if gotOrigin != tc.want {
				t.Fatalf("requestOrigin() = %q, want %q", gotOrigin, tc.want)
			}
		})
	}
}

func TestDynamicBrokerLogoFallsBackToGatewayWhenSuperAdminUnreachable(t *testing.T) {
	gatewayLogoPNG := append(append([]byte(nil), pngMagicBytes...), []byte("gateway-v2-broker-logo")...)

	// Mock local HTTP server representing Broker Gateway (:4443 -> gateway service).
	// Return 404 on /api/v1 and serve the logo on /api/v2 to verify both paths are tried.
	gwHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/brokers/orrnn/logo" {
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("ETag", `"gw-logo-1"`)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(gatewayLogoPNG)
			return
		}
		http.NotFound(w, r)
	}))
	defer gwHTTP.Close()

	// Mock Broker Gateway Binary TCP Access listener (:4443)
	gwLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen mock gateway: %v", err)
	}
	defer gwLn.Close()

	go func() {
		for {
			raw, aerr := gwLn.Accept()
			if aerr != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				tc, terr := rtx5tcp.AcceptTunnel(conn, 2*time.Second)
				if terr != nil {
					return
				}
				sess := rtx5tcp.NewMuxSession(tc, true, func(svc, _ string) (string, string, error) {
					if svc == "gateway" {
						return gwHTTP.URL, gwHTTP.URL, nil
					}
					return "", "", http.ErrNotSupported
				}, nil)
				_ = sess.ServeLoop()
			}(raw)
		}
	}()

	// Pick an unused closed TCP port for unreachable SuperAdmin :9100
	closedLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve closed port: %v", err)
	}
	deadSuperAdminAddr := closedLn.Addr().String()
	_ = closedLn.Close()

	embeddedFallback := append(append([]byte(nil), pngMagicBytes...), []byte("embedded-terminal-icon")...)
	srv := &WebTerminalServer{
		defaultPort:   18403,
		exeDir:        t.TempDir(),
		localUIOnly:   true,
		superAdminTCP: deadSuperAdminAddr,
		distRoot: fstest.MapFS{
			"brand/terminal-icon.png": &fstest.MapFile{Data: embeddedFallback},
		},
		cachedBrokers: []DiscoveredBroker{
			{BrokerID: "orrnn", BrokerName: "Orrnn", TCPAddr: gwLn.Addr().String(), Online: true},
		},
		cachedBrokersAt: time.Now(),
	}
	srv.setDefaultBroker("orrnn", "Orrnn", gwLn.Addr().String())

	req := httptest.NewRequest(http.MethodGet, "https://terminal.orrnn.com/api/v1/brokers/orrnn/logo", nil)
	rec := httptest.NewRecorder()
	srv.serveHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Header().Get("X-RTX5-Broker-Logo-Source") != "gateway" {
		t.Fatalf("expected gateway logo source when superadmin is unreachable, got %q", rec.Header().Get("X-RTX5-Broker-Logo-Source"))
	}
	if rec.Header().Get("Access-Control-Allow-Origin") == "" || !strings.Contains(rec.Header().Get("Vary"), "Origin") {
		t.Fatalf("expected CORS + Vary: Origin headers, got ACAO=%q Vary=%q", rec.Header().Get("Access-Control-Allow-Origin"), rec.Header().Get("Vary"))
	}
	if !bytes.Equal(rec.Body.Bytes(), gatewayLogoPNG) {
		t.Fatalf("gateway logo payload mismatch")
	}
}
