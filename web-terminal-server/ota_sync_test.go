package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func buildTestUIZip(t *testing.T, files map[string]string) (zipBytes []byte, zipSHA string, treeSHA string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	memFS := fstest.MapFS{}
	for name, content := range files {
		fw, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create zip entry %s: %v", name, err)
		}
		if _, err := fw.Write([]byte(content)); err != nil {
			t.Fatalf("write zip entry %s: %v", name, err)
		}
		memFS[name] = &fstest.MapFile{Data: []byte(content)}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	zipBytes = buf.Bytes()
	sum := sha256.Sum256(zipBytes)
	zipSHA = hex.EncodeToString(sum[:])
	var err error
	treeSHA, err = rtx5tcp.ComputeFSTreeSHA256(memFS)
	if err != nil {
		t.Fatalf("compute tree sha: %v", err)
	}
	return zipBytes, zipSHA, treeSHA
}

func readFSIndex(t *testing.T, fsys fs.FS) string {
	t.Helper()
	raw, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	return string(raw)
}

func writeTestDirFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	for name, content := range files {
		full := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatalf("mkdir parent %s: %v", full, err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}
}

func signTestOTAManifest(t *testing.T, apps map[string]*rtx5tcp.OTAAppArtifact) (pubHex string, manifestJSON []byte) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	pubHex = hex.EncodeToString(pub)
	privHex := hex.EncodeToString(priv)
	m := &rtx5tcp.OTAManifest{
		Schema:      rtx5tcp.OTASchemaV1,
		Channel:     rtx5tcp.OTAChannelProduction,
		ReleaseID:   "rtx5-tcp-ota-test-ui",
		PublishedAt: time.Now().Unix(),
		Apps:        apps,
	}
	if err := rtx5tcp.SignOTAManifest(m, privHex); err != nil {
		t.Fatalf("sign manifest: %v", err)
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	return pubHex, raw
}

func TestGetActiveDistFS_StaleUIDistDoesNotShadowEmbeddedAfterOTASync(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "rtx5-web-suite")
	if err := os.MkdirAll(exeDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Simulate the production VPS layout: ancient v1.1.2 files sit in both
	// <exeDir>/ui-dist/terminal and <exeDir>/../ui-dist/terminal, plus a stale
	// ui-cache/terminal directory, while the deployed binary embeds v1.1.15.
	writeTestDirFiles(t, filepath.Join(exeDir, "ui-dist", "terminal"), map[string]string{
		"index.html": "<html>stale-v1.1.2-ui-dist</html>",
	})
	writeTestDirFiles(t, filepath.Join(root, "ui-dist", "terminal"), map[string]string{
		"index.html": "<html>stale-v1.1.2-parent-ui-dist</html>",
	})
	writeTestDirFiles(t, filepath.Join(exeDir, "ui-cache", "terminal"), map[string]string{
		"index.html": "<html>old-v1.1.14-ui-cache</html>",
	})

	embeddedFiles := map[string]string{
		"index.html":          "<html>fresh-v1.1.15-embedded</html>",
		"assets/index-new.js": "console.log('1.1.15');",
	}
	zipBytes, zipSHA, treeSHA := buildTestUIZip(t, embeddedFiles)
	embeddedFS := fstest.MapFS{}
	for name, content := range embeddedFiles {
		embeddedFS[name] = &fstest.MapFile{Data: []byte(content)}
	}

	pubHex, manifestJSON := signTestOTAManifest(t, map[string]*rtx5tcp.OTAAppArtifact{
		"terminal": {
			AppKey:       "terminal",
			Version:      "1.1.15",
			UIZipFile:    "terminal-ui-dist.zip",
			UISHA256:     zipSHA,
			UISize:       int64(len(zipBytes)),
			UITreeSHA256: treeSHA,
		},
	})

	srv := &WebTerminalServer{
		exeDir:       exeDir,
		masterPubHex: pubHex,
		distRoot:     embeddedFS,
		otaFetcher: func(otaPath string, _ time.Duration) ([]byte, int, error) {
			if strings.HasPrefix(otaPath, "/ota/manifest") {
				return manifestJSON, http.StatusOK, nil
			}
			t.Fatalf("unexpected download when embedded matches OTA: %s", otaPath)
			return nil, 0, nil
		},
	}
	srv.initHotUIOTAState()

	if err := srv.syncHotUIOTA(); err != nil {
		t.Fatalf("syncHotUIOTA failed: %v", err)
	}

	snap := srv.getOTAStatusSnapshotForApp("terminal")
	if snap["ui_source"] != "embedded" {
		t.Fatalf("expected ui_source=embedded, got %v", snap["ui_source"])
	}

	got := readFSIndex(t, srv.getActiveDistFSForApp("terminal"))
	if got != "<html>fresh-v1.1.15-embedded</html>" {
		t.Fatalf("expected embedded v1.1.15 index.html, got %q", got)
	}

	// Even if a stale ui-cache/terminal directory reappears on disk, verified embedded wins.
	writeTestDirFiles(t, filepath.Join(exeDir, "ui-cache", "terminal"), map[string]string{
		"index.html": "<html>stale-recreated-cache</html>",
	})
	got = readFSIndex(t, srv.getActiveDistFSForApp("terminal"))
	if got != "<html>fresh-v1.1.15-embedded</html>" {
		t.Fatalf("expected verified embedded to override stale ui-cache, got %q", got)
	}
}

