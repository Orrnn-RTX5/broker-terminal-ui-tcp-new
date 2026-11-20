package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

const (
	webSuiteBinaryOTAKey       = "web-terminal-linux"
	webSuiteBinaryMaxBytes     = 64 * 1024 * 1024 // 64 MiB safety cap
	webSuiteBinaryFailCooldown = 5 * time.Minute
)

// minWebSuiteBinaryBytes is overridable in unit tests so small synthetic ELF64 binaries can be exercised.
var minWebSuiteBinaryBytes = 1024 * 1024 // 1 MiB minimum for real Go server binary

type webSuiteBinaryOTAMarker struct {
	ZipSHA256     string `json:"zip_sha256"`
	TreeSHA256    string `json:"tree_sha256"`
	BinarySHA256  string `json:"binary_sha256"`
	Version       string `json:"version,omitempty"`
	ReleaseID     string `json:"release_id,omitempty"`
	AppliedAtUnix int64  `json:"applied_at_unix"`
}

func webSuiteBinaryOTADisabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("RTX5_WEB_BINARY_OTA"))) {
	case "0", "false", "off", "no", "disabled":
		return true
	default:
		return false
	}
}

// isValidLinuxAMD64ELF validates ELF64 little-endian x86-64 magic headers and sane binary size bounds.
func isValidLinuxAMD64ELF(data []byte) bool {
	if len(data) < 64 || len(data) < minWebSuiteBinaryBytes || len(data) > webSuiteBinaryMaxBytes {
		return false
	}
	// ELF magic: 0x7f 'E' 'L' 'F'
	if data[0] != 0x7f || data[1] != 'E' || data[2] != 'L' || data[3] != 'F' {
		return false
	}
	// EI_CLASS = 2 (ELFCLASS64), EI_DATA = 1 (ELFDATA2LSB)
	if data[4] != 2 || data[5] != 1 {
		return false
	}
	// e_machine at offset 18..20: 62 (EM_X86_64)
	if binary.LittleEndian.Uint16(data[18:20]) != 62 {
		return false
	}
	return true
}

func findWebSuiteBinaryInStage(stageDir string) (string, error) {
	candidates := []string{
		filepath.Join(stageDir, "server-engines", "rtx5-web-suite"),
		filepath.Join(stageDir, "server-engines", "rtx5-web-terminal-server"),
		filepath.Join(stageDir, "rtx5-web-suite"),
		filepath.Join(stageDir, "rtx5-web-terminal-server"),
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Size() > 0 {
			return p, nil
		}
	}
	return "", errors.New("web-terminal-linux archive does not contain rtx5-web-suite / rtx5-web-terminal-server binary")
}

func readWebSuiteBinaryMarker(markerPath string) (*webSuiteBinaryOTAMarker, error) {
	raw, err := os.ReadFile(markerPath)
	if err != nil {
		return nil, err
	}
	var m webSuiteBinaryOTAMarker
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func writeWebSuiteBinaryMarker(markerPath string, m *webSuiteBinaryOTAMarker) {
	if markerPath == "" || m == nil {
		return
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return
	}
	raw = append(raw, '\n')
	tmp := markerPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0644); err == nil {
		_ = os.Rename(tmp, markerPath)
	}
}

// atomicReplaceLinuxBinary writes newBytes to exePath+".ota.new", fsyncs and re-verifies SHA-256 on disk,
// hardlinks the existing binary to exePath+".ota.bak" as a non-disruptive backup, and atomically replaces exePath.
func atomicReplaceLinuxBinary(exePath string, newBytes []byte, expectedSHA256 string) error {
	if strings.TrimSpace(exePath) == "" {
		return errors.New("empty executable path")
	}
	if !isValidLinuxAMD64ELF(newBytes) {
		return errors.New("payload failed Linux amd64 ELF64 validation")
	}
	tmpPath := exePath + ".ota.new"
	bakPath := exePath + ".ota.bak"
	_ = os.Remove(tmpPath)

	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return fmt.Errorf("stage %s: %w", tmpPath, err)
	}
	if _, werr := f.Write(newBytes); werr != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("write %s: %w", tmpPath, werr)
	}
	if serr := f.Sync(); serr != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("sync %s: %w", tmpPath, serr)
	}
	if cerr := f.Close(); cerr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close %s: %w", tmpPath, cerr)
	}
	if err := os.Chmod(tmpPath, 0755); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("chmod %s: %w", tmpPath, err)
	}

	gotSHA, _, err := rtx5tcp.ComputeFileSHA256(tmpPath)
	if err != nil || !strings.EqualFold(gotSHA, expectedSHA256) {
		_ = os.Remove(tmpPath)
		return errors.New("staged binary failed on-disk SHA-256 verification")
	}

	// Best-effort backup via hardlink so exePath is never absent for even a nanosecond.
	if _, serr := os.Stat(exePath); serr == nil {
		_ = os.Remove(bakPath)
		_ = os.Link(exePath, bakPath)
	}

	if err := os.Rename(tmpPath, exePath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("atomic rename %s -> %s: %w", tmpPath, exePath, err)
	}
	return nil
}

