package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsLoopbackBrowserOrigin(t *testing.T) {
	allowed := []string{
		"http://127.0.0.1:5173",
		"http://localhost:5173",
		"https://localhost:4173",
		"http://[::1]:5173",
		"http://app.localhost:5173",
	}
	for _, orig := range allowed {
		if !isLoopbackBrowserOrigin(orig) {
			t.Fatalf("expected loopback origin %q to be allowed", orig)
		}
	}
	rejected := []string{
		"",
		"https://evil.example",
		"http://192.168.1.50:5173",
		"file://localhost",
	}
	for _, orig := range rejected {
		if isLoopbackBrowserOrigin(orig) {
			t.Fatalf("expected non-loopback origin %q to be rejected", orig)
		}
	}
}

func TestCORSProtectedResponseWriterPreservesSingleOriginAndCredentials(t *testing.T) {
	rec := httptest.NewRecorder()
	cw := &corsProtectedResponseWriter{
		ResponseWriter: rec,
		origin:         "http://127.0.0.1:5173",
		reqHeaders:     "content-type,x-broker-id",
	}
	// Simulate upstream ProxyHTTP overwriting/duplicating CORS headers
	cw.Header().Set("Access-Control-Allow-Origin", "http://127.0.0.1:18403")
	cw.Header().Add("Access-Control-Allow-Credentials", "true")
	cw.Header().Add("Access-Control-Allow-Credentials", "true")
	cw.WriteHeader(http.StatusUnauthorized)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:5173" {
		t.Fatalf("expected Access-Control-Allow-Origin http://127.0.0.1:5173, got %q", got)
	}
	creds := rec.Header().Values("Access-Control-Allow-Credentials")
	if len(creds) != 1 || creds[0] != "true" {
		t.Fatalf("expected single Access-Control-Allow-Credentials=true, got %v", creds)
	}
}

func TestServeHTTPHandlesLoopbackOptionsPreflight(t *testing.T) {
	srv := newPerSessionTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/api/tcp-client/switch-broker", nil)
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	rec := httptest.NewRecorder()

	srv.serveHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS preflight, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:5173" {
		t.Fatalf("expected ACAO http://127.0.0.1:5173, got %q", got)
	}
}
