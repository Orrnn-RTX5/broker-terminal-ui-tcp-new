package clientcore

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func TestServeBrokerRuntimeConfigJS_HeadersEscapingAndNoSecrets(t *testing.T) {
	t.Setenv("FEED_BROKER_TOKEN", "secret-feed-token-do-not-expose")
	t.Setenv("BACKEND_PASSWORD", "secret-backend-pw-do-not-expose")
	t.Setenv("PRIVATE_KEY", "secret-private-key-do-not-expose")
	t.Setenv("RTX5_MASTER_PRIV_HEX", "deadbeefsecretkeydonotexpose")

	dc := &DesktopClient{
		cfg: AppConfig{
			Kind:     KindTerminal,
			PeerRole: rtx5tcp.RoleTraderTerminalClient,
		},
		localOrigin:      "http://127.0.0.1:18403",
		fastOrderOrigin:  "http://127.0.0.1:18413",
		activeBrokerID:   `ind</script><script>alert(1)</script>`,
		activeBrokerName: `Independent "Broker" <img src=x>`,
		targetTCPAddr:    "127.0.0.1:4443",
		binHub:           newClientBinaryMarketHub(),
	}

	req := httptest.NewRequest(http.MethodGet, "/runtime-config.js", nil)
	rec := httptest.NewRecorder()
	dc.serveHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/javascript") {
		t.Fatalf("Content-Type = %q, want application/javascript", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}

	body := rec.Body.String()
	if strings.Contains(body, "<") {
		t.Fatalf("runtime-config.js contains raw '<': %s", body)
	}
	if !strings.Contains(body, `\u003c/script\u003e`) {
		t.Fatalf("expected HTML-escaped script tag in runtime-config.js: %s", body)
	}
	for _, secret := range []string{
		"secret-feed-token-do-not-expose",
		"secret-backend-pw-do-not-expose",
		"secret-private-key-do-not-expose",
		"deadbeefsecretkeydonotexpose",
		"FEED_BROKER_TOKEN",
		"BACKEND_PASSWORD",
		"PRIVATE_KEY",
		"RTX5_MASTER_PRIV_HEX",
	} {
		if strings.Contains(body, secret) {
			t.Fatalf("runtime-config.js exposed secret marker %q", secret)
		}
	}
}

func TestProxyOverBinaryTCP_OriginRewrite(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	capturedOrigin := make(chan []string, 8)
	go func() {
		for {
			raw, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				tc, terr := rtx5tcp.AcceptTunnel(c, 5*time.Second)
				if terr != nil {
					return
				}
				for {
					ft, sid, _, payload, rerr := tc.ReadMuxFrame()
					if rerr != nil {
						return
					}
					if ft != rtx5tcp.FrameRPCReq {
						continue
					}
					var meta rtx5tcp.RPCRequestMeta
					_ = json.Unmarshal(payload, &meta)
					capturedOrigin <- append([]string(nil), meta.Headers["Origin"]...)
					hdrBytes, _ := json.Marshal(rtx5tcp.RPCResponseMeta{
						StatusCode: http.StatusOK,
						Headers:    map[string][]string{"Content-Type": {"application/json"}},
					})
					_ = tc.WriteMuxFramesBatch([]rtx5tcp.MuxFrameBatchItem{
						{FrameType: rtx5tcp.FrameRPCRespHeader, StreamID: sid, Flags: rtx5tcp.FlagNone, Payload: hdrBytes},
						{FrameType: rtx5tcp.FrameRPCRespChunk, StreamID: sid, Flags: rtx5tcp.FlagFIN, Payload: []byte(`{"ok":true}`)},
					})
				}
			}(raw)
		}
	}()

	dc := &DesktopClient{
		cfg: AppConfig{
			Kind:             KindTerminal,
			PeerRole:         rtx5tcp.RoleTraderTerminalClient,
			DefaultLocalAddr: "127.0.0.1:18403",
		},
		targetTCPAddr: ln.Addr().String(),
		binHub:        newClientBinaryMarketHub(),
	}
	t.Cleanup(func() {
		dc.mu.Lock()
		m := dc.activeMux
		dc.mu.Unlock()
		if m != nil {
			_ = m.Close()
		}
	})

	cases := []struct {
		name       string
		reqOrigin  string
		wantOrigin []string
	}{
		{
			name:       "rewrites 127.0.0.1 origin to DefaultLocalAddr",
			reqOrigin:  "http://127.0.0.1:5173",
			wantOrigin: []string{"http://127.0.0.1:18403"},
		},
		{
			name:       "rewrites localhost origin to DefaultLocalAddr",
			reqOrigin:  "http://localhost:5173",
			wantOrigin: []string{"http://127.0.0.1:18403"},
		},
		{
			name:       "leaves absent origin unset",
			reqOrigin:  "",
			wantOrigin: nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18403/api/v2/instruments", nil)
			if tc.reqOrigin != "" {
				req.Header.Set("Origin", tc.reqOrigin)
			}
			rec := httptest.NewRecorder()
			dc.proxyOverBinaryTCP(rec, req, "gateway", "/api/v2/instruments")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			got := <-capturedOrigin
			if len(got) != len(tc.wantOrigin) || (len(got) > 0 && got[0] != tc.wantOrigin[0]) {
				t.Fatalf("proxied Origin = %v, want %v", got, tc.wantOrigin)
			}
		})
	}
}

