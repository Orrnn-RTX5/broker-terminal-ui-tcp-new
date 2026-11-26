package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// The one-time SSO token lives in the URL fragment of this page, so the page must never send a Referer.
func TestServeIndexHTMLSetsNoReferrerPolicy(t *testing.T) {
	srv := &WebTerminalServer{
		exeDir:   t.TempDir(),
		distRoot: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html><html><body></body></html>")}},
	}
	rec := httptest.NewRecorder()
	srv.serveIndexHTML(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
}