// syncWebSuiteBinaryOTA checks an already Ed25519-verified OTAManifest for a newer web-terminal-linux
// Linux amd64 binary, verifies its ZIP SHA-256, tree SHA-256, and ELF64 x86-64 header, atomically
// replaces the running executable, and triggers a graceful in-place re-exec.
func (c *WebTerminalServer) syncWebSuiteBinaryOTA(manifest *rtx5tcp.OTAManifest, cacheBase string) error {
	if manifest == nil || manifest.Apps == nil {
		return nil
	}
	if !c.binaryOTAForceEnabled && (runtime.GOOS != "linux" || runtime.GOARCH != "amd64") {
		return nil
	}
	if c.localUIOnly || webSuiteBinaryOTADisabled() {
		return nil
	}
	if strings.TrimSpace(c.masterPubHex) == "" {
		return nil
	}
	exePath := strings.TrimSpace(c.exePath)
	if exePath == "" {
		return nil
	}

	art := manifest.Apps[webSuiteBinaryOTAKey]
	if art == nil || strings.TrimSpace(art.UIZipFile) == "" || strings.TrimSpace(art.UISHA256) == "" {
		return nil
	}
	if !rtx5tcp.IsSafeOTAFilename(art.UIZipFile) {
		return fmt.Errorf("unsafe web-terminal-linux filename %q", art.UIZipFile)
	}

	targetZipSHA := strings.ToLower(strings.TrimSpace(art.UISHA256))
	targetTreeSHA := strings.ToLower(strings.TrimSpace(art.UITreeSHA256))

	c.otaMu.RLock()
	bootBinSHA := strings.ToLower(strings.TrimSpace(c.bootBinarySHA256))
	lastFailedSHA := c.lastFailedBinZipSHA
	lastFailedAt := c.lastFailedBinAt
	c.otaMu.RUnlock()

	if bootBinSHA == "" {
		if h, _, herr := rtx5tcp.ComputeFileSHA256(exePath); herr == nil && h != "" {
			bootBinSHA = strings.ToLower(strings.TrimSpace(h))
			c.otaMu.Lock()
			c.bootBinarySHA256 = bootBinSHA
			c.otaMu.Unlock()
		}
	}

	markerPath := filepath.Join(cacheBase, ".web-suite-bin-ota.json")
	if marker, err := readWebSuiteBinaryMarker(markerPath); err == nil && marker != nil {
		if strings.EqualFold(marker.ZipSHA256, targetZipSHA) &&
			(bootBinSHA == "" || strings.EqualFold(marker.BinarySHA256, bootBinSHA)) {
			c.otaMu.Lock()
			if art.Version != "" {
				c.webBinaryVersion = strings.TrimSpace(art.Version)
			}
			c.otaMu.Unlock()
			return nil
		}
	}

	if lastFailedSHA != "" && strings.EqualFold(lastFailedSHA, targetZipSHA) && time.Since(lastFailedAt) < webSuiteBinaryFailCooldown {
		return nil
	}

	recordFailure := func(err error) error {
		c.otaMu.Lock()
		c.lastFailedBinZipSHA = targetZipSHA
		c.lastFailedBinAt = time.Now()
		c.otaMu.Unlock()
		log.Printf("[WEB-OTA-BIN] %v", err)
		return err
	}

	zipBytes, _, dlErr := c.fetchOTARPC("/ota/files/"+art.UIZipFile, 120*time.Second)
	if dlErr != nil {
		return recordFailure(fmt.Errorf("download %s failed: %w", art.UIZipFile, dlErr))
	}
	if verr := rtx5tcp.VerifyOTAFileBytes(zipBytes, targetZipSHA, art.UISize); verr != nil {
		return recordFailure(fmt.Errorf("SHA-256 verification failed for %s: %w", art.UIZipFile, verr))
	}

	stageDir := filepath.Join(cacheBase, fmt.Sprintf(".stage-web-bin-%d", time.Now().UnixNano()))
	defer os.RemoveAll(stageDir)

	if uerr := unpackWebUIZip(zipBytes, stageDir); uerr != nil {
		return recordFailure(fmt.Errorf("extract %s failed: %w", art.UIZipFile, uerr))
	}
	if targetTreeSHA != "" {
		unpackedTree, terr := rtx5tcp.ComputeFSTreeSHA256(os.DirFS(stageDir))
		if terr != nil || !strings.EqualFold(unpackedTree, targetTreeSHA) {
			return recordFailure(fmt.Errorf("tree SHA-256 mismatch for %s (got %s, expected %s)", art.UIZipFile, unpackedTree, targetTreeSHA))
		}
	}

	binPath, ferr := findWebSuiteBinaryInStage(stageDir)
	if ferr != nil {
		return recordFailure(ferr)
	}
	binBytes, rerr := os.ReadFile(binPath)
	if rerr != nil {
		return recordFailure(fmt.Errorf("read staged binary %s: %w", binPath, rerr))
	}
	if !isValidLinuxAMD64ELF(binBytes) {
		return recordFailure(fmt.Errorf("staged binary %s is not a valid Linux amd64 ELF64 executable (%d bytes)", filepath.Base(binPath), len(binBytes)))
	}

	sum := sha256.Sum256(binBytes)
	newBinSHA := hex.EncodeToString(sum[:])

	marker := &webSuiteBinaryOTAMarker{
		ZipSHA256:     targetZipSHA,
		TreeSHA256:    targetTreeSHA,
		BinarySHA256:  newBinSHA,
		Version:       strings.TrimSpace(art.Version),
		ReleaseID:     strings.TrimSpace(manifest.ReleaseID),
		AppliedAtUnix: time.Now().Unix(),
	}

	if bootBinSHA != "" && strings.EqualFold(newBinSHA, bootBinSHA) {
		writeWebSuiteBinaryMarker(markerPath, marker)
		c.otaMu.Lock()
		if art.Version != "" {
			c.webBinaryVersion = strings.TrimSpace(art.Version)
		}
		c.otaMu.Unlock()
		log.Printf("[WEB-OTA-BIN] Running binary already matches %s (v%s, sha=%.12s); no restart needed", art.UIZipFile, art.Version, newBinSHA)
		return nil
	}

	if rerr := atomicReplaceLinuxBinary(exePath, binBytes, newBinSHA); rerr != nil {
		return recordFailure(fmt.Errorf("replace %s failed: %w", exePath, rerr))
	}

	writeWebSuiteBinaryMarker(markerPath, marker)
	c.otaMu.Lock()
	if art.Version != "" {
		c.webBinaryVersion = strings.TrimSpace(art.Version)
	}
	c.lastFailedBinZipSHA = ""
	c.otaMu.Unlock()

	log.Printf("[WEB-OTA-BIN] Applied Ed25519-verified %s (v%s, release=%s, sha=%.12s -> %.12s); restarting %s...",
		art.UIZipFile, art.Version, manifest.ReleaseID, shortSHA(bootBinSHA), shortSHA(newBinSHA), exePath)

	if c.binaryRestartFn != nil {
		c.binaryRestartFn(exePath)
		return nil
	}
	go c.triggerBinarySelfRestart(exePath)
	return nil
}

func (c *WebTerminalServer) triggerBinarySelfRestart(exePath string) {
	if !c.selfRestarting.CompareAndSwap(false, true) {
		return
	}
	time.Sleep(250 * time.Millisecond)

	c.mu.RLock()
	httpSrv := c.httpSrv
	redirectSrv := c.redirectSrv
	c.mu.RUnlock()

	if redirectSrv != nil {
		_ = redirectSrv.Close()
	}
	if httpSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = httpSrv.Shutdown(ctx)
		cancel()
	}

	if err := execSelfBinary(exePath, os.Args, os.Environ()); err != nil {
		log.Printf("[WEB-OTA-BIN] In-place exec %s failed (%v); exiting non-zero so systemd restarts into updated binary", exePath, err)
		os.Exit(1)
	}
}
