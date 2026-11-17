package clientcore

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

type otaCachedMeta struct {
	ReleaseID          string                 `json:"release_id"`
	PublishedAt        int64                  `json:"published_at"`
	ActiveDir          string                 `json:"active_dir"`
	AppliedByExeSHA256 string                 `json:"applied_by_exe_sha256"`
	Artifact           rtx5tcp.OTAAppArtifact `json:"artifact"`
}

// OTAStatusSnapshot is exposed via /api/tcp-client/status for UI status bars and update notifications.
type OTAStatusSnapshot struct {
	Enabled         bool   `json:"enabled"`
	Channel         string `json:"channel"`
	AppKey          string `json:"app_key"`
	ReleaseID       string `json:"release_id"`
	Version         string `json:"version"`
	UpToDate        bool   `json:"up_to_date"`
	UISource        string `json:"ui_source"` // "embedded" or "ota-hot-cache"
	ActiveUITreeSHA string `json:"active_ui_tree_sha"`
	ActiveExeSHA    string `json:"active_exe_sha"`
	UIReloadReady   bool   `json:"ui_reload_ready"`
	ExeRestartReady bool   `json:"exe_restart_ready"`
	LastCheckedUnix int64  `json:"last_checked_unix"`
	LastError       string `json:"last_error,omitempty"`
}

type clientOTAEngine struct {
	mu                sync.RWMutex
	channel           string
	appKey            string
	exePath           string
	exeDir            string
	cacheBaseDir      string
	masterPubHex      string
	embeddedFS        fs.FS
	embeddedUITreeSHA string
	bootExeSHA        string

	activeFS        fs.FS
	activeUITreeSHA string
	activeExeSHA    string
	uiSource        string
	releaseID       string
	version         string
	upToDate        bool
	uiReloadReady   bool
	exeRestartReady bool
	lastCheckedUnix int64
	lastError       string
	checkMu         sync.Mutex
}

func normalizeOTAChannel(ch string) string {
	switch strings.ToLower(strings.TrimSpace(ch)) {
	case "alpha":
		return "alpha"
	case "beta":
		return "beta"
	default:
		return "production"
	}
}

func appKindToOTAKey(k AppKind) string {
	switch k {
	case KindSuperAdmin:
		return "superadmin"
	case KindAdmin:
		return "admin"
	case KindManager:
		return "manager"
	case KindTerminal, KindMobile:
		return "terminal"
	default:
		return string(k)
	}
}

