package main

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
	"testing/fstest"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func TestWebTerminalRuntimeConfigAndValidatorHeadersEscapingNoSecrets(t *testing.T) {
	t.Setenv("FEED_BROKER_TOKEN", "wt-secret-feed-token")
	t.Setenv("BACKEND_PASSWORD", "wt-secret-backend-pw")
	t.Setenv("PRIVATE_KEY", "wt-secret-private-key")
	t.Setenv("RTX5_MASTER_PRIV_HEX", "wt-secret-master-hex")

	srv := &WebTerminalServer{
		defaultPort:   18403,
		sessionTokens: make(map[string]string),
	}
	srv.setDefaultBroker(`ind</script><script>alert(1)</script>`, `Ind "Broker" <img src=x>`, "127.0.0.1:1")

	secrets := []string{
		"wt-secret-feed-token",
		"wt-secret-backend-pw",
		"wt-secret-private-key",
		"wt-secret-master-hex",
		"FEED_BROKER_TOKEN",
		"BACKEND_PASSWORD",
		"PRIVATE_KEY",
		"RTX5_MASTER_PRIV_HEX",
	}

	for _, path := range []string{"/runtime-config.js", "/runtime-config-validator.js"} {
		req := httptest.NewRequest(http.MethodGet, "https://terminal.independent.test"+path, nil)
		rec := httptest.NewRecorder()
		srv.serveHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/javascript") {
			t.Fatalf("GET %s Content-Type = %q", path, ct)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Fatalf("GET %s Cache-Control = %q, want no-store", path, cc)
		}

		body := rec.Body.String()
		for _, secret := range secrets {
			if strings.Contains(body, secret) {
				t.Fatalf("GET %s leaked secret marker %q", path, secret)
			}
		}

		if path == "/runtime-config.js" {
			if strings.Contains(body, "<") {
				t.Fatalf("GET %s contained raw '<': %s", path, body)
			}
			if !strings.Contains(body, `\u003c/script\u003e`) {
				t.Fatalf("GET %s missing escaped script tag: %s", path, body)
			}
		}
	}

	// SuperAdmin /runtime-config.js sets Cache-Control: no-store and skips terminal RUNTIME_CONFIG
	saReq := httptest.NewRequest(http.MethodGet, "/runtime-config.js", nil)
	saReq.Header.Set("X-RTX5-Web-App", "superadmin")
	saRec := httptest.NewRecorder()
	srv.serveHTTP(saRec, saReq)
	if saRec.Code != http.StatusOK {
		t.Fatalf("superadmin /runtime-config.js status = %d, want 200", saRec.Code)
	}
	if ct := saRec.Header().Get("Content-Type"); !strings.Contains(ct, "application/javascript") {
		t.Fatalf("superadmin /runtime-config.js Content-Type = %q", ct)
	}
	if cc := saRec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("superadmin /runtime-config.js Cache-Control = %q, want no-store", cc)
	}
	saBody := saRec.Body.String()
	if !strings.Contains(saBody, "/* superadmin web-tcp */") {
		t.Fatalf("superadmin /runtime-config.js missing superadmin marker: %q", saBody)
	}
	if strings.Contains(saBody, "RUNTIME_CONFIG") {
		t.Fatalf("superadmin /runtime-config.js unexpectedly wrote terminal RUNTIME_CONFIG: %q", saBody)
	}
	for _, secret := range secrets {
		if strings.Contains(saBody, secret) {
			t.Fatalf("superadmin /runtime-config.js leaked secret marker %q", secret)
		}
	}
}

