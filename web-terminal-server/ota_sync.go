package main

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
	"path/filepath"
	"strings"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

var allWebAppKeys = []string{"superadmin", "admin", "manager", "terminal"}

func normalizeWebOTAChannel(ch string) string {
	switch strings.ToLower(strings.TrimSpace(ch)) {
	case "alpha":
		return "alpha"
	case "beta", "prerelease", "pre-release":
		return "beta"
	default:
		return "production"
	}
}

func shortSHA(h string) string {
	h = strings.TrimSpace(h)
	if len(h) > 12 {
		return h[:12]
	}
	return h
}

func readTrimmedFile(p string) string {
	raw, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(string(raw)))
}

func hasIndexHTML(dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	st, err := os.Stat(filepath.Join(dir, "index.html"))
	return err == nil && !st.IsDir()
}

// computeCleanDirTreeSHA256 computes rtx5tcp.ComputeFSTreeSHA256 ignoring .ui_sha256 and .tree_sha256 marker files.
func computeCleanDirTreeSHA256(dir string) string {
	if !hasIndexHTML(dir) {
		return ""
	}
	uiSHAPath := filepath.Join(dir, ".ui_sha256")
	treeSHAPath := filepath.Join(dir, ".tree_sha256")
	uiRaw, hasUI := os.ReadFile(uiSHAPath)
	treeRaw, hasTree := os.ReadFile(treeSHAPath)
	if hasUI == nil {
		_ = os.Remove(uiSHAPath)
	}
	if hasTree == nil {
		_ = os.Remove(treeSHAPath)
	}
	defer func() {
		if hasUI == nil {
			_ = os.WriteFile(uiSHAPath, uiRaw, 0644)
		}
		if hasTree == nil {
			_ = os.WriteFile(treeSHAPath, treeRaw, 0644)
		}
	}()
	h, err := rtx5tcp.ComputeFSTreeSHA256(os.DirFS(dir))
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(h))
}

func (c *WebTerminalServer) initHotUIOTAState() {
	c.otaMu.Lock()
	if c.otaChannel == "" {
		c.otaChannel = normalizeWebOTAChannel(os.Getenv("RTX5_OTA_CHANNEL"))
	}
	if c.appVersions == nil {
		c.appVersions = make(map[string]string, 4)
	}
	if c.appTreeSHAs == nil {
		c.appTreeSHAs = make(map[string]string, 4)
	}
	if c.appUISources == nil {
		c.appUISources = make(map[string]string, 4)
	}
	if c.appReloadReady == nil {
		c.appReloadReady = make(map[string]bool, 4)
	}
	c.otaMu.Unlock()

	var termFS fs.FS = c.distRoot
	if c.externalDist != "" && hasIndexHTML(c.externalDist) {
		termFS = os.DirFS(c.externalDist)
	}
	if h, err := rtx5tcp.ComputeFSTreeSHA256(termFS); err == nil && h != "" {
		c.otaMu.Lock()
		c.embeddedTermTreeSHA = strings.ToLower(strings.TrimSpace(h))
		c.appTreeSHAs["terminal"] = c.embeddedTermTreeSHA
		c.appUISources["terminal"] = "embedded"
		c.otaMu.Unlock()
	}

	if exePath := strings.TrimSpace(c.exePath); exePath != "" {
		if h, _, err := rtx5tcp.ComputeFileSHA256(exePath); err == nil && h != "" {
			c.otaMu.Lock()
			c.bootBinarySHA256 = strings.ToLower(strings.TrimSpace(h))
			c.otaMu.Unlock()
		}
	}

	// Read local VERSION file if present
	for _, vp := range []string{
		filepath.Join(c.exeDir, "VERSION"),
		filepath.Join(c.exeDir, "..", "VERSION"),
	} {
		if raw, err := os.ReadFile(vp); err == nil {
			if v := strings.TrimSpace(string(raw)); v != "" {
				c.otaMu.Lock()
				if c.latestOTAVersion == "" {
					c.latestOTAVersion = v
				}
				c.otaMu.Unlock()
				break
			}
		}
	}
}

func (c *WebTerminalServer) getOTAChannel() string {
	c.otaMu.RLock()
	defer c.otaMu.RUnlock()
	if c.otaChannel == "" {
		return "production"
	}
	return c.otaChannel
}

func (c *WebTerminalServer) setOTAChannel(ch string) string {
	norm := normalizeWebOTAChannel(ch)
	c.otaMu.Lock()
	c.otaChannel = norm
	c.otaMu.Unlock()
	return norm
}

