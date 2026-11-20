package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func makeSyntheticLinuxAMD64ELF(payloadTag string) []byte {
	buf := make([]byte, 256)
	buf[0] = 0x7f
	buf[1] = 'E'
	buf[2] = 'L'
	buf[3] = 'F'
	buf[4] = 2 // ELFCLASS64
	buf[5] = 1 // ELFDATA2LSB
	buf[6] = 1 // EV_CURRENT
	binary.LittleEndian.PutUint16(buf[16:18], 2)  // ET_EXEC
	binary.LittleEndian.PutUint16(buf[18:20], 62) // EM_X86_64
	copy(buf[64:], []byte(payloadTag))
	return buf
}

func makeSignedWebTerminalLinuxZipAndManifest(t *testing.T, relPath string, binBytes []byte, version string) (pubHex string, manifest *rtx5tcp.OTAManifest, zipBytes []byte) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	pubHex = hex.EncodeToString(pub)
	privHex := hex.EncodeToString(priv)

	stageDir := t.TempDir()
	fullPath := filepath.Join(stageDir, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		t.Fatalf("mkdir stage: %v", err)
	}
	if err := os.WriteFile(fullPath, binBytes, 0755); err != nil {
		t.Fatalf("write bin: %v", err)
	}
	treeSHA, err := rtx5tcp.ComputeFSTreeSHA256(os.DirFS(stageDir))
	if err != nil {
		t.Fatalf("compute tree sha: %v", err)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fw, err := zw.Create(relPath)
	if err != nil {
		t.Fatalf("zip create: %v", err)
	}
	if _, err := fw.Write(binBytes); err != nil {
		t.Fatalf("zip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	zipBytes = buf.Bytes()
	zipSum := sha256.Sum256(zipBytes)
	zipSHA := hex.EncodeToString(zipSum[:])

	manifest = &rtx5tcp.OTAManifest{
		Schema:      rtx5tcp.OTASchemaV1,
		Channel:     rtx5tcp.OTAChannelProduction,
		ReleaseID:   "rtx5-tcp-ota-test-1",
		PublishedAt: time.Now().Unix(),
		Apps: map[string]*rtx5tcp.OTAAppArtifact{
			webSuiteBinaryOTAKey: {
				AppKey:       webSuiteBinaryOTAKey,
				AppName:      "RTX5 Binary TCP Web Terminal Linux Server (:8443)",
				Version:      version,
				UITreeSHA256: treeSHA,
				UIZipFile:    "web-terminal-linux.zip",
				UISHA256:     zipSHA,
				UISize:       int64(len(zipBytes)),
			},
		},
	}
	if err := rtx5tcp.SignOTAManifest(manifest, privHex); err != nil {
		t.Fatalf("sign manifest: %v", err)
	}
	if err := rtx5tcp.VerifyOTAManifest(manifest, pubHex); err != nil {
		t.Fatalf("verify manifest: %v", err)
	}
	return pubHex, manifest, zipBytes
}

func TestLoadAuthorityMasterPubHexFallsBackToEmbedded(t *testing.T) {
	emptyDir := t.TempDir()
	got := loadAuthorityMasterPubHex(emptyDir)
	if len(got) != 64 {
		t.Fatalf("expected 64-char embedded Ed25519 pub hex, got %q", got)
	}
	if !strings.EqualFold(got, "9ec6b8fb27c17e628021948ecd3755a1328d0d21edd220b366a3013a835e4b3f") {
		t.Fatalf("unexpected embedded master pub hex: %s", got)
	}
}

func TestIsValidLinuxAMD64ELF(t *testing.T) {
	origMin := minWebSuiteBinaryBytes
	minWebSuiteBinaryBytes = 64
	defer func() { minWebSuiteBinaryBytes = origMin }()

	valid := makeSyntheticLinuxAMD64ELF("v1.1.9")
	if !isValidLinuxAMD64ELF(valid) {
		t.Fatal("expected valid Linux amd64 ELF64 to pass")
	}

	// Wrong machine (ARM64 = 183)
	arm64 := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint16(arm64[18:20], 183)
	if isValidLinuxAMD64ELF(arm64) {
		t.Fatal("expected ARM64 ELF to be rejected")
	}

	// Windows PE header
	pe := make([]byte, 256)
	pe[0], pe[1] = 'M', 'Z'
	if isValidLinuxAMD64ELF(pe) {
		t.Fatal("expected Windows PE binary to be rejected")
	}

	// Truncated
	if isValidLinuxAMD64ELF(valid[:32]) {
		t.Fatal("expected truncated binary to be rejected")
	}
}

func TestSyncWebSuiteBinaryOTAAppliesVerifiedUpdateAndSkipsDuplicates(t *testing.T) {
	origMin := minWebSuiteBinaryBytes
	minWebSuiteBinaryBytes = 64
	defer func() { minWebSuiteBinaryBytes = origMin }()

	workDir := t.TempDir()
	cacheDir := filepath.Join(workDir, "ui-cache")
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		t.Fatal(err)
	}
	exePath := filepath.Join(workDir, "rtx5-web-suite")
	oldBin := makeSyntheticLinuxAMD64ELF("old-v1.1.7")
	newBin := makeSyntheticLinuxAMD64ELF("new-v1.1.9")
	if err := os.WriteFile(exePath, oldBin, 0755); err != nil {
		t.Fatal(err)
	}

	pubHex, manifest, zipBytes := makeSignedWebTerminalLinuxZipAndManifest(t, "server-engines/rtx5-web-terminal-server", newBin, "1.1.9")

	downloads := 0
	restarts := 0
	var restartedPath string

	srv := &WebTerminalServer{
		exePath:               exePath,
		exeDir:                workDir,
		masterPubHex:          pubHex,
		binaryOTAForceEnabled: true,
		otaFetcher: func(otaPath string, _ time.Duration) ([]byte, int, error) {
			if otaPath == "/ota/files/web-terminal-linux.zip" {
				downloads++
				return zipBytes, http.StatusOK, nil
			}
			return nil, http.StatusNotFound, os.ErrNotExist
		},
		binaryRestartFn: func(p string) {
			restarts++
			restartedPath = p
		},
	}

	if err := srv.syncWebSuiteBinaryOTA(manifest, cacheDir); err != nil {
		t.Fatalf("syncWebSuiteBinaryOTA failed: %v", err)
	}
	if downloads != 1 || restarts != 1 || restartedPath != exePath {
		t.Fatalf("unexpected counts downloads=%d restarts=%d path=%q", downloads, restarts, restartedPath)
	}

	gotBytes, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("read replaced binary: %v", err)
	}
	if !bytes.Equal(gotBytes, newBin) {
		t.Fatal("executable on disk was not atomically replaced with new binary")
	}

	bakBytes, err := os.ReadFile(exePath + ".ota.bak")
	if err != nil || !bytes.Equal(bakBytes, oldBin) {
		t.Fatalf("expected .ota.bak backup of old binary, err=%v", err)
	}

	// Simulate post-restart process with bootBinarySHA256 equal to newBin: should skip with 0 downloads & 0 restarts.
	newSum := sha256.Sum256(newBin)
	srv.bootBinarySHA256 = hex.EncodeToString(newSum[:])
	if err := srv.syncWebSuiteBinaryOTA(manifest, cacheDir); err != nil {
		t.Fatalf("second sync failed: %v", err)
	}
	if downloads != 1 || restarts != 1 {
		t.Fatalf("expected 0 extra downloads/restarts after marker match, got downloads=%d restarts=%d", downloads, restarts)
	}

	// Verify marker contents
	rawMarker, err := os.ReadFile(filepath.Join(cacheDir, ".web-suite-bin-ota.json"))
	if err != nil {
		t.Fatalf("missing marker file: %v", err)
	}
	var marker webSuiteBinaryOTAMarker
	if err := json.Unmarshal(rawMarker, &marker); err != nil {
		t.Fatalf("unmarshal marker: %v", err)
	}
	if marker.Version != "1.1.9" || !strings.EqualFold(marker.BinarySHA256, hex.EncodeToString(newSum[:])) {
		t.Fatalf("unexpected marker: %+v", marker)
	}
}