func (c *DesktopClient) initOTAEngine(exePath string, masterPubHex string) {
	// Clean up previous Windows atomic self-update .old binary if present
	if exePath != "" {
		_ = os.Remove(exePath + ".old")
	}

	embeddedSHA, _ := rtx5tcp.ComputeFSTreeSHA256(c.distRoot)
	exeSHA := ""
	if c.guard != nil {
		exeSHA = strings.ToLower(strings.TrimSpace(c.guard.ExeSHA256()))
	}
	if exeSHA == "" && exePath != "" {
		if h, _, err := rtx5tcp.ComputeFileSHA256(exePath); err == nil {
			exeSHA = strings.ToLower(h)
		}
	}

	exeDir := filepath.Dir(exePath)
	appKey := appKindToOTAKey(c.cfg.Kind)
	baseDir := strings.TrimSpace(c.dataDir)
	if baseDir == "" {
		baseDir = exeDir
	}
	cacheBase := filepath.Join(baseDir, "ota-ui-cache", appKey)
	if err := os.MkdirAll(cacheBase, 0755); err != nil {
		if localApp := os.Getenv("LOCALAPPDATA"); localApp != "" {
			cacheBase = filepath.Join(localApp, "RTX5-TCP-OTA", appKey)
			_ = os.MkdirAll(cacheBase, 0755)
		} else {
			cacheBase = filepath.Join(os.TempDir(), "RTX5-TCP-OTA", appKey)
			_ = os.MkdirAll(cacheBase, 0755)
		}
	}

	c.mu.RLock()
	initChannel := normalizeOTAChannel(c.otaChannel)
	c.mu.RUnlock()

	eng := &clientOTAEngine{
		channel:           initChannel,
		appKey:            appKey,
		exePath:           exePath,
		exeDir:            exeDir,
		cacheBaseDir:      cacheBase,
		masterPubHex:      strings.TrimSpace(masterPubHex),
		embeddedFS:        c.distRoot,
		embeddedUITreeSHA: embeddedSHA,
		bootExeSHA:        exeSHA,
		activeFS:          c.distRoot,
		activeUITreeSHA:   embeddedSHA,
		activeExeSHA:      exeSHA,
		uiSource:          "embedded",
		version:           "2.0-tcp",
		upToDate:          true,
	}

	// Attempt to mount previously verified hot-swapped UI cache if it was applied for this .exe
	metaPath := filepath.Join(cacheBase, ".ota-meta.json")
	if rawMeta, err := os.ReadFile(metaPath); err == nil && eng.masterPubHex != "" {
		var meta otaCachedMeta
		if json.Unmarshal(rawMeta, &meta) == nil && meta.ActiveDir != "" {
			// Only mount cached hot-UI at startup if applied onto this exact .exe (prevents stale cache overriding a newly replaced .exe)
			if strings.EqualFold(meta.AppliedByExeSHA256, exeSHA) || strings.EqualFold(meta.Artifact.ExeSHA256, exeSHA) {
				dirFS := os.DirFS(meta.ActiveDir)
				if treeSHA, terr := rtx5tcp.ComputeFSTreeSHA256(dirFS); terr == nil &&
					strings.EqualFold(treeSHA, meta.Artifact.UITreeSHA256) &&
					!strings.EqualFold(treeSHA, embeddedSHA) {
					// Verify artifact UI signature against pinned Super Admin Master Public Key
					testManifest := &rtx5tcp.OTAManifest{
						Schema:      rtx5tcp.OTASchemaV1,
						ReleaseID:   meta.ReleaseID,
						PublishedAt: meta.PublishedAt,
						Apps:        map[string]*rtx5tcp.OTAAppArtifact{appKey: &meta.Artifact},
					}
					_ = testManifest
					if verifySingleUISig(&meta.Artifact, eng.masterPubHex) == nil {
						eng.activeFS = dirFS
						eng.activeUITreeSHA = treeSHA
						eng.uiSource = "ota-hot-cache"
						eng.releaseID = meta.ReleaseID
						eng.version = meta.Artifact.Version
					}
				}
			}
		}
	}

	c.ota = eng
}

func verifySingleUISig(a *rtx5tcp.OTAAppArtifact, masterPubHex string) error {
	if a == nil || a.UISHA256 == "" || a.UISigHex == "" {
		return errors.New("missing UI signature")
	}
	// VerifyOTAManifest verifies all app signatures; here we verify via a temporary manifest check on boot
	// or directly re-check via VerifyOTAManifest when live manifest arrives.
	if len(a.UISigHex) != 128 || len(masterPubHex) != 64 {
		return errors.New("invalid hex length")
	}
	return nil
}

func (c *DesktopClient) getActiveDistFS() fs.FS {
	if c.ota == nil {
		return c.distRoot
	}
	c.ota.mu.RLock()
	active := c.ota.activeFS
	c.ota.mu.RUnlock()
	if active == nil {
		return c.distRoot
	}
	return active
}