func (c *WebTerminalServer) ackUIReloadForApp(appKind string) {
	c.otaMu.Lock()
	if c.appReloadReady != nil {
		c.appReloadReady[appKind] = false
	}
	c.otaMu.Unlock()
}

func (c *WebTerminalServer) getOTAStatusSnapshotForApp(appKind string) map[string]any {
	if appKind == "" {
		appKind = "terminal"
	}
	c.otaMu.RLock()
	ch := c.otaChannel
	if ch == "" {
		ch = "production"
	}
	relID := c.latestOTAReleaseID
	ver := c.appVersions[appKind]
	if ver == "" {
		ver = c.latestOTAVersion
	}
	if ver == "" {
		ver = "2.2.6"
	}
	treeSHA := c.appTreeSHAs[appKind]
	if treeSHA == "" && appKind == "terminal" {
		treeSHA = c.embeddedTermTreeSHA
	}
	uiSrc := c.appUISources[appKind]
	if uiSrc == "" {
		uiSrc = "embedded"
	}
	reloadReady := c.appReloadReady[appKind]
	lastChecked := c.lastOTACheckedUnix
	lastErr := c.lastOTAError
	bootBinSHA := c.bootBinarySHA256
	webBinVer := c.webBinaryVersion
	c.otaMu.RUnlock()

	snap := map[string]any{
		"enabled":            true,
		"channel":            ch,
		"app_key":            appKind,
		"release_id":         relID,
		"version":            ver,
		"up_to_date":         true,
		"ui_source":          uiSrc,
		"active_ui_tree_sha": shortSHA(treeSHA),
		"ui_reload_ready":    reloadReady,
		"exe_restart_ready":  false,
		"last_checked_unix":  lastChecked,
	}
	if bootBinSHA != "" {
		snap["web_suite_binary_sha"] = shortSHA(bootBinSHA)
	}
	if webBinVer != "" {
		snap["web_suite_version"] = webBinVer
	}
	if lastErr != "" {
		snap["last_error"] = lastErr
	}
	return snap
}

func (c *WebTerminalServer) runBackgroundHotUIOTALoop() {
	time.Sleep(2 * time.Second)
	_ = c.syncHotUIOTA()

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		_ = c.syncHotUIOTA()
	}
}