func TestSyncWebSuiteBinaryOTASkipsRestartWhenRunningSameBinary(t *testing.T) {
	origMin := minWebSuiteBinaryBytes
	minWebSuiteBinaryBytes = 64
	defer func() { minWebSuiteBinaryBytes = origMin }()

	workDir := t.TempDir()
	cacheDir := filepath.Join(workDir, "ui-cache")
	_ = os.MkdirAll(cacheDir, 0755)
	exePath := filepath.Join(workDir, "rtx5-web-suite")
	sameBin := makeSyntheticLinuxAMD64ELF("same-v1.1.9")
	_ = os.WriteFile(exePath, sameBin, 0755)

	pubHex, manifest, zipBytes := makeSignedWebTerminalLinuxZipAndManifest(t, "server-engines/rtx5-web-terminal-server", sameBin, "1.1.9")

	restarts := 0
	srv := &WebTerminalServer{
		exePath:               exePath,
		exeDir:                workDir,
		masterPubHex:          pubHex,
		binaryOTAForceEnabled: true,
		otaFetcher: func(otaPath string, _ time.Duration) ([]byte, int, error) {
			return zipBytes, http.StatusOK, nil
		},
		binaryRestartFn: func(string) { restarts++ },
	}

	if err := srv.syncWebSuiteBinaryOTA(manifest, cacheDir); err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if restarts != 0 {
		t.Fatalf("expected 0 restarts when already running identical binary, got %d", restarts)
	}
}