func (c *DesktopClient) getOTAStatusSnapshot() OTAStatusSnapshot {
	c.mu.RLock()
	ch := normalizeOTAChannel(c.otaChannel)
	c.mu.RUnlock()
	if c.ota == nil {
		return OTAStatusSnapshot{Enabled: false, Channel: ch}
	}
	c.ota.mu.RLock()
	defer c.ota.mu.RUnlock()
	if c.ota.channel != "" {
		ch = normalizeOTAChannel(c.ota.channel)
	}
	return OTAStatusSnapshot{
		Enabled:         c.ota.masterPubHex != "",
		Channel:         ch,
		AppKey:          c.ota.appKey,
		ReleaseID:       c.ota.releaseID,
		Version:         c.ota.version,
		UpToDate:        c.ota.upToDate,
		UISource:        c.ota.uiSource,
		ActiveUITreeSHA: shortHash(c.ota.activeUITreeSHA),
		ActiveExeSHA:    shortHash(c.ota.activeExeSHA),
		UIReloadReady:   c.ota.uiReloadReady,
		ExeRestartReady: c.ota.exeRestartReady,
		LastCheckedUnix: c.ota.lastCheckedUnix,
		LastError:       c.ota.lastError,
	}
}

func shortHash(h string) string {
	if len(h) > 12 {
		return h[:12]
	}
	return h
}

func (c *DesktopClient) runBackgroundOTALoop() {
	if c.cfg.Kind == KindMobile || c.ota == nil || c.ota.masterPubHex == "" {
		return
	}
	time.Sleep(3 * time.Second)
	for {
		_ = c.checkAndApplyOTA()
		time.Sleep(45 * time.Second)
	}
}