func TestProxyOverBinaryTCPForApp_OriginRewrite(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	capturedOrigin := make(chan []string, 16)
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
						Headers: map[string][]string{
							"Content-Type":                {"application/json"},
							"Access-Control-Allow-Origin": {"http://127.0.0.1:18403"},
						},
					})
					_ = tc.WriteMuxFramesBatch([]rtx5tcp.MuxFrameBatchItem{
						{FrameType: rtx5tcp.FrameRPCRespHeader, StreamID: sid, Flags: rtx5tcp.FlagNone, Payload: hdrBytes},
						{FrameType: rtx5tcp.FrameRPCRespChunk, StreamID: sid, Flags: rtx5tcp.FlagFIN, Payload: []byte(`{"ok":true}`)},
					})
				}
			}(raw)
		}
	}()

	srv := &WebTerminalServer{
		defaultPort:   18403,
		superAdminTCP: ln.Addr().String(),
		sessionTokens: make(map[string]string),
	}
	link := srv.setDefaultBroker("ind-broker", "Independent", ln.Addr().String())
	t.Cleanup(func() {
		link.closeAll()
		srv.mu.Lock()
		sm := srv.superAdminMux
		srv.mu.Unlock()
		if sm != nil {
			_ = sm.Close()
		}
	})

	cases := []struct {
		appKind          string
		reqOrigin        string
		wantOrigin       []string
		wantLoopbackACAO string
	}{
		{
			appKind:          "terminal",
			reqOrigin:        "http://127.0.0.1:5173",
			wantOrigin:       []string{"http://127.0.0.1:18403"},
			wantLoopbackACAO: "http://127.0.0.1:5173",
		},
		{
			appKind:    "admin",
			reqOrigin:  "https://evil.example",
			wantOrigin: []string{"http://127.0.0.1:18401"},
		},
		{
			appKind:          "manager",
			reqOrigin:        "http://localhost:5173",
			wantOrigin:       []string{"http://127.0.0.1:18402"},
			wantLoopbackACAO: "http://localhost:5173",
		},
		{
			appKind:    "superadmin",
			reqOrigin:  "https://terminal.independent.test",
			wantOrigin: []string{"http://127.0.0.1:18400"},
		},
		{
			appKind:    "terminal",
			reqOrigin:  "",
			wantOrigin: nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.appKind+"_"+tc.reqOrigin, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "https://terminal.independent.test/api/v2/instruments", nil)
			if tc.reqOrigin != "" {
				req.Header.Set("Origin", tc.reqOrigin)
			}
			rec := httptest.NewRecorder()
			srv.proxyOverBinaryTCPForApp(rec, req, link, tc.appKind, "gateway", "/api/v2/instruments")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			got := <-capturedOrigin
			if len(got) != len(tc.wantOrigin) || (len(got) > 0 && got[0] != tc.wantOrigin[0]) {
				t.Fatalf("proxied Origin = %v, want %v", got, tc.wantOrigin)
			}
			if tc.wantLoopbackACAO != "" {
				if rec.Header().Get("Access-Control-Allow-Origin") != tc.wantLoopbackACAO {
					t.Fatalf("response ACAO = %q, want %q", rec.Header().Get("Access-Control-Allow-Origin"), tc.wantLoopbackACAO)
				}
			}
		})
	}
}

