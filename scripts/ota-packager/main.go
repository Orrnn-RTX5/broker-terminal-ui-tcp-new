package main

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

type appSpec struct {
	Key        string
	Name       string
	ClientSlug string
	ExeName    string
}

type linuxAppSpec struct {
	Key     string
	Name    string
	RelDir  string
	SubDirs []string
	ZipName string
}

func zipDirectoryDeterministic(srcDir string, outZipPath string) error {
	var relFiles []string
	err := filepath.WalkDir(srcDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		relSlash := filepath.ToSlash(rel)
		if relSlash == "" || strings.HasPrefix(filepath.Base(relSlash), ".ota-") || (strings.HasPrefix(relSlash, ".") && strings.HasSuffix(relSlash, ".DS_Store")) {
			return nil
		}
		relFiles = append(relFiles, relSlash)
		return nil
	})
	if err != nil {
		return err
	}
	sort.Strings(relFiles)
	return writeDeterministicZipFromRelFiles(srcDir, relFiles, outZipPath)
}

func zipSubdirsDeterministic(baseDir string, subDirs []string, outZipPath string) (string, error) {
	type fileEntry struct {
		rel  string
		hash string
		size int64
	}
	var relFiles []string
	var entries []fileEntry

	for _, sub := range subDirs {
		subRoot := filepath.Join(baseDir, sub)
		info, err := os.Stat(subRoot)
		if err != nil || !info.IsDir() {
			continue
		}
		err = filepath.WalkDir(subRoot, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(baseDir, path)
			if err != nil {
				return err
			}
			relSlash := filepath.ToSlash(rel)
			if relSlash == "" || strings.HasPrefix(filepath.Base(relSlash), ".ota-") || strings.HasSuffix(relSlash, ".DS_Store") {
				return nil
			}
			if filepath.Base(outZipPath) == "broker-linux-backend.zip" && strings.HasPrefix(relSlash, "server-engines/") {
				baseName := filepath.Base(relSlash)
				switch baseName {
				case "broker-tcp-access-server", "rtx5-gateway":
				default:
					return nil
				}
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			h := sha256.New()
			sz, copyErr := io.Copy(h, f)
			_ = f.Close()
			if copyErr != nil {
				return copyErr
			}
			relFiles = append(relFiles, relSlash)
			entries = append(entries, fileEntry{
				rel:  relSlash,
				hash: hex.EncodeToString(h.Sum(nil)),
				size: sz,
			})
			return nil
		})
		if err != nil {
			return "", err
		}
	}

	sort.Strings(relFiles)
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].rel < entries[j].rel
	})

	rootHash := sha256.New()
	rootHash.Write([]byte("RTX5-UI-TREE-V1\n"))
	for _, e := range entries {
		rootHash.Write([]byte(fmt.Sprintf("%s\x00%d\x00%s\n", e.rel, e.size, e.hash)))
	}
	treeSHA := hex.EncodeToString(rootHash.Sum(nil))

	if err := writeDeterministicZipFromRelFiles(baseDir, relFiles, outZipPath); err != nil {
		return "", err
	}
	return treeSHA, nil
}

func writeDeterministicZipFromRelFiles(baseDir string, relFiles []string, outZipPath string) error {
	tmpZip := outZipPath + ".tmp"
	_ = os.Remove(tmpZip)
	f, err := os.Create(tmpZip)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(f)
	fixedTime := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)

	for _, relSlash := range relFiles {
		fullPath := filepath.Join(baseDir, filepath.FromSlash(relSlash))
		info, err := os.Stat(fullPath)
		if err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpZip)
			return err
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpZip)
			return err
		}
		hdr.Name = relSlash
		hdr.Method = zip.Deflate
		hdr.Modified = fixedTime

		w, err := zw.CreateHeader(hdr)
		if err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpZip)
			return err
		}
		in, err := os.Open(fullPath)
		if err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpZip)
			return err
		}
		_, copyErr := io.Copy(w, in)
		_ = in.Close()
		if copyErr != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpZip)
			return copyErr
		}
	}

	if err := zw.Close(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpZip)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpZip)
		return err
	}
	return os.Rename(tmpZip, outZipPath)
}