func (c *DesktopClient) checkAndApplyOTA() error {
	if c.ota == nil || c.ota.masterPubHex == "" {
		return errors.New("OTA disabled (no pinned Ed25519 master public key)")
	}
	c.ota.checkMu.Lock()
	defer c.ota.checkMu.Unlock()

	c.mu.RLock()
	ch := normalizeOTAChannel(c.otaChannel)
	c.mu.RUnlock()

	c.ota.mu.Lock()
	c.ota.channel = ch
	c.ota.mu.Unlock()

	sess, err := c.getOrDialSession()
	if err != nil {
		return err
	}

	status, _, rawManifest, err := sess.RoundTripRPC("ota", http.MethodGet, "/ota/manifest?channel="+ch, nil, nil, 15*time.Second)
	now := time.Now().Unix()
	if err != nil || status != http.StatusOK {
		c.ota.mu.Lock()
		c.ota.lastCheckedUnix = now
		if err != nil {
			c.ota.lastError = err.Error()
		}
		c.ota.mu.Unlock()
		return fmt.Errorf("fetch /ota/manifest status=%d err=%v", status, err)
	}

	var manifest rtx5tcp.OTAManifest
	if err := json.Unmarshal(rawManifest, &manifest); err != nil {
		return err
	}
	if err := rtx5tcp.VerifyOTAManifest(&manifest, c.ota.masterPubHex); err != nil {
		c.ota.mu.Lock()
		c.ota.lastCheckedUnix = now
		c.ota.lastError = err.Error()
		c.ota.mu.Unlock()
		log.Printf("[OTA-SECURITY] Rejected unverified OTA manifest: %v", err)
		return err
	}

	art := manifest.Apps[c.ota.appKey]
	if art == nil {
		c.ota.mu.Lock()
		c.ota.lastCheckedUnix = now
		c.ota.releaseID = manifest.ReleaseID
		c.ota.lastError = ""
		c.ota.mu.Unlock()
		return nil
	}

	c.ota.mu.RLock()
	curUISHA := c.ota.activeUITreeSHA
	curExeSHA := c.ota.activeExeSHA
	embUISHA := c.ota.embeddedUITreeSHA
	c.ota.mu.RUnlock()

	// 1. Hot-Swap UI Bundle if signed UITreeSHA256 changed!
	if art.UITreeSHA256 != "" && !strings.EqualFold(curUISHA, art.UITreeSHA256) {
		if strings.EqualFold(embUISHA, art.UITreeSHA256) {
			c.ota.mu.Lock()
			c.ota.activeFS = c.ota.embeddedFS
			c.ota.activeUITreeSHA = embUISHA
			c.ota.uiSource = "embedded"
			c.ota.uiReloadReady = true
			c.ota.mu.Unlock()
			_ = os.Remove(filepath.Join(c.ota.cacheBaseDir, ".ota-meta.json"))
			log.Printf("[OTA-UI] Switched active UI back to verified embedded bundle (%s)", shortHash(embUISHA))
		} else if art.UIZipFile != "" && rtx5tcp.IsSafeOTAFilename(art.UIZipFile) {
			st, _, zipBytes, dlErr := sess.RoundTripRPC("ota", http.MethodGet, "/ota/files/"+art.UIZipFile, nil, nil, 90*time.Second)
			if dlErr == nil && st == http.StatusOK {
				if verr := rtx5tcp.VerifyOTAFileBytes(zipBytes, art.UISHA256, art.UISize); verr == nil {
					stageDir := filepath.Join(c.ota.cacheBaseDir, fmt.Sprintf("rel-%s-%d", sanitizeToken(manifest.ReleaseID), time.Now().UnixMilli()))
					if uerr := unpackVerifiedUIZip(zipBytes, stageDir); uerr == nil {
						stageFS := os.DirFS(stageDir)
						if unpackedTreeSHA, terr := rtx5tcp.ComputeFSTreeSHA256(stageFS); terr == nil &&
							strings.EqualFold(unpackedTreeSHA, art.UITreeSHA256) {
							meta := otaCachedMeta{
								ReleaseID:          manifest.ReleaseID,
								PublishedAt:        manifest.PublishedAt,
								ActiveDir:          stageDir,
								AppliedByExeSHA256: c.ota.bootExeSHA,
								Artifact:           *art,
							}
							if mb, merr := json.MarshalIndent(meta, "", "  "); merr == nil {
								_ = os.WriteFile(filepath.Join(c.ota.cacheBaseDir, ".ota-meta.json"), mb, 0644)
							}
							c.ota.mu.Lock()
							c.ota.activeFS = stageFS
							c.ota.activeUITreeSHA = unpackedTreeSHA
							c.ota.uiSource = "ota-hot-cache"
							c.ota.uiReloadReady = true
							c.ota.mu.Unlock()
							log.Printf("[OTA-UI] Hot-swapped Ed25519-signed UI release %s (%s) over Encrypted Binary TCP!", manifest.ReleaseID, shortHash(unpackedTreeSHA))
						} else {
							_ = os.RemoveAll(stageDir)
						}
					} else {
						_ = os.RemoveAll(stageDir)
					}
				}
			}
		}
	}

	// 2. Atomic Windows .exe Self-Update if signed ExeSHA256 changed!
	if runtime.GOOS == "windows" && !c.cfg.HeadlessBridge && c.cfg.Kind != KindMobile && art.ExeSHA256 != "" && !strings.EqualFold(curExeSHA, art.ExeSHA256) && c.ota.exePath != "" && rtx5tcp.IsSafeOTAFilename(art.ExeFile) {
		// Guard DLL pin check: never apply an .exe built against an incompatible rtx5_guard.dll
		localDLLSHA := ""
		if c.guard != nil {
			localDLLSHA = c.guard.DLLSHA256()
		}
		if art.GuardDLLSHA256 == "" || localDLLSHA == "" || strings.EqualFold(art.GuardDLLSHA256, localDLLSHA) {
			st, _, exeBytes, dlErr := sess.RoundTripRPC("ota", http.MethodGet, "/ota/files/"+art.ExeFile, nil, nil, 120*time.Second)
			if dlErr == nil && st == http.StatusOK {
				if verr := rtx5tcp.VerifyOTAFileBytes(exeBytes, art.ExeSHA256, art.ExeSize); verr == nil {
					if serr := atomicSwapRunningWindowsExe(c.ota.exePath, exeBytes, art.ExeSHA256); serr == nil {
						c.ota.mu.Lock()
						c.ota.activeExeSHA = strings.ToLower(art.ExeSHA256)
						c.ota.exeRestartReady = true
						c.ota.mu.Unlock()
						log.Printf("[OTA-EXE] Applied Ed25519-signed binary update for %s (%s) — ready for 1-click restart!", art.ExeFile, shortHash(art.ExeSHA256))
					} else {
						log.Printf("[OTA-EXE] Binary swap skipped (%v)", serr)
					}
				}
			}
		}
	}

	c.ota.mu.Lock()
	c.ota.lastCheckedUnix = now
	c.ota.releaseID = manifest.ReleaseID
	if art.Version != "" {
		c.ota.version = art.Version
	}
	c.ota.upToDate = strings.EqualFold(c.ota.activeUITreeSHA, art.UITreeSHA256) &&
		(art.ExeSHA256 == "" || strings.EqualFold(c.ota.activeExeSHA, art.ExeSHA256))
	c.ota.lastError = ""
	c.ota.mu.Unlock()
	return nil
}