func TestSyncWebSuiteBinaryOTARejectsCorruptZipOrNonELF(t *testing.T) {
	origMin := minWebSuiteBinaryBytes
	minWebSuiteBinaryBytes = 64
	defer func() { minWebSuiteBinaryBytes = origMin }()

	t.Run("tampered zip bytes", func(t *testing.T) {
		workDir := t.TempDir()
		cacheDir := filepath.Join(workDir, "ui-cache")
		_ = os.MkdirAll(cacheDir, 0755)
		exePath := filepath.Join(workDir, "rtx5-web-suite")
		oldBin := makeSyntheticLinuxAMD64ELF("old-safe")
		_ = os.WriteFile(exePath, oldBin, 0755)

		pubHex, manifest, zipBytes := makeSignedWebTerminalLinuxZipAndManifest(t, "server-engines/rtx5-web-terminal-server", makeSyntheticLinuxAMD64ELF("new-v2"), "1.1.9")
		corrupt := append([]byte(nil), zipBytes...)
		corrupt[len(corrupt)-1] ^= 0xff

		restarts := 0
		srv := &WebTerminalServer{
			exePath:               exePath,
			exeDir:                workDir,
			masterPubHex:          pubHex,
			binaryOTAForceEnabled: true,
			otaFetcher: func(string, time.Duration) ([]byte, int, error) {
				return corrupt, http.StatusOK, nil
			},
			binaryRestartFn: func(string) { restarts++ },
		}

		if err := srv.syncWebSuiteBinaryOTA(manifest, cacheDir); err == nil {
			t.Fatal("expected error for tampered zip bytes")
		}
		if restarts != 0 {
			t.Fatal("must not restart on corrupt zip")
		}
		got, _ := os.ReadFile(exePath)
		if !bytes.Equal(got, oldBin) {
			t.Fatal("existing binary was modified on corrupt zip")
		}
	})

	t.Run("non-ELF payload inside zip", func(t *testing.T) {
		workDir := t.TempDir()
		cacheDir := filepath.Join(workDir, "ui-cache")
		_ = os.MkdirAll(cacheDir, 0755)
		exePath := filepath.Join(workDir, "rtx5-web-suite")
		oldBin := makeSyntheticLinuxAMD64ELF("old-safe")
		_ = os.WriteFile(exePath, oldBin, 0755)

		notELF := bytes.Repeat([]byte("not-an-elf-binary-"), 16)
		pubHex, manifest, zipBytes := makeSignedWebTerminalLinuxZipAndManifest(t, "server-engines/rtx5-web-terminal-server", notELF, "1.1.9")

		restarts := 0
		srv := &WebTerminalServer{
			exePath:               exePath,
			exeDir:                workDir,
			masterPubHex:          pubHex,
			binaryOTAForceEnabled: true,
			otaFetcher: func(string, time.Duration) ([]byte, int, error) {
				return zipBytes, http.StatusOK, nil
			},
			binaryRestartFn: func(string) { restarts++ },
		}

		if err := srv.syncWebSuiteBinaryOTA(manifest, cacheDir); err == nil {
			t.Fatal("expected error for non-ELF payload")
		}
		if restarts != 0 {
			t.Fatal("must not restart on non-ELF payload")
		}
		got, _ := os.ReadFile(exePath)
		if !bytes.Equal(got, oldBin) {
			t.Fatal("existing binary was modified on non-ELF payload")
		}
	})
}

func TestSyncWebSuiteBinaryOTADisabledGates(t *testing.T) {
	origMin := minWebSuiteBinaryBytes
	minWebSuiteBinaryBytes = 64
	defer func() { minWebSuiteBinaryBytes = origMin }()

	workDir := t.TempDir()
	cacheDir := filepath.Join(workDir, "ui-cache")
	_ = os.MkdirAll(cacheDir, 0755)
	exePath := filepath.Join(workDir, "rtx5-web-suite")
	oldBin := makeSyntheticLinuxAMD64ELF("old")
	_ = os.WriteFile(exePath, oldBin, 0755)
	pubHex, manifest, zipBytes := makeSignedWebTerminalLinuxZipAndManifest(t, "server-engines/rtx5-web-terminal-server", makeSyntheticLinuxAMD64ELF("new"), "1.1.9")

	called := 0
	fetcher := func(string, time.Duration) ([]byte, int, error) {
		called++
		return zipBytes, http.StatusOK, nil
	}

	// 1. localUIOnly disables binary OTA
	srvLocal := &WebTerminalServer{exePath: exePath, masterPubHex: pubHex, localUIOnly: true, binaryOTAForceEnabled: true, otaFetcher: fetcher}
	_ = srvLocal.syncWebSuiteBinaryOTA(manifest, cacheDir)

	// 2. Empty masterPubHex disables binary OTA
	srvNoKey := &WebTerminalServer{exePath: exePath, masterPubHex: "", binaryOTAForceEnabled: true, otaFetcher: fetcher}
	_ = srvNoKey.syncWebSuiteBinaryOTA(manifest, cacheDir)

	// 3. RTX5_WEB_BINARY_OTA=false disables binary OTA
	t.Setenv("RTX5_WEB_BINARY_OTA", "false")
	srvEnvOff := &WebTerminalServer{exePath: exePath, masterPubHex: pubHex, binaryOTAForceEnabled: true, otaFetcher: fetcher}
	_ = srvEnvOff.syncWebSuiteBinaryOTA(manifest, cacheDir)

	if called != 0 {
		t.Fatalf("expected 0 fetches when binary OTA is gated off, got %d", called)
	}
}