func TestSaveFile_TraversalSanitization(t *testing.T) {
	tmpRoot := t.TempDir()
	tmpHome := filepath.Join(tmpRoot, "home")
	if err := os.MkdirAll(tmpHome, 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("USERPROFILE", tmpHome)
	t.Setenv("HOME", tmpHome)

	exePath, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	exeDir := filepath.Dir(exePath)
	exeParent := filepath.Dir(exeDir)

	snapshotNames := func(dir string) map[string]struct{} {
		entries, rerr := os.ReadDir(dir)
		if rerr != nil {
			t.Fatalf("ReadDir(%s): %v", dir, rerr)
		}
		out := make(map[string]struct{}, len(entries))
		for _, e := range entries {
			out[e.Name()] = struct{}{}
		}
		return out
	}

	beforeExeEntries := snapshotNames(exeDir)
	beforeExeParentEntries := snapshotNames(exeParent)
	t.Cleanup(func() {
		afterEntries, rerr := os.ReadDir(exeDir)
		if rerr != nil {
			return
		}
		for _, e := range afterEntries {
			if _, existed := beforeExeEntries[e.Name()]; !existed {
				_ = os.Remove(filepath.Join(exeDir, e.Name()))
			}
		}
	})

	isDirectChildFile := func(targetPath, dir string) bool {
		cleanDir := filepath.Clean(dir)
		cleanTarget := filepath.Clean(targetPath)
		rel, rerr := filepath.Rel(cleanDir, cleanTarget)
		if rerr != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
			return false
		}
		return filepath.Dir(cleanTarget) == cleanDir
	}

	dc := &DesktopClient{
		cfg:    AppConfig{Kind: KindTerminal, PeerRole: rtx5tcp.RoleTraderTerminalClient},
		binHub: newClientBinaryMarketHub(),
	}

	dlDir := filepath.Join(tmpHome, "Downloads")

	for i, fname := range []string{
		"../../outside.lic",
		`..\outside.lic`,
		"../sub/evil.txt",
		"/etc/passwd",
		`C:\evil.txt`,
		`C:\nested\drive-evil.lic`,
		`D:drive-rel.lic`,
		".",
		"..",
		"",
	} {
		payloadText := "license-payload-" + strconv.Itoa(i)
		payload, _ := json.Marshal(map[string]string{
			"filename": fname,
			"content":  payloadText,
		})
		r := httptest.NewRequest(http.MethodPost, "/api/tcp-client/save-file", bytes.NewReader(payload))
		w := httptest.NewRecorder()
		dc.serveHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("save-file(%q) status = %d, want 200", fname, w.Code)
		}
		var out struct {
			OK         bool     `json:"ok"`
			SavedPaths []string `json:"saved_paths"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || !out.OK {
			t.Fatalf("save-file(%q) bad JSON: %v %s", fname, err, w.Body.String())
		}
		for _, p := range out.SavedPaths {
			if filepath.Base(p) == ".." {
				t.Fatalf("save-file(%q) wrote parent traversal path %q", fname, p)
			}
			if !isDirectChildFile(p, dlDir) && !isDirectChildFile(p, exeDir) {
				t.Fatalf("save-file(%q) escaped containment: %q (dlDir=%q exeDir=%q)", fname, p, dlDir, exeDir)
			}
			if data, rerr := os.ReadFile(p); rerr != nil || string(data) != payloadText {
				t.Fatalf("save-file(%q) written file %q mismatch: err=%v", fname, p, rerr)
			}
		}

		// Verify nothing escaped into tmpRoot/tmpHome outside dlDir.
		if werr := filepath.WalkDir(tmpRoot, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			if !isDirectChildFile(p, dlDir) {
				t.Fatalf("save-file(%q) wrote file outside %s: %s", fname, dlDir, p)
			}
			return nil
		}); werr != nil {
			t.Fatalf("WalkDir(%s): %v", tmpRoot, werr)
		}

		// Verify no new files were written into exeDir's parent directory.
		for name := range snapshotNames(exeParent) {
			if _, existed := beforeExeParentEntries[name]; !existed {
				t.Fatalf("save-file(%q) created unexpected entry in exeDir parent %s: %s", fname, exeParent, name)
			}
		}
	}
}

func TestUnpackVerifiedUIZip_TraversalAndCaps(t *testing.T) {
	buildZip := func(entries map[string]string) []byte {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		for name, content := range entries {
			fw, err := zw.Create(name)
			if err != nil {
				t.Fatalf("create zip entry %s: %v", name, err)
			}
			if _, err := fw.Write([]byte(content)); err != nil {
				t.Fatalf("write zip entry %s: %v", name, err)
			}
		}
		if err := zw.Close(); err != nil {
			t.Fatalf("close zip: %v", err)
		}
		return buf.Bytes()
	}

	parent := t.TempDir()
	destDir := filepath.Join(parent, "ui-cache")
	siblingDir := filepath.Join(parent, "ui-cache-evil")
	if err := os.MkdirAll(siblingDir, 0755); err != nil {
		t.Fatal(err)
	}

	zipBytes := buildZip(map[string]string{
		"index.html":              "<html>ok</html>",
		"assets/app.js":           "console.log(1);",
		"../evil1.txt":            "pwn1",
		"sub/../../evil2.txt":     "pwn2",
		"/../../evil3.txt":        "pwn3",
		`..\evil4.txt`:            "pwn4",
		"../ui-cache-evil/x.txt":  "pwn5",
	})
	if err := unpackVerifiedUIZip(zipBytes, destDir); err != nil {
		t.Fatalf("unpackVerifiedUIZip failed: %v", err)
	}

	if got, err := os.ReadFile(filepath.Join(destDir, "index.html")); err != nil || string(got) != "<html>ok</html>" {
		t.Fatalf("missing extracted index.html: err=%v got=%q", err, string(got))
	}
	if got, err := os.ReadFile(filepath.Join(destDir, "assets", "app.js")); err != nil || string(got) != "console.log(1);" {
		t.Fatalf("missing extracted assets/app.js: err=%v got=%q", err, string(got))
	}
	for _, escaped := range []string{
		filepath.Join(parent, "evil1.txt"),
		filepath.Join(parent, "evil2.txt"),
		filepath.Join(parent, "evil3.txt"),
		filepath.Join(parent, "evil4.txt"),
		filepath.Join(siblingDir, "x.txt"),
		filepath.Join(destDir, "evil1.txt"),
	} {
		if _, err := os.Stat(escaped); !os.IsNotExist(err) {
			t.Fatalf("unexpected extracted traversal file at %s", escaped)
		}
	}

	// File count cap > 4096 must fail closed.
	var hugeBuf bytes.Buffer
	hugeZip := zip.NewWriter(&hugeBuf)
	for i := 0; i < 4097; i++ {
		fw, err := hugeZip.Create("f/" + strconv.Itoa(i) + ".txt")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fw.Write([]byte("x"))
	}
	_ = hugeZip.Close()
	if err := unpackVerifiedUIZip(hugeBuf.Bytes(), filepath.Join(parent, "huge-dest")); err == nil || !strings.Contains(err.Error(), "4096") {
		t.Fatalf("expected 4096 cap error, got %v", err)
	}
}

func TestClientcoreExtractBrokerLogoID_TraversalRejected(t *testing.T) {
	if id, ok := extractBrokerLogoID("/api/v1/brokers/ind-broker/logo"); !ok || id != "ind-broker" {
		t.Fatalf("expected ind-broker, got %q (%v)", id, ok)
	}
	if id, ok := extractBrokerLogoID("/api/v2/brokers/alpha%20markets/logo"); !ok || id != "alpha markets" {
		t.Fatalf("expected alpha markets, got %q (%v)", id, ok)
	}
	for _, bad := range []string{
		"/api/v1/brokers/../secret/logo",
		"/api/v1/brokers/%2e%2e/logo",
		"/api/v1/brokers/a%2fb/logo",
		"/api/v1/brokers/a%5cb/logo",
		"/api/v1/brokers/foo..bar/logo",
		"/api/v1/brokers//logo",
		"/api/v1/brokers/%20/logo",
		"/api/v1/brokers/a/b/logo",
		"/other/path/logo",
	} {
		if id, ok := extractBrokerLogoID(bad); ok {
			t.Fatalf("expected %q to be rejected, got %q", bad, id)
		}
	}
}