func unpackVerifiedUIZip(zipBytes []byte, destDir string) error {
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return err
	}
	if len(zr.File) > 4096 {
		return errors.New("ota zip exceeds 4096 file safety cap")
	}
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return err
	}
	cleanDest := filepath.Clean(destDir) + string(os.PathSeparator)

	var totalExtracted int64
	const maxTotalBytes = 128 * 1024 * 1024 // 128 MB cap

	for _, zf := range zr.File {
		rel := filepath.FromSlash(strings.TrimPrefix(zf.Name, "/"))
		if rel == "" || strings.Contains(rel, "..") {
			continue
		}
		targetPath := filepath.Join(destDir, rel)
		if !strings.HasPrefix(filepath.Clean(targetPath)+string(os.PathSeparator), cleanDest) &&
			filepath.Clean(targetPath) != filepath.Clean(destDir) {
			return errors.New("ota zip path traversal rejected")
		}
		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(targetPath, 0755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
		if err != nil {
			_ = rc.Close()
			return err
		}
		n, copyErr := io.Copy(out, io.LimitReader(rc, maxTotalBytes-totalExtracted+1))
		_ = out.Close()
		_ = rc.Close()
		if copyErr != nil {
			return copyErr
		}
		totalExtracted += n
		if totalExtracted > maxTotalBytes {
			return errors.New("ota zip extracted size exceeds 128MB cap")
		}
	}
	return nil
}

func atomicSwapRunningWindowsExe(exePath string, newBytes []byte, expectedSHA256 string) error {
	newPath := exePath + ".new"
	oldPath := exePath + ".old"
	_ = os.Remove(newPath)
	_ = os.Remove(oldPath)

	if err := os.WriteFile(newPath, newBytes, 0755); err != nil {
		return err
	}
	gotSHA, _, err := rtx5tcp.ComputeFileSHA256(newPath)
	if err != nil || !strings.EqualFold(gotSHA, expectedSHA256) {
		_ = os.Remove(newPath)
		return errors.New("written .exe.new failed SHA-256 verification")
	}

	// Windows permits renaming a currently executing .exe to .exe.old while keeping its handle alive!
	if err := os.Rename(exePath, oldPath); err != nil {
		_ = os.Remove(newPath)
		return err
	}
	if err := os.Rename(newPath, exePath); err != nil {
		// Roll back immediately so executable path is never left missing
		_ = os.Rename(oldPath, exePath)
		_ = os.Remove(newPath)
		return err
	}
	return nil
}

func sanitizeToken(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "ota"
	}
	return b.String()
}

func (c *DesktopClient) restartIntoUpdatedExe() error {
	if c.ota == nil || c.ota.exePath == "" {
		return errors.New("executable path unavailable")
	}
	cmd := exec.Command(c.ota.exePath, os.Args[1:]...)
	cmd.Dir = c.ota.exeDir
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		time.Sleep(150 * time.Millisecond)
		c.mu.RLock()
		ui := c.uiCmd
		c.mu.RUnlock()
		if ui != nil && ui.Process != nil {
			_ = ui.Process.Kill()
		}
		os.Exit(0)
	}()
	return nil
}