func TestWebTerminalSaveFile_TraversalContainment(t *testing.T) {
	tmpRoot := t.TempDir()
	exeDir := filepath.Join(tmpRoot, "bin")
	if err := os.MkdirAll(exeDir, 0755); err != nil {
		t.Fatal(err)
	}
	srv := &WebTerminalServer{
		exeDir:        exeDir,
		sessionTokens: make(map[string]string),
	}
	srv.setDefaultBroker("ind-broker", "Independent", "127.0.0.1:1")

	licDir := filepath.Join(tmpRoot, "runtime-data", "issued-licenses")

	isStrictChildFile := func(targetPath, dir string) bool {
		cleanDir := filepath.Clean(dir)
		cleanTarget := filepath.Clean(targetPath)
		rel, err := filepath.Rel(cleanDir, cleanTarget)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
			return false
		}
		return filepath.Dir(cleanTarget) == cleanDir
	}

	assertAllFilesContained := func(t *testing.T) {
		t.Helper()
		err := filepath.WalkDir(tmpRoot, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			if !isStrictChildFile(p, licDir) {
				t.Fatalf("file created outside %s: %s", licDir, p)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("WalkDir(%s): %v", tmpRoot, err)
		}
	}

	for i, input := range []string{
		"../../outside.lic",
		`..\win-outside.lic`,
		"../sub/evil.txt",
		"/etc/passwd",
		`C:\evil.txt`,
		`C:\nested\drive-evil.lic`,
		`D:drive-rel.lic`,
		".",
		"",
		"..",
	} {
		payload := "payload-" + strconv.Itoa(i)
		body, _ := json.Marshal(map[string]string{
			"filename": input,
			"content":  payload,
		})
		req := httptest.NewRequest(http.MethodPost, "/api/tcp-client/save-file", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		srv.serveHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("save-file(%q) status = %d", input, rec.Code)
		}
		var out struct {
			OK         bool     `json:"ok"`
			SavedPaths []string `json:"saved_paths"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || !out.OK {
			t.Fatalf("save-file(%q) bad JSON: %v", input, err)
		}
		for _, p := range out.SavedPaths {
			if filepath.Base(p) == ".." {
				t.Fatalf("save-file(%q) returned parent traversal path %q", input, p)
			}
			if filepath.IsAbs(p) || strings.ContainsAny(p, `/\`) {
				if !isStrictChildFile(p, licDir) {
					t.Fatalf("save-file(%q) returned non-contained path %q (want inside %s)", input, p, licDir)
				}
				if data, err := os.ReadFile(p); err != nil || string(data) != payload {
					t.Fatalf("save-file(%q) saved path %q unreadable or mismatched: err=%v", input, p, err)
				}
			}
		}
		assertAllFilesContained(t)
	}
}

func TestUnpackWebUIZip_TraversalAndCaps(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range map[string]string{
		"index.html":             "<html>ok</html>",
		"assets/app.js":          "console.log(1);",
		"../evil1.txt":           "pwn1",
		"sub/../../evil2.txt":    "pwn2",
		"/../../evil3.txt":       "pwn3",
		`..\evil4.txt`:           "pwn4",
		"../ui-cache-evil/x.txt": "pwn5",
	} {
		fw, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	_ = zw.Close()

	parent := t.TempDir()
	destDir := filepath.Join(parent, "ui-cache")
	siblingDir := filepath.Join(parent, "ui-cache-evil")
	if err := os.MkdirAll(siblingDir, 0755); err != nil {
		t.Fatal(err)
	}

	if err := unpackWebUIZip(buf.Bytes(), destDir); err != nil {
		t.Fatalf("unpackWebUIZip failed: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(destDir, "index.html")); err != nil || string(got) != "<html>ok</html>" {
		t.Fatalf("missing index.html: err=%v", err)
	}
	for _, escaped := range []string{
		filepath.Join(parent, "evil1.txt"),
		filepath.Join(parent, "evil2.txt"),
		filepath.Join(parent, "evil3.txt"),
		filepath.Join(parent, "evil4.txt"),
		filepath.Join(siblingDir, "x.txt"),
	} {
		if _, err := os.Stat(escaped); !os.IsNotExist(err) {
			t.Fatalf("unexpected extracted traversal file at %s", escaped)
		}
	}

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
	if err := unpackWebUIZip(hugeBuf.Bytes(), filepath.Join(parent, "huge")); err == nil || !strings.Contains(err.Error(), "4096") {
		t.Fatalf("expected 4096 cap error, got %v", err)
	}
}

func TestDrawingsSync_PathContainmentAndSafeStorageSegment(t *testing.T) {
	parent := t.TempDir()
	base := filepath.Join(parent, "drawings")
	sibling := filepath.Join(parent, "drawings-evil")
	if err := os.MkdirAll(sibling, 0755); err != nil {
		t.Fatal(err)
	}
	hub := newDrawingSyncHub(base)

	for _, rawBroker := range []string{
		"../../etc/passwd",
		`..\..\windows\system32`,
		"../drawings-evil",
		"..",
		".",
		"",
		"Alpha/Beta",
		"ind-broker",
	} {
		seg := safeStorageSegment(rawBroker)
		if strings.Contains(seg, "..") || strings.ContainsAny(seg, `/\`) {
			t.Fatalf("safeStorageSegment(%q) = %q still contains unsafe path chars", rawBroker, seg)
		}
		fp := hub.accountFilePath(rawBroker, 200010)
		rel, err := filepath.Rel(base, fp)
		if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			t.Fatalf("accountFilePath(%q) escaped base %q: got %q (rel=%q, err=%v)", rawBroker, base, fp, rel, err)
		}
		if strings.HasPrefix(fp, sibling+string(os.PathSeparator)) {
			t.Fatalf("accountFilePath(%q) matched sibling %q", rawBroker, fp)
		}
	}

	emptyHub := newDrawingSyncHub("")
	if got := emptyHub.accountFilePath("ind-broker", 200010); got != "" {
		t.Fatalf("expected empty accountFilePath when storageDir is empty, got %q", got)
	}
}

func TestWebTerminalStaticAndHTMLCaching(t *testing.T) {
	modTime := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	srv := &WebTerminalServer{
		exeDir:        t.TempDir(),
		localUIOnly:   true,
		sessionTokens: make(map[string]string),
		distRoot: fstest.MapFS{
			"index.html":              &fstest.MapFile{Data: []byte("<!doctype html><html><body>app</body></html>"), ModTime: modTime},
			"brand/terminal-icon.png": &fstest.MapFile{Data: append([]byte{0x89, 'P', 'N', 'G'}, []byte("icon")...), ModTime: modTime},
			"login/hero.webp":         &fstest.MapFile{Data: []byte("RIFFhero"), ModTime: modTime},
			"assets/app-1234.js":      &fstest.MapFile{Data: []byte("console.log('ok');"), ModTime: modTime},
		},
	}

	for _, path := range []string{"/", "/index.html", "/trade"} {
		rec := httptest.NewRecorder()
		srv.serveHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d", path, rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("GET %s Cache-Control = %q, want no-store", path, got)
		}
		if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
			t.Fatalf("GET %s Referrer-Policy = %q, want no-referrer", path, got)
		}
	}

	brandRec := httptest.NewRecorder()
	srv.serveHTTP(brandRec, httptest.NewRequest(http.MethodGet, "/brand/terminal-icon.png", nil))
	if brandRec.Code != http.StatusOK || brandRec.Header().Get("Cache-Control") != "no-cache, must-revalidate" {
		t.Fatalf("GET /brand/terminal-icon.png: status=%d cc=%q", brandRec.Code, brandRec.Header().Get("Cache-Control"))
	}

	for _, staticPath := range []string{"/login/hero.webp", "/assets/app-1234.js"} {
		rec := httptest.NewRecorder()
		srv.serveHTTP(rec, httptest.NewRequest(http.MethodGet, staticPath, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d", staticPath, rec.Code)
		}
		if rec.Header().Get("Last-Modified") == "" {
			t.Fatalf("GET %s missing Last-Modified from http.ServeContent", staticPath)
		}
		if got := rec.Header().Get("Cache-Control"); strings.Contains(strings.ToLower(got), "no-store") {
			t.Fatalf("GET %s Cache-Control = %q, must not contain no-store", staticPath, got)
		}
	}
}