func copyAtomic(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp := dst + ".tmp"
	_ = os.Remove(tmp)
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func writeBytesAtomic(dst string, data []byte) error {
	tmp := dst + ".tmp"
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func computeFileDigests(path string) (sha512Base64 string, sha256Hex string, size int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", 0, err
	}
	defer f.Close()
	h512 := sha512.New()
	h256 := sha256.New()
	n, err := io.Copy(io.MultiWriter(h512, h256), f)
	if err != nil {
		return "", "", 0, err
	}
	return base64.StdEncoding.EncodeToString(h512.Sum(nil)), hex.EncodeToString(h256.Sum(nil)), n, nil
}

func ymlFilenameForChannel(ch string) string {
	switch rtx5tcp.NormalizeOTAChannel(ch) {
	case rtx5tcp.OTAChannelAlpha:
		return "alpha.yml"
	case rtx5tcp.OTAChannelBeta:
		return "beta.yml"
	default:
		return "latest.yml"
	}
}

func writeChannelReleaseYAML(outDir string, m *rtx5tcp.OTAManifest, channel string) error {
	normCh := rtx5tcp.NormalizeOTAChannel(channel)
	releaseTime := time.Unix(m.PublishedAt, 0).UTC()
	ver := ""

	var appKeys []string
	for k := range m.Apps {
		appKeys = append(appKeys, k)
	}
	sort.Strings(appKeys)

	type ymlFileEntry struct {
		url    string
		sha512 string
		sha256 string
		size   int64
	}
	var files []ymlFileEntry
	seen := make(map[string]bool)

	addArtifactFile := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			return
		}
		p := filepath.Join(outDir, name)
		s512, s256, sz, err := computeFileDigests(p)
		if err != nil {
			return
		}
		seen[name] = true
		files = append(files, ymlFileEntry{
			url:    name,
			sha512: s512,
			sha256: s256,
			size:   sz,
		})
	}

	for _, k := range appKeys {
		a := m.Apps[k]
		if a == nil {
			continue
		}
		if ver == "" && a.Version != "" {
			ver = a.Version
		}
		addArtifactFile(a.ExeFile)
		addArtifactFile(a.UIZipFile)
	}

	primaryURL := "RTX5-Terminal64.exe"
	primarySHA512 := ""
	primarySHA256 := ""
	for _, f := range files {
		if strings.EqualFold(f.url, "RTX5-Terminal64.exe") || primarySHA512 == "" {
			primaryURL = f.url
			primarySHA512 = f.sha512
			primarySHA256 = f.sha256
			if strings.EqualFold(f.url, "RTX5-Terminal64.exe") {
				break
			}
		}
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("version: %s\n", ver))
	sb.WriteString(fmt.Sprintf("releaseName: %s\n", m.ReleaseID))
	sb.WriteString(fmt.Sprintf("releaseDate: '%s'\n", releaseTime.Format(time.RFC3339)))
	sb.WriteString(fmt.Sprintf("channel: %s\n", normCh))
	if primarySHA512 != "" {
		sb.WriteString(fmt.Sprintf("path: %s\n", primaryURL))
		sb.WriteString(fmt.Sprintf("sha512: %s\n", primarySHA512))
		sb.WriteString(fmt.Sprintf("sha256: %s\n", primarySHA256))
	}
	sb.WriteString("files:\n")
	for _, f := range files {
		sb.WriteString(fmt.Sprintf("  - url: %s\n", f.url))
		sb.WriteString(fmt.Sprintf("    sha512: %s\n", f.sha512))
		sb.WriteString(fmt.Sprintf("    sha256: %s\n", f.sha256))
		sb.WriteString(fmt.Sprintf("    size: %d\n", f.size))
	}

	ymlPath := filepath.Join(outDir, ymlFilenameForChannel(normCh))
	return writeBytesAtomic(ymlPath, []byte(sb.String()))
}

func cloneManifestForChannel(base *rtx5tcp.OTAManifest, channel string) *rtx5tcp.OTAManifest {
	normCh := rtx5tcp.NormalizeOTAChannel(channel)
	appsCopy := make(map[string]*rtx5tcp.OTAAppArtifact, len(base.Apps))
	for k, a := range base.Apps {
		if a == nil {
			continue
		}
		// Backend Linux VPS packages (broker-linux, web-terminal-linux) do NOT use Alpha/Beta staging;
		// they are published directly to Production (manifest.json).
		if normCh != rtx5tcp.OTAChannelProduction && (k == "broker-linux" || k == "web-terminal-linux") {
			continue
		}
		cp := *a
		appsCopy[k] = &cp
	}
	return &rtx5tcp.OTAManifest{
		Schema:      base.Schema,
		Channel:     normCh,
		ReleaseID:   base.ReleaseID,
		PublishedAt: base.PublishedAt,
		Apps:        appsCopy,
	}
}