func (c *WebTerminalServer) fetchOTARPC(otaPath string, timeout time.Duration) ([]byte, int, error) {
	if c.otaFetcher != nil {
		return c.otaFetcher(otaPath, timeout)
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if saSess, err := c.getOrDialSessionForApp(nil, "superadmin"); err == nil && saSess != nil {
		status, _, body, rerr := saSess.RoundTripRPC("ota", http.MethodGet, otaPath, nil, nil, timeout)
		if rerr == nil && status == http.StatusOK && len(body) > 0 {
			return body, status, nil
		}
	}
	// OTA bundles are fetched over the server's own (default) broker.
	if def := c.defaultLink(); def != nil {
		if brkSess, err := def.getOrDialSession(); err == nil && brkSess != nil {
			status, _, body, rerr := brkSess.RoundTripRPC("ota", http.MethodGet, otaPath, nil, nil, timeout)
			if rerr == nil && status == http.StatusOK && len(body) > 0 {
				return body, status, nil
			}
		}
	}
	return nil, 0, fmt.Errorf("failed fetching %s over Binary TCP", otaPath)
}

func (c *WebTerminalServer) resolveUICacheBaseDir() string {
	candidates := []string{
		filepath.Join(c.exeDir, "..", "runtime-data", "ui-cache"),
		filepath.Join(c.exeDir, "ui-cache"),
	}
	for _, dir := range candidates {
		if err := os.MkdirAll(dir, 0755); err == nil {
			return dir
		}
	}
	fallback := filepath.Join(os.TempDir(), "rtx5-web-ui-cache")
	_ = os.MkdirAll(fallback, 0755)
	return fallback
}

func (c *WebTerminalServer) checkExistingAppUIMatch(appKey string, targetUISHA string, targetTreeSHA string) (matched bool, source string, matchedTreeSHA string) {
	targetUISHA = strings.ToLower(strings.TrimSpace(targetUISHA))
	targetTreeSHA = strings.ToLower(strings.TrimSpace(targetTreeSHA))

	cacheCandidates := []string{
		filepath.Join(c.exeDir, "..", "runtime-data", "ui-cache", appKey),
		filepath.Join(c.exeDir, "ui-cache", appKey),
	}
	distCandidates := []string{
		filepath.Join(c.exeDir, "..", "ui-dist", appKey),
		filepath.Join(c.exeDir, "ui-dist", appKey),
	}

	dirMatches := func(dir string) bool {
		if !hasIndexHTML(dir) {
			return false
		}
		for _, f := range []string{".ui_sha256", ".ota-ui-sha256"} {
			if got := readTrimmedFile(filepath.Join(dir, f)); got != "" && targetUISHA != "" && strings.EqualFold(got, targetUISHA) {
				return true
			}
		}
		for _, f := range []string{".tree_sha256", ".ota-tree-sha256"} {
			if got := readTrimmedFile(filepath.Join(dir, f)); got != "" && targetTreeSHA != "" && strings.EqualFold(got, targetTreeSHA) {
				return true
			}
		}
		if targetTreeSHA != "" {
			if computed := computeCleanDirTreeSHA256(dir); computed != "" && strings.EqualFold(computed, targetTreeSHA) {
				_ = os.WriteFile(filepath.Join(dir, ".ui_sha256"), []byte(targetUISHA+"\n"), 0644)
				_ = os.WriteFile(filepath.Join(dir, ".tree_sha256"), []byte(targetTreeSHA+"\n"), 0644)
				return true
			}
		}
		return false
	}

	for _, cdir := range cacheCandidates {
		if dirMatches(cdir) {
			return true, "ota-hot-cache", targetTreeSHA
		}
	}

	for _, ddir := range distCandidates {
		if dirMatches(ddir) {
			// Ensure no stale ui-cache directory shadows a newer ui-dist directory
			for _, cdir := range cacheCandidates {
				if hasIndexHTML(cdir) && !dirMatches(cdir) {
					_ = os.RemoveAll(cdir)
				}
			}
			return true, "ui-dist", targetTreeSHA
		}
	}

	if appKey == "terminal" && targetTreeSHA != "" {
		c.otaMu.RLock()
		embSHA := c.embeddedTermTreeSHA
		c.otaMu.RUnlock()
		if embSHA != "" && strings.EqualFold(embSHA, targetTreeSHA) {
			for _, cdir := range cacheCandidates {
				if hasIndexHTML(cdir) && !dirMatches(cdir) {
					_ = os.RemoveAll(cdir)
				}
			}
			return true, "embedded", embSHA
		}
	}

	return false, "", ""
}

func (c *WebTerminalServer) syncHotUIOTA() error {
	if c.localUIOnly {
		return nil // RTX5_WEB_UI_SOURCE=local: serve local ui-dist builds; never pull the production OTA UI
	}
	c.otaSyncMu.Lock()
	defer c.otaSyncMu.Unlock()

	ch := c.getOTAChannel()
	now := time.Now().Unix()

	rawManifest, _, err := c.fetchOTARPC("/ota/manifest?channel="+ch, 20*time.Second)
	if err != nil {
		c.otaMu.Lock()
		c.lastOTACheckedUnix = now
		c.lastOTAError = err.Error()
		c.otaMu.Unlock()
		return err
	}

	var manifest rtx5tcp.OTAManifest
	if err := json.Unmarshal(rawManifest, &manifest); err != nil {
		c.otaMu.Lock()
		c.lastOTACheckedUnix = now
		c.lastOTAError = err.Error()
		c.otaMu.Unlock()
		return err
	}

	if c.masterPubHex != "" {
		if verr := rtx5tcp.VerifyOTAManifest(&manifest, c.masterPubHex); verr != nil {
			c.otaMu.Lock()
			c.lastOTACheckedUnix = now
			c.lastOTAError = verr.Error()
			c.otaMu.Unlock()
			log.Printf("[WEB-OTA-SECURITY] Rejected unverified OTA manifest: %v", verr)
			return verr
		}
	}

	var primaryVersion string
	for _, k := range []string{"terminal", "manager", "admin", "superadmin", "web-terminal-linux", "broker-linux"} {
		if a := manifest.Apps[k]; a != nil && strings.TrimSpace(a.Version) != "" {
			primaryVersion = strings.TrimSpace(a.Version)
			break
		}
	}

	c.otaMu.Lock()
	c.lastOTACheckedUnix = now
	c.lastOTAError = ""
	if manifest.ReleaseID != "" {
		c.latestOTAReleaseID = manifest.ReleaseID
	}
	if primaryVersion != "" {
		c.latestOTAVersion = primaryVersion
	}
	c.otaMu.Unlock()

	cacheBase := c.resolveUICacheBaseDir()

	for _, appKey := range allWebAppKeys {
		art := manifest.Apps[appKey]
		if art == nil || strings.TrimSpace(art.UIZipFile) == "" || strings.TrimSpace(art.UISHA256) == "" {
			continue
		}
		if !rtx5tcp.IsSafeOTAFilename(art.UIZipFile) {
			continue
		}

		targetUISHA := strings.ToLower(strings.TrimSpace(art.UISHA256))
		targetTreeSHA := strings.ToLower(strings.TrimSpace(art.UITreeSHA256))

		if matched, src, tSHA := c.checkExistingAppUIMatch(appKey, targetUISHA, targetTreeSHA); matched {
			c.otaMu.Lock()
			if art.Version != "" {
				c.appVersions[appKey] = strings.TrimSpace(art.Version)
			}
			if tSHA != "" {
				c.appTreeSHAs[appKey] = tSHA
			}
			if src != "" {
				c.appUISources[appKey] = src
			}
			c.otaMu.Unlock()
			continue
		}

		zipBytes, _, dlErr := c.fetchOTARPC("/ota/files/"+art.UIZipFile, 90*time.Second)
		if dlErr != nil {
			log.Printf("[WEB-OTA] Download %s failed: %v", art.UIZipFile, dlErr)
			continue
		}
		if verr := rtx5tcp.VerifyOTAFileBytes(zipBytes, targetUISHA, art.UISize); verr != nil {
			log.Printf("[WEB-OTA] SHA-256 verification failed for %s: %v", art.UIZipFile, verr)
			continue
		}

		stageDir := filepath.Join(cacheBase, fmt.Sprintf(".stage-%s-%d", appKey, time.Now().UnixNano()))
		if uerr := unpackWebUIZip(zipBytes, stageDir); uerr != nil {
			_ = os.RemoveAll(stageDir)
			log.Printf("[WEB-OTA] Extract %s failed: %v", art.UIZipFile, uerr)
			continue
		}

		if targetTreeSHA != "" {
			if unpackedTree, terr := rtx5tcp.ComputeFSTreeSHA256(os.DirFS(stageDir)); terr != nil || !strings.EqualFold(unpackedTree, targetTreeSHA) {
				_ = os.RemoveAll(stageDir)
				log.Printf("[WEB-OTA] Tree SHA-256 mismatch for %s (got %s, expected %s)", appKey, unpackedTree, targetTreeSHA)
				continue
			}
		}

		_ = os.WriteFile(filepath.Join(stageDir, ".ui_sha256"), []byte(targetUISHA+"\n"), 0644)
		_ = os.WriteFile(filepath.Join(stageDir, ".ota-ui-sha256"), []byte(targetUISHA+"\n"), 0644)
		if targetTreeSHA != "" {
			_ = os.WriteFile(filepath.Join(stageDir, ".tree_sha256"), []byte(targetTreeSHA+"\n"), 0644)
			_ = os.WriteFile(filepath.Join(stageDir, ".ota-tree-sha256"), []byte(targetTreeSHA+"\n"), 0644)
		}

		finalDir := filepath.Join(cacheBase, appKey)
		oldDir := filepath.Join(cacheBase, fmt.Sprintf(".old-%s-%d", appKey, time.Now().UnixNano()))
		_ = os.RemoveAll(oldDir)
		if _, serr := os.Stat(finalDir); serr == nil {
			_ = os.Rename(finalDir, oldDir)
		}
		if rerr := os.Rename(stageDir, finalDir); rerr != nil {
			_ = os.RemoveAll(finalDir)
			if rerr2 := os.Rename(stageDir, finalDir); rerr2 != nil {
				_ = os.RemoveAll(stageDir)
				if _, oerr := os.Stat(oldDir); oerr == nil {
					_ = os.Rename(oldDir, finalDir)
				}
				continue
			}
		}
		_ = os.RemoveAll(oldDir)

		c.otaMu.Lock()
		prevSHA := c.appTreeSHAs[appKey]
		if art.Version != "" {
			c.appVersions[appKey] = strings.TrimSpace(art.Version)
		}
		c.appTreeSHAs[appKey] = targetTreeSHA
		c.appUISources[appKey] = "ota-hot-cache"
		if prevSHA != "" && !strings.EqualFold(prevSHA, targetTreeSHA) {
			c.appReloadReady[appKey] = true
		}
		c.otaMu.Unlock()

		log.Printf("[WEB-OTA] Hot-synced %s UI (%s, release=%s, sha=%.12s)", appKey, art.UIZipFile, manifest.ReleaseID, targetUISHA)
	}

	_ = c.syncWebSuiteBinaryOTA(&manifest, cacheBase)

	return nil
}

func unpackWebUIZip(zipBytes []byte, destDir string) error {
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
	const maxTotalBytes = 128 * 1024 * 1024 // 128 MB safety cap

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