func TestGetActiveDistFS_NewerOTAHotCacheOverridesEmbeddedAndStaleUIDist(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "rtx5-web-suite")
	if err := os.MkdirAll(exeDir, 0755); err != nil {
		t.Fatal(err)
	}
	writeTestDirFiles(t, filepath.Join(exeDir, "ui-dist", "terminal"), map[string]string{
		"index.html": "<html>stale-v1.1.2-ui-dist</html>",
	})

	embeddedFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>older-v1.1.15-embedded</html>")},
	}
	otaFiles := map[string]string{
		"index.html": "<html>newer-v1.1.16-ota-cache</html>",
	}
	zipBytes, zipSHA, treeSHA := buildTestUIZip(t, otaFiles)
	pubHex, manifestJSON := signTestOTAManifest(t, map[string]*rtx5tcp.OTAAppArtifact{
		"terminal": {
			AppKey:       "terminal",
			Version:      "1.1.16",
			UIZipFile:    "terminal-ui-dist.zip",
			UISHA256:     zipSHA,
			UISize:       int64(len(zipBytes)),
			UITreeSHA256: treeSHA,
		},
	})

	srv := &WebTerminalServer{
		exeDir:       exeDir,
		masterPubHex: pubHex,
		distRoot:     embeddedFS,
		otaFetcher: func(otaPath string, _ time.Duration) ([]byte, int, error) {
			if strings.HasPrefix(otaPath, "/ota/manifest") {
				return manifestJSON, http.StatusOK, nil
			}
			if otaPath == "/ota/files/terminal-ui-dist.zip" {
				return zipBytes, http.StatusOK, nil
			}
			t.Fatalf("unexpected otaPath %s", otaPath)
			return nil, 0, nil
		},
	}
	srv.initHotUIOTAState()

	if err := srv.syncHotUIOTA(); err != nil {
		t.Fatalf("syncHotUIOTA failed: %v", err)
	}
	if src := srv.getOTAStatusSnapshotForApp("terminal")["ui_source"]; src != "ota-hot-cache" {
		t.Fatalf("expected ui_source=ota-hot-cache, got %v", src)
	}
	got := readFSIndex(t, srv.getActiveDistFSForApp("terminal"))
	if got != "<html>newer-v1.1.16-ota-cache</html>" {
		t.Fatalf("expected newer OTA cache index.html, got %q", got)
	}
}

func TestGetActiveDistFS_VerifiedUIDistServedWhenMatchingOTA(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "rtx5-web-suite")
	if err := os.MkdirAll(exeDir, 0755); err != nil {
		t.Fatal(err)
	}
	uiDistFiles := map[string]string{
		"index.html": "<html>verified-v1.1.16-ui-dist</html>",
	}
	writeTestDirFiles(t, filepath.Join(exeDir, "ui-dist", "terminal"), uiDistFiles)
	zipBytes, zipSHA, treeSHA := buildTestUIZip(t, uiDistFiles)
	pubHex, manifestJSON := signTestOTAManifest(t, map[string]*rtx5tcp.OTAAppArtifact{
		"terminal": {
			AppKey:       "terminal",
			Version:      "1.1.16",
			UIZipFile:    "terminal-ui-dist.zip",
			UISHA256:     zipSHA,
			UISize:       int64(len(zipBytes)),
			UITreeSHA256: treeSHA,
		},
	})

	srv := &WebTerminalServer{
		exeDir:       exeDir,
		masterPubHex: pubHex,
		distRoot: fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("<html>older-v1.1.15-embedded</html>")},
		},
		otaFetcher: func(otaPath string, _ time.Duration) ([]byte, int, error) {
			if strings.HasPrefix(otaPath, "/ota/manifest") {
				return manifestJSON, http.StatusOK, nil
			}
			t.Fatalf("unexpected download when ui-dist matches OTA: %s", otaPath)
			return nil, 0, nil
		},
	}
	srv.initHotUIOTAState()

	if err := srv.syncHotUIOTA(); err != nil {
		t.Fatalf("syncHotUIOTA failed: %v", err)
	}
	if src := srv.getOTAStatusSnapshotForApp("terminal")["ui_source"]; src != "ui-dist" {
		t.Fatalf("expected ui_source=ui-dist, got %v", src)
	}
	got := readFSIndex(t, srv.getActiveDistFSForApp("terminal"))
	if got != "<html>verified-v1.1.16-ui-dist</html>" {
		t.Fatalf("expected verified ui-dist index.html, got %q", got)
	}
}

func TestGetActiveDistFS_LocalUIOnlyStillPrefersUIDist(t *testing.T) {
	root := t.TempDir()
	exeDir := filepath.Join(root, "rtx5-web-suite")
	if err := os.MkdirAll(exeDir, 0755); err != nil {
		t.Fatal(err)
	}
	writeTestDirFiles(t, filepath.Join(exeDir, "ui-cache", "terminal"), map[string]string{
		"index.html": "<html>ota-cache-ignored-in-local</html>",
	})
	writeTestDirFiles(t, filepath.Join(exeDir, "ui-dist", "terminal"), map[string]string{
		"index.html": "<html>local-dev-ui-dist</html>",
	})

	srv := &WebTerminalServer{
		exeDir:      exeDir,
		localUIOnly: true,
		distRoot: fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("<html>embedded</html>")},
		},
	}
	srv.initHotUIOTAState()

	got := readFSIndex(t, srv.getActiveDistFSForApp("terminal"))
	if got != "<html>local-dev-ui-dist</html>" {
		t.Fatalf("expected localUIOnly to serve ui-dist, got %q", got)
	}
}