func resolvePushTCPAddr(packagesRoot string, pushTCPFlag string, autoPush bool) string {
	if explicit := strings.TrimSpace(pushTCPFlag); explicit != "" {
		return explicit
	}
	if !autoPush {
		return ""
	}
	cfgPath := filepath.Join(packagesRoot, "1-SUPERADMIN-My-PC-Only", "client-config.json")
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return ""
	}
	var cfg struct {
		SuperAdminTCP string `json:"superadmin_tcp"`
		ServerTCP     string `json:"server_tcp"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return ""
	}
	if addr := strings.TrimSpace(cfg.SuperAdminTCP); addr != "" {
		return addr
	}
	return strings.TrimSpace(cfg.ServerTCP)
}

func collectRemoteOTAHashes(sess *rtx5tcp.MuxSession) (map[string]bool, int, error) {
	remoteHashes := make(map[string]bool)
	status, _, respBody, err := sess.RoundTripRPC("ota", http.MethodGet, "/api/tcp-security/ota/channels", nil, nil, 10*time.Second)
	if err != nil {
		return remoteHashes, status, err
	}

	type remoteAppEntry struct {
		UISHA256  string `json:"ui_sha256"`
		ExeSHA256 string `json:"exe_sha256"`
	}
	type remoteChannelEntry struct {
		Apps map[string]*remoteAppEntry `json:"apps"`
	}
	var parsed struct {
		Channels   map[string]*remoteChannelEntry `json:"channels"`
		Alpha      *remoteChannelEntry            `json:"alpha"`
		Beta       *remoteChannelEntry            `json:"beta"`
		Production *remoteChannelEntry            `json:"production"`
	}

	addFromChannel := func(c *remoteChannelEntry) {
		if c == nil {
			return
		}
		for _, a := range c.Apps {
			if a == nil {
				continue
			}
			if u := strings.ToLower(strings.TrimSpace(a.UISHA256)); len(u) == 64 {
				remoteHashes[u] = true
			}
			if e := strings.ToLower(strings.TrimSpace(a.ExeSHA256)); len(e) == 64 {
				remoteHashes[e] = true
			}
		}
	}

	if status == http.StatusOK && len(respBody) > 0 && json.Unmarshal(respBody, &parsed) == nil {
		for _, c := range parsed.Channels {
			addFromChannel(c)
		}
		addFromChannel(parsed.Alpha)
		addFromChannel(parsed.Beta)
		addFromChannel(parsed.Production)
	}

	if len(remoteHashes) == 0 {
		for _, ch := range []string{"production", "beta", "alpha"} {
			mStatus, _, mBody, mErr := sess.RoundTripRPC("ota", http.MethodGet, "/ota/manifest?channel="+ch, nil, nil, 10*time.Second)
			if mErr == nil && mStatus == http.StatusOK && len(mBody) > 0 {
				var m rtx5tcp.OTAManifest
				if json.Unmarshal(mBody, &m) == nil {
					for _, a := range m.Apps {
						if a == nil {
							continue
						}
						if u := strings.ToLower(strings.TrimSpace(a.UISHA256)); len(u) == 64 {
							remoteHashes[u] = true
						}
						if e := strings.ToLower(strings.TrimSpace(a.ExeSHA256)); len(e) == 64 {
							remoteHashes[e] = true
						}
					}
				}
			}
		}
	}

	return remoteHashes, status, nil
}

func uploadOTAFileOverTCP(sess *rtx5tcp.MuxSession, masterPriv ed25519.PrivateKey, filename string, fileBytes []byte) (int, string, error) {
	sum := sha256.Sum256(fileBytes)
	sha256Hex := strings.ToLower(hex.EncodeToString(sum[:]))
	tsStr := strconv.FormatInt(time.Now().Unix(), 10)
	sigPayload := fmt.Sprintf("RTX5-OTA-UPLOAD-V1|%s|%s|%s", filename, sha256Hex, tsStr)
	sigHex := hex.EncodeToString(ed25519.Sign(masterPriv, []byte(sigPayload)))

	hdrs := map[string][]string{
		"Content-Type":         {"application/octet-stream"},
		"X-RTX5-OTA-Filename":  {filename},
		"X-RTX5-OTA-SHA256":    {sha256Hex},
		"X-RTX5-OTA-Timestamp": {tsStr},
		"X-RTX5-OTA-Signature": {sigHex},
	}

	status, _, respBody, err := sess.RoundTripRPC("ota", http.MethodPost, "/api/tcp-security/ota/upload", hdrs, fileBytes, 180*time.Second)
	if err != nil {
		return status, sha256Hex, err
	}
	if status != http.StatusOK {
		msg := strings.TrimSpace(string(respBody))
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", status)
		}
		return status, sha256Hex, fmt.Errorf("status %d: %s", status, msg)
	}
	return status, sha256Hex, nil
}

func pushOTAReleaseOverBinaryTCP(outDir string, pushAddr string, masterPrivHex string, releaseID string, ver string) {
	pushAddr = strings.TrimSpace(pushAddr)
	if pushAddr == "" {
		return
	}
	privBytes, err := hex.DecodeString(strings.TrimSpace(masterPrivHex))
	if err != nil || len(privBytes) != ed25519.PrivateKeySize {
		fmt.Printf("[OTA-TCP-PUSH] [WARN] Invalid Ed25519 master private key; skipping Binary TCP push to %s\n", pushAddr)
		return
	}
	masterPriv := ed25519.PrivateKey(privBytes)

	pushStart := time.Now()
	tc, err := rtx5tcp.DialTunnel(pushAddr, rtx5tcp.RoleSuperAdminClient, 10*time.Second)
	if err != nil {
		fmt.Printf("[OTA-TCP-PUSH] [WARN] Super Admin Hub %s unreachable over Encrypted Binary TCP (%v); local OTA artifacts remain ready in %s\n", pushAddr, err, outDir)
		return
	}
	sess := rtx5tcp.NewMuxSession(tc, false, nil, nil)
	defer sess.Close()
	go func() {
		_ = sess.ServeLoop()
	}()

	remoteHashes, chStatus, chErr := collectRemoteOTAHashes(sess)
	if chErr != nil {
		fmt.Printf("[OTA-TCP-PUSH] [WARN] Could not query /api/tcp-security/ota/channels on %s (%v); local OTA artifacts remain ready in %s\n", pushAddr, chErr, outDir)
		return
	}
	if chStatus == http.StatusNotFound && len(remoteHashes) == 0 {
		fmt.Printf("[OTA-TCP-PUSH] [WARN] Remote Super Admin Hub %s returned 404 on /api/tcp-security/ota/channels (hub not yet upgraded); skipping TCP push.\n", pushAddr)
		return
	}

	dirEntries, err := os.ReadDir(outDir)
	if err != nil {
		fmt.Printf("[OTA-TCP-PUSH] [WARN] ReadDir %s failed: %v\n", outDir, err)
		return
	}

	type artifactCandidate struct {
		name   string
		path   string
		sha256 string
		size   int64
	}
	var artifacts []artifactCandidate
	for _, de := range dirEntries {
		if de.IsDir() {
			continue
		}
		name := de.Name()
		lower := strings.ToLower(name)
		if strings.HasSuffix(lower, ".zip") || (strings.HasPrefix(lower, "rtx5-") && strings.HasSuffix(lower, ".exe")) {
			fullPath := filepath.Join(outDir, name)
			shaHex, sz, herr := rtx5tcp.ComputeFileSHA256(fullPath)
			if herr != nil {
				continue
			}
			artifacts = append(artifacts, artifactCandidate{
				name:   name,
				path:   fullPath,
				sha256: strings.ToLower(strings.TrimSpace(shaHex)),
				size:   sz,
			})
		}
	}

	sort.Slice(artifacts, func(i, j int) bool {
		if artifacts[i].size != artifacts[j].size {
			return artifacts[i].size < artifacts[j].size
		}
		return artifacts[i].name < artifacts[j].name
	})

	uploadedArtifacts := 0
	uploadedManifests := 0
	var uploadedBytes int64
	skippedCount := 0
	var skippedBytes int64

	for _, art := range artifacts {
		if remoteHashes[art.sha256] {
			skippedCount++
			skippedBytes += art.size
			continue
		}
		fileBytes, rerr := os.ReadFile(art.path)
		if rerr != nil {
			fmt.Printf("[OTA-TCP-PUSH] [WARN] Read %s failed: %v\n", art.name, rerr)
			continue
		}
		status, shaHex, uerr := uploadOTAFileOverTCP(sess, masterPriv, art.name, fileBytes)
		if status == http.StatusNotFound {
			fmt.Printf("[OTA-TCP-PUSH] [WARN] Remote Super Admin Hub %s returned 404 on /api/tcp-security/ota/upload (hub not yet upgraded); skipping TCP push.\n", pushAddr)
			return
		}
		if uerr != nil {
			fmt.Printf("[OTA-TCP-PUSH] [WARN] Upload artifact %s to %s failed (%v); aborting manifest upload so remote state stays consistent.\n", art.name, pushAddr, uerr)
			return
		}
		remoteHashes[shaHex] = true
		uploadedArtifacts++
		uploadedBytes += int64(len(fileBytes))
		fmt.Printf("  [OTA-TCP-PUSH] Uploaded %-26s (%6.2f MB | sha256=%s)\n",
			art.name, float64(len(fileBytes))/(1024*1024), shaHex[:12])
	}

	// Upload channel metadata YAML files before manifests if present
	for _, ymlName := range []string{"latest.yml", "beta.yml", "alpha.yml"} {
		ymlPath := filepath.Join(outDir, ymlName)
		if ymlBytes, rerr := os.ReadFile(ymlPath); rerr == nil && len(ymlBytes) > 0 {
			status, _, _ := uploadOTAFileOverTCP(sess, masterPriv, ymlName, ymlBytes)
			if status == http.StatusNotFound {
				fmt.Printf("[OTA-TCP-PUSH] [WARN] Remote Super Admin Hub %s returned 404 on /api/tcp-security/ota/upload (hub not yet upgraded); skipping TCP push.\n", pushAddr)
				return
			}
		}
	}

	// Always upload manifest files LAST so the remote Super Admin Hub never sees a manifest before its .zip/.exe artifacts are in place!
	manifestFiles := []string{
		"manifest.json",
		"manifest-production.json",
		"manifest-beta.json",
		"manifest-alpha.json",
	}
	for _, mName := range manifestFiles {
		mPath := filepath.Join(outDir, mName)
		mBytes, rerr := os.ReadFile(mPath)
		if rerr != nil || len(mBytes) == 0 {
			continue
		}
		status, shaHex, uerr := uploadOTAFileOverTCP(sess, masterPriv, mName, mBytes)
		if status == http.StatusNotFound {
			fmt.Printf("[OTA-TCP-PUSH] [WARN] Remote Super Admin Hub %s returned 404 on /api/tcp-security/ota/upload (hub not yet upgraded); skipping TCP push.\n", pushAddr)
			return
		}
		if uerr != nil {
			fmt.Printf("[OTA-TCP-PUSH] [WARN] Upload manifest %s to %s failed: %v\n", mName, pushAddr, uerr)
			continue
		}
		uploadedManifests++
		uploadedBytes += int64(len(mBytes))
		fmt.Printf("  [OTA-TCP-PUSH] Uploaded %-26s (%6.2f KB | sha256=%s)\n",
			mName, float64(len(mBytes))/1024.0, shaHex[:12])
	}

	if uploadedManifests > 0 || uploadedArtifacts > 0 {
		fmt.Printf("[OTA-TCP-PUSH] Automatically pushed release %s (v%s) to %s over Encrypted Binary TCP! (uploaded %d artifact(s) + %d manifest(s) [%.2f MB], skipped %d unchanged artifact(s) [%.2f MB] in %s)\n",
			releaseID, ver, pushAddr, uploadedArtifacts, uploadedManifests,
			float64(uploadedBytes)/(1024*1024), skippedCount, float64(skippedBytes)/(1024*1024),
			time.Since(pushStart).Round(time.Millisecond))
	}
}

func runCIPartialOTAPush(pushAddr, masterPrivHex, masterPubHex, ciApp, ciDist, ver, releaseID string, now time.Time) {
	if pushAddr == "" {
		pushAddr = "185.126.217.108:9100"
	}
	privBytes, err := hex.DecodeString(strings.TrimSpace(masterPrivHex))
	if err != nil || len(privBytes) != ed25519.PrivateKeySize {
		log.Fatalf("[CI-OTA] invalid Ed25519 master private key")
	}
	masterPriv := ed25519.PrivateKey(privBytes)

	tc, err := rtx5tcp.DialTunnel(pushAddr, rtx5tcp.RoleSuperAdminClient, 15*time.Second)
	if err != nil {
		log.Fatalf("[CI-OTA] dial %s failed: %v", pushAddr, err)
	}
	sess := rtx5tcp.NewMuxSession(tc, false, nil, nil)
	defer sess.Close()
	go func() {
		_ = sess.ServeLoop()
	}()

	var uploadedZipName, uploadedSHA, uploadedTreeSHA string
	var uploadedSize int64
	if ciDist != "" && (ciApp == "superadmin" || ciApp == "admin" || ciApp == "manager" || ciApp == "terminal") {
		tmpZip := filepath.Join(os.TempDir(), ciApp+"-ui.zip")
		treeSHA, terr := rtx5tcp.ComputeFSTreeSHA256(os.DirFS(ciDist))
		if terr != nil {
			log.Fatalf("[CI-OTA] tree hash %s: %v", ciDist, terr)
		}
		if zerr := zipDirectoryDeterministic(ciDist, tmpZip); zerr != nil {
			log.Fatalf("[CI-OTA] zip %s: %v", ciDist, zerr)
		}
		zipBytes, rerr := os.ReadFile(tmpZip)
		if rerr != nil {
			log.Fatalf("[CI-OTA] read %s: %v", tmpZip, rerr)
		}
		uploadedZipName = ciApp + "-ui.zip"
		_, shaHex, uerr := uploadOTAFileOverTCP(sess, masterPriv, uploadedZipName, zipBytes)
		if uerr != nil {
			log.Fatalf("[CI-OTA] upload %s failed: %v", uploadedZipName, uerr)
		}
		uploadedSHA = shaHex
		uploadedTreeSHA = treeSHA
		uploadedSize = int64(len(zipBytes))
		fmt.Printf("[CI-OTA] Uploaded %s (%.2f MB | sha256=%s)\n", uploadedZipName, float64(uploadedSize)/(1024*1024), shaHex[:12])
	}

	for _, ch := range []string{"production", "beta", "alpha"} {
		mStatus, _, mBody, mErr := sess.RoundTripRPC("ota", http.MethodGet, "/ota/manifest?channel="+ch, nil, nil, 15*time.Second)
		if mErr != nil || mStatus != http.StatusOK || len(mBody) == 0 {
			continue
		}
		var m rtx5tcp.OTAManifest
		if err := json.Unmarshal(mBody, &m); err != nil || len(m.Apps) == 0 {
			continue
		}
		m.ReleaseID = releaseID
		m.PublishedAt = now.Unix()
		for k, a := range m.Apps {
			if a == nil {
				continue
			}
			a.Version = ver
			if k == ciApp && uploadedSHA != "" {
				a.UIZipFile = uploadedZipName
				a.UISHA256 = uploadedSHA
				a.UISize = uploadedSize
				a.UITreeSHA256 = uploadedTreeSHA
			}
		}
		if err := rtx5tcp.SignOTAManifest(&m, masterPrivHex); err != nil {
			log.Fatalf("[CI-OTA] sign manifest (%s): %v", ch, err)
		}
		if err := rtx5tcp.VerifyOTAManifest(&m, masterPubHex); err != nil {
			log.Fatalf("[CI-OTA] verify manifest (%s): %v", ch, err)
		}
		rawM, _ := json.MarshalIndent(&m, "", "  ")
		rawM = append(rawM, '\n')
		targets := []string{rtx5tcp.ManifestFilenameForChannel(ch)}
		if ch == "production" {
			targets = []string{"manifest.json", "manifest-production.json"}
		}
		for _, fn := range targets {
			if _, shaHex, uerr := uploadOTAFileOverTCP(sess, masterPriv, fn, rawM); uerr != nil {
				log.Fatalf("[CI-OTA] upload %s failed: %v", fn, uerr)
			} else {
				fmt.Printf("[CI-OTA] Uploaded %s (v%s | %s | sha256=%s)\n", fn, ver, releaseID, shaHex[:12])
			}
		}
	}
	fmt.Printf("[CI-OTA] Successfully published %s (v%s) to %s over Encrypted Binary TCP!\n", releaseID, ver, pushAddr)
}

func main() {
	rootFlag := flag.String("root", "", "Path to RTX5-TCP-Production root")
	versionFlag := flag.String("version", "", "OTA release version string")
	channelFlag := flag.String("channel", "all", "OTA channel to publish: alpha, beta, production, or all")
	promoteFromFlag := flag.String("promote-from", "", "Source channel to promote from (alpha or beta)")
	promoteToFlag := flag.String("promote-to", "", "Target channel to promote to (beta or production)")
	pushTCPFlag := flag.String("push-tcp", "", "Super Admin Binary TCP Hub address (:9100) to push signed OTA release to")
	autoPushFlag := flag.Bool("auto-push", true, "Automatically push signed OTA release over Binary TCP (:9100) using 1-SUPERADMIN-My-PC-Only/client-config.json")
	ciAppFlag := flag.String("ci-app", "", "CI single-repo OTA update target (superadmin, admin, manager, terminal, version-only)")
	ciDistFlag := flag.String("ci-dist", "", "CI built dist directory for UI bundle")
	flag.Parse()

	prodRoot := strings.TrimSpace(*rootFlag)
	if prodRoot == "" {
		wd, err := os.Getwd()
		if err != nil {
			log.Fatalf("getwd: %v", err)
		}
		prodRoot = filepath.Clean(filepath.Join(wd, "..", ".."))
	}

	var auth struct {
		Ed25519MasterPrivHex string `json:"ed25519_master_priv_hex"`
		Ed25519MasterPubHex  string `json:"ed25519_master_pub_hex"`
		GuardDLLSHA256Hex    string `json:"guard_dll_sha256_hex"`
	}
	authPath := filepath.Join(prodRoot, "runtime-data", "secrets", "shared-authority.json")
	if authRaw, err := os.ReadFile(authPath); err == nil && len(authRaw) > 0 {
		if jerr := json.Unmarshal(authRaw, &auth); jerr != nil {
			log.Fatalf("parse shared-authority.json: %v", jerr)
		}
	}
	if envPriv := strings.TrimSpace(os.Getenv("RTX5_MASTER_PRIV_HEX")); len(envPriv) == 128 {
		auth.Ed25519MasterPrivHex = envPriv
		auth.Ed25519MasterPubHex = envPriv[64:]
	}
	if auth.GuardDLLSHA256Hex == "" {
		auth.GuardDLLSHA256Hex = "28b5aa822fdd636f2d1586f74fdc216ea86e6d5924b4ddd44a4430f8d820b13b"
	}
	if auth.Ed25519MasterPrivHex == "" || auth.Ed25519MasterPubHex == "" {
		log.Fatal("missing Ed25519 master keypair in shared-authority.json or RTX5_MASTER_PRIV_HEX")
	}

	packagesRoot := filepath.Join(filepath.Dir(prodRoot), "3-EXE-Packages-To-Run-And-Share")
	pushAddr := resolvePushTCPAddr(packagesRoot, *pushTCPFlag, *autoPushFlag)

	now := time.Now().UTC()
	ver := strings.TrimSpace(*versionFlag)
	if ver == "" {
		for _, vPath := range []string{
			filepath.Join(prodRoot, "VERSION"),
			filepath.Join(packagesRoot, "linux", "2-BROKER-Linux-VPS", "VERSION"),
		} {
			if vb, verr := os.ReadFile(vPath); verr == nil {
				if vStr := strings.TrimSpace(string(vb)); vStr != "" {
					ver = vStr
					break
				}
			}
		}
		if ver == "" {
			ver = fmt.Sprintf("2.2.%s", now.Format("20060102-150405"))
		}
	}
	releaseID := fmt.Sprintf("rtx5-tcp-ota-%s", now.Format("20060102-150405"))

	if strings.TrimSpace(*ciAppFlag) != "" {
		runCIPartialOTAPush(pushAddr, auth.Ed25519MasterPrivHex, auth.Ed25519MasterPubHex, strings.TrimSpace(*ciAppFlag), strings.TrimSpace(*ciDistFlag), ver, releaseID, now)
		return
	}

	outDir := filepath.Join(packagesRoot, "ota-releases")
	if err := os.MkdirAll(outDir, 0755); err != nil {
		log.Fatalf("mkdir ota-releases: %v", err)
	}

	if strings.TrimSpace(*promoteFromFlag) != "" || strings.TrimSpace(*promoteToFlag) != "" {
		if strings.TrimSpace(*promoteFromFlag) == "" || strings.TrimSpace(*promoteToFlag) == "" {
			log.Fatal("both -promote-from and -promote-to must be specified together")
		}
		fromCh := rtx5tcp.NormalizeOTAChannel(*promoteFromFlag)
		toCh := rtx5tcp.NormalizeOTAChannel(*promoteToFlag)
		promoted, err := rtx5tcp.PromoteOTAChannel(outDir, fromCh, toCh, auth.Ed25519MasterPrivHex, auth.Ed25519MasterPubHex)
		if err != nil {
			log.Fatalf("promote OTA channel %s -> %s: %v", fromCh, toCh, err)
		}
		if err := writeChannelReleaseYAML(outDir, promoted, toCh); err != nil {
			log.Fatalf("write %s release YAML: %v", toCh, err)
		}
		fmt.Printf("[OTA-PROMOTED] Release %s promoted %s -> %s (%s)\n",
			promoted.ReleaseID, fromCh, toCh, filepath.Join(outDir, rtx5tcp.ManifestFilenameForChannel(toCh)))
		promVer := ""
		for _, a := range promoted.Apps {
			if a != nil && a.Version != "" {
				promVer = a.Version
				break
			}
		}
		pushOTAReleaseOverBinaryTCP(outDir, pushAddr, auth.Ed25519MasterPrivHex, promoted.ReleaseID, promVer)
		return
	}

	specs := []appSpec{
		{Key: "superadmin", Name: "RTX5 Super Admin Control Plane", ClientSlug: "rtx5-superadmin-client", ExeName: "RTX5-SuperAdmin64.exe"},
		{Key: "admin", Name: "RTX5 Broker Admin", ClientSlug: "rtx5-admin-client", ExeName: "RTX5-Admin64.exe"},
		{Key: "manager", Name: "RTX5 Dealing Desk Manager", ClientSlug: "rtx5-manager-client", ExeName: "RTX5-Manager64.exe"},
		{Key: "terminal", Name: "RTX5 Trader Terminal 64-Bit", ClientSlug: "rtx5-terminal-client", ExeName: "RTX5-Terminal64.exe"},
	}

	linuxSpecs := []linuxAppSpec{
		{
			Key:     "broker-linux",
			Name:    "RTX5 Broker Linux VPS Backend (:4443 + 256-Shard RAM Engine)",
			RelDir:  filepath.Join("linux", "2-BROKER-Linux-VPS"),
			SubDirs: []string{"server-engines", "scripts", "config"},
			ZipName: "broker-linux-backend.zip",
		},
		{
			Key:     "web-terminal-linux",
			Name:    "RTX5 Binary TCP Web Terminal Linux Server (:8443)",
			RelDir:  filepath.Join("linux", "3-WEB-TERMINAL-Linux-VPS"),
			SubDirs: []string{"server-engines", "scripts"},
			ZipName: "web-terminal-linux.zip",
		},
	}

	baseManifest := &rtx5tcp.OTAManifest{
		Schema:      rtx5tcp.OTASchemaV1,
		Channel:     rtx5tcp.OTAChannelProduction,
		ReleaseID:   releaseID,
		PublishedAt: now.Unix(),
		Apps:        make(map[string]*rtx5tcp.OTAAppArtifact, len(specs)+len(linuxSpecs)),
	}

	for _, sp := range specs {
		distDir := filepath.Join(prodRoot, "desktop-clients", "cmd", sp.ClientSlug, "dist")
		exeSrc := filepath.Join(prodRoot, "build", "clients", sp.ExeName)

		treeSHA, err := rtx5tcp.ComputeFSTreeSHA256(os.DirFS(distDir))
		if err != nil {
			log.Fatalf("[%s] compute UI tree SHA-256 (%s): %v", sp.Key, distDir, err)
		}

		zipName := sp.Key + "-ui.zip"
		zipDst := filepath.Join(outDir, zipName)
		if err := zipDirectoryDeterministic(distDir, zipDst); err != nil {
			log.Fatalf("[%s] zip UI bundle: %v", sp.Key, err)
		}
		uiZipSHA, uiZipSize, err := rtx5tcp.ComputeFileSHA256(zipDst)
		if err != nil {
			log.Fatalf("[%s] hash UI zip: %v", sp.Key, err)
		}

		exeDst := filepath.Join(outDir, sp.ExeName)
		if err := copyAtomic(exeSrc, exeDst); err != nil {
			log.Fatalf("[%s] stage exe (%s): %v", sp.Key, exeSrc, err)
		}
		exeSHA, exeSize, err := rtx5tcp.ComputeFileSHA256(exeDst)
		if err != nil {
			log.Fatalf("[%s] hash exe: %v", sp.Key, err)
		}

		baseManifest.Apps[sp.Key] = &rtx5tcp.OTAAppArtifact{
			AppKey:         sp.Key,
			AppName:        sp.Name,
			Version:        ver,
			UITreeSHA256:   treeSHA,
			UIZipFile:      zipName,
			UISHA256:       uiZipSHA,
			UISize:         uiZipSize,
			ExeFile:        sp.ExeName,
			ExeSHA256:      exeSHA,
			ExeSize:        exeSize,
			GuardDLLSHA256: strings.ToLower(strings.TrimSpace(auth.GuardDLLSHA256Hex)),
		}
	}

	for _, lsp := range linuxSpecs {
		srcDir := filepath.Join(packagesRoot, lsp.RelDir)
		info, err := os.Stat(srcDir)
		if err != nil || !info.IsDir() {
			continue
		}
		zipDst := filepath.Join(outDir, lsp.ZipName)
		treeSHA, err := zipSubdirsDeterministic(srcDir, lsp.SubDirs, zipDst)
		if err != nil {
			log.Fatalf("[%s] zip Linux bundle (%s): %v", lsp.Key, srcDir, err)
		}
		zipSHA, zipSize, err := rtx5tcp.ComputeFileSHA256(zipDst)
		if err != nil {
			log.Fatalf("[%s] hash Linux zip: %v", lsp.Key, err)
		}
		baseManifest.Apps[lsp.Key] = &rtx5tcp.OTAAppArtifact{
			AppKey:       lsp.Key,
			AppName:      lsp.Name,
			Version:      ver,
			UITreeSHA256: treeSHA,
			UIZipFile:    lsp.ZipName,
			UISHA256:     zipSHA,
			UISize:       zipSize,
		}
	}

	reqCh := strings.ToLower(strings.TrimSpace(*channelFlag))
	var targetChannels []string
	if reqCh == "" || reqCh == "all" {
		targetChannels = []string{
			rtx5tcp.OTAChannelAlpha,
			rtx5tcp.OTAChannelBeta,
			rtx5tcp.OTAChannelProduction,
		}
	} else {
		norm := rtx5tcp.NormalizeOTAChannel(reqCh)
		targetChannels = []string{norm}
		// Ensure baseline manifests exist for any uninitialized channels
		for _, ch := range []string{rtx5tcp.OTAChannelAlpha, rtx5tcp.OTAChannelBeta, rtx5tcp.OTAChannelProduction} {
			if ch == norm {
				continue
			}
			if _, err := os.Stat(filepath.Join(outDir, rtx5tcp.ManifestFilenameForChannel(ch))); os.IsNotExist(err) {
				targetChannels = append(targetChannels, ch)
			}
		}
	}

	var signedManifest *rtx5tcp.OTAManifest
	for _, ch := range targetChannels {
		m := cloneManifestForChannel(baseManifest, ch)
		if err := rtx5tcp.SignOTAManifest(m, auth.Ed25519MasterPrivHex); err != nil {
			log.Fatalf("sign OTA manifest (%s): %v", ch, err)
		}
		if err := rtx5tcp.VerifyOTAManifest(m, auth.Ed25519MasterPubHex); err != nil {
			log.Fatalf("verify signed OTA manifest (%s) failed: %v", ch, err)
		}
		manifestBytes, err := json.MarshalIndent(m, "", "  ")
		if err != nil {
			log.Fatalf("marshal manifest (%s): %v", ch, err)
		}
		manifestPath := filepath.Join(outDir, rtx5tcp.ManifestFilenameForChannel(ch))
		if err := writeBytesAtomic(manifestPath, manifestBytes); err != nil {
			log.Fatalf("write %s: %v", manifestPath, err)
		}
		if ch == rtx5tcp.OTAChannelProduction {
			prodCopyPath := filepath.Join(outDir, "manifest-production.json")
			if err := writeBytesAtomic(prodCopyPath, manifestBytes); err != nil {
				log.Fatalf("write %s: %v", prodCopyPath, err)
			}
		}
		if err := writeChannelReleaseYAML(outDir, m, ch); err != nil {
			log.Fatalf("write %s YAML: %v", ch, err)
		}
		signedManifest = m
	}

	// Ensure Linux backend artifacts (broker-linux, web-terminal-linux) are ALWAYS updated directly
	// in manifest.json (Production) even when publishing a desktop Alpha/Beta build, since backends do not use Alpha/Beta.
	prodHasTarget := false
	for _, ch := range targetChannels {
		if ch == rtx5tcp.OTAChannelProduction {
			prodHasTarget = true
			break
		}
	}
	if !prodHasTarget {
		prodPath := filepath.Join(outDir, "manifest.json")
		var prodM rtx5tcp.OTAManifest
		if raw, err := os.ReadFile(prodPath); err == nil && json.Unmarshal(raw, &prodM) == nil && prodM.Apps != nil {
			for _, lsp := range linuxSpecs {
				if art := baseManifest.Apps[lsp.Key]; art != nil {
					cp := *art
					prodM.Apps[lsp.Key] = &cp
				}
			}
			prodM.Channel = rtx5tcp.OTAChannelProduction
			if rtx5tcp.SignOTAManifest(&prodM, auth.Ed25519MasterPrivHex) == nil {
				if mb, err := json.MarshalIndent(&prodM, "", "  "); err == nil {
					_ = writeBytesAtomic(prodPath, mb)
					_ = writeBytesAtomic(filepath.Join(outDir, "manifest-production.json"), mb)
				}
			}
		}
	}

	fmt.Printf("[OTA-SIGNED] Release %s (v%s) verified with Ed25519 Master Key -> %s (channels=%v)\n",
		releaseID, ver, outDir, targetChannels)
	for _, sp := range specs {
		a := signedManifest.Apps[sp.Key]
		fmt.Printf("  %-18s UI=%s (%.2f MB) | EXE=%s (%.2f MB) [tree=%s]\n",
			sp.Key,
			a.UIZipFile, float64(a.UISize)/(1024*1024),
			a.ExeFile, float64(a.ExeSize)/(1024*1024),
			a.UITreeSHA256[:12],
		)
	}
	for _, lsp := range linuxSpecs {
		if a, ok := signedManifest.Apps[lsp.Key]; ok && a != nil {
			fmt.Printf("  %-18s PKG=%s (%.2f MB) [tree=%s]\n",
				lsp.Key,
				a.UIZipFile, float64(a.UISize)/(1024*1024),
				a.UITreeSHA256[:12],
			)
		}
	}

	pushOTAReleaseOverBinaryTCP(outDir, pushAddr, auth.Ed25519MasterPrivHex, releaseID, ver)
}

