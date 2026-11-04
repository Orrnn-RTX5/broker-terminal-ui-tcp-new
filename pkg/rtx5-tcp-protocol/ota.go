package rtx5tcp

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const OTASchemaV1 = "RTX5-TCP-OTA-V1"

const (
	OTAChannelAlpha      = "alpha"
	OTAChannelBeta       = "beta"
	OTAChannelProduction = "production"
)

// NormalizeOTAChannel normalizes an OTA channel identifier into "alpha", "beta", or "production".
func NormalizeOTAChannel(ch string) string {
	switch strings.ToLower(strings.TrimSpace(ch)) {
	case OTAChannelAlpha:
		return OTAChannelAlpha
	case OTAChannelBeta, "prerelease", "pre-release":
		return OTAChannelBeta
	default:
		return OTAChannelProduction
	}
}

// ManifestFilenameForChannel returns the manifest filename on disk for the normalized channel.
func ManifestFilenameForChannel(ch string) string {
	switch NormalizeOTAChannel(ch) {
	case OTAChannelAlpha:
		return "manifest-alpha.json"
	case OTAChannelBeta:
		return "manifest-beta.json"
	default:
		return "manifest.json"
	}
}

// OTAAppArtifact describes an Ed25519-signed UI bundle (.zip) and Windows binary (.exe)
// for a specific RTX5 desktop application ("superadmin", "admin", "manager", "terminal")
// or Linux server package ("broker-linux", "web-terminal-linux").
type OTAAppArtifact struct {
	AppKey         string `json:"app_key"`
	AppName        string `json:"app_name"`
	Version        string `json:"version"`
	UITreeSHA256   string `json:"ui_tree_sha256"`
	UIZipFile      string `json:"ui_zip_file"`
	UISHA256       string `json:"ui_sha256"`
	UISize         int64  `json:"ui_size"`
	UISigHex       string `json:"ui_sig_hex"`
	ExeFile        string `json:"exe_file"`
	ExeSHA256      string `json:"exe_sha256"`
	ExeSize        int64  `json:"exe_size"`
	ExeSigHex      string `json:"exe_sig_hex"`
	GuardDLLSHA256 string `json:"guard_dll_sha256"`
}

// OTAManifest is the Super-Admin Ed25519-signed OTA release manifest distributed strictly over Binary TCP.
type OTAManifest struct {
	Schema      string                     `json:"schema"`
	Channel     string                     `json:"channel,omitempty"`
	ReleaseID   string                     `json:"release_id"`
	PublishedAt int64                      `json:"published_at"`
	Apps        map[string]*OTAAppArtifact `json:"apps"`
	Signature   string                     `json:"signature"`
}

func (a *OTAAppArtifact) canonicalUIMessage() []byte {
	return []byte(fmt.Sprintf(
		"RTX5-OTA-UI-V1|%s|%s|%s|%s|%d",
		strings.ToLower(strings.TrimSpace(a.AppKey)),
		strings.TrimSpace(a.Version),
		strings.ToLower(strings.TrimSpace(a.UISHA256)),
		strings.ToLower(strings.TrimSpace(a.UITreeSHA256)),
		a.UISize,
	))
}

func (a *OTAAppArtifact) canonicalExeMessage() []byte {
	return []byte(fmt.Sprintf(
		"RTX5-OTA-EXE-V1|%s|%s|%s|%d|%s",
		strings.ToLower(strings.TrimSpace(a.AppKey)),
		strings.TrimSpace(a.Version),
		strings.ToLower(strings.TrimSpace(a.ExeSHA256)),
		a.ExeSize,
		strings.ToLower(strings.TrimSpace(a.GuardDLLSHA256)),
	))
}

func (m *OTAManifest) canonicalManifestMessage() ([]byte, error) {
	if m == nil {
		return nil, errors.New("nil OTA manifest")
	}
	keys := make([]string, 0, len(m.Apps))
	for k := range m.Apps {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var sb strings.Builder
	sb.WriteString("RTX5-OTA-MANIFEST-V1|")
	sb.WriteString(strings.TrimSpace(m.Schema))
	sb.WriteByte('|')
	sb.WriteString(strings.TrimSpace(m.ReleaseID))
	sb.WriteByte('|')
	sb.WriteString(fmt.Sprintf("%d", m.PublishedAt))
	for _, k := range keys {
		a := m.Apps[k]
		if a == nil {
			continue
		}
		sb.WriteString(fmt.Sprintf(
			"|app=%s:%s:%s:%s:%s:%d:%s:%d:%s",
			strings.ToLower(strings.TrimSpace(k)),
			strings.TrimSpace(a.Version),
			strings.ToLower(strings.TrimSpace(a.UITreeSHA256)),
			strings.ToLower(strings.TrimSpace(a.UISHA256)),
			strings.TrimSpace(a.UIZipFile),
			a.UISize,
			strings.ToLower(strings.TrimSpace(a.ExeSHA256)),
			a.ExeSize,
			strings.ToLower(strings.TrimSpace(a.GuardDLLSHA256)),
		))
	}
	return []byte(sb.String()), nil
}

// SignOTAAppArtifact signs both the UI bundle and Windows .exe digests with the Super Admin Ed25519 private key.
func SignOTAAppArtifact(a *OTAAppArtifact, masterPrivHex string) error {
	if a == nil {
		return errors.New("nil OTA app artifact")
	}
	privBytes, err := hex.DecodeString(strings.TrimSpace(masterPrivHex))
	if err != nil || len(privBytes) != ed25519.PrivateKeySize {
		return errors.New("invalid Ed25519 master private key")
	}
	priv := ed25519.PrivateKey(privBytes)
	if a.UISHA256 != "" {
		a.UISigHex = hex.EncodeToString(ed25519.Sign(priv, a.canonicalUIMessage()))
	}
	if a.ExeSHA256 != "" {
		a.ExeSigHex = hex.EncodeToString(ed25519.Sign(priv, a.canonicalExeMessage()))
	}
	return nil
}

// SignOTAManifest signs all app entries and the top-level OTAManifest using the Super Admin Ed25519 private key.
func SignOTAManifest(m *OTAManifest, masterPrivHex string) error {
	if m == nil {
		return errors.New("nil OTA manifest")
	}
	if m.Schema == "" {
		m.Schema = OTASchemaV1
	}
	for k, a := range m.Apps {
		if a == nil {
			continue
		}
		if a.AppKey == "" {
			a.AppKey = k
		}
		if err := SignOTAAppArtifact(a, masterPrivHex); err != nil {
			return err
		}
	}
	privBytes, err := hex.DecodeString(strings.TrimSpace(masterPrivHex))
	if err != nil || len(privBytes) != ed25519.PrivateKeySize {
		return errors.New("invalid Ed25519 master private key")
	}
	msg, err := m.canonicalManifestMessage()
	if err != nil {
		return err
	}
	m.Signature = hex.EncodeToString(ed25519.Sign(ed25519.PrivateKey(privBytes), msg))
	return nil
}

// VerifyOTAManifest cryptographically verifies the manifest and all embedded app artifact signatures.
func VerifyOTAManifest(m *OTAManifest, masterPubHex string) error {
	if m == nil {
		return errors.New("ota: nil manifest")
	}
	if m.Schema != OTASchemaV1 {
		return fmt.Errorf("ota: unsupported manifest schema %q", m.Schema)
	}
	pubBytes, err := hex.DecodeString(strings.TrimSpace(masterPubHex))
	if err != nil || len(pubBytes) != ed25519.PublicKeySize {
		return errors.New("ota: invalid Ed25519 master public key")
	}
	pub := ed25519.PublicKey(pubBytes)

	sigBytes, err := hex.DecodeString(strings.TrimSpace(m.Signature))
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return errors.New("ota: malformed manifest Ed25519 signature")
	}
	msg, err := m.canonicalManifestMessage()
	if err != nil {
		return err
	}
	if !ed25519.Verify(pub, msg, sigBytes) {
		return errors.New("ota: manifest Ed25519 signature verification failed")
	}

	for k, a := range m.Apps {
		if a == nil {
			continue
		}
		if a.UISHA256 != "" {
			uiSig, err := hex.DecodeString(strings.TrimSpace(a.UISigHex))
			if err != nil || len(uiSig) != ed25519.SignatureSize || !ed25519.Verify(pub, a.canonicalUIMessage(), uiSig) {
				return fmt.Errorf("ota: UI signature verification failed for %s", k)
			}
		}
		if a.ExeSHA256 != "" {
			exeSig, err := hex.DecodeString(strings.TrimSpace(a.ExeSigHex))
			if err != nil || len(exeSig) != ed25519.SignatureSize || !ed25519.Verify(pub, a.canonicalExeMessage(), exeSig) {
				return fmt.Errorf("ota: EXE signature verification failed for %s", k)
			}
		}
	}
	return nil
}

// VerifyOTAFileBytes verifies downloaded bytes against expected SHA-256 and size.
func VerifyOTAFileBytes(data []byte, expectedSHA256 string, expectedSize int64) error {
	if expectedSize > 0 && int64(len(data)) != expectedSize {
		return fmt.Errorf("ota: size mismatch (got %d bytes, expected %d)", len(data), expectedSize)
	}
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, strings.TrimSpace(expectedSHA256)) {
		return fmt.Errorf("ota: SHA-256 mismatch (got %s, expected %s)", got, expectedSHA256)
	}
	return nil
}

// ComputeFileSHA256 streams a file from disk and returns (sha256Hex, sizeBytes, error).
func ComputeFileSHA256(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// ComputeFSTreeSHA256 computes a deterministic cryptographic tree digest across all regular files
// in an fs.FS (works identically across embed.FS, os.DirFS, and unpacked UI zip directories).
func ComputeFSTreeSHA256(fsys fs.FS) (string, error) {
	if fsys == nil {
		return "", errors.New("nil fs.FS")
	}
	type entry struct {
		rel  string
		hash string
		size int64
	}
	var entries []entry
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		cleanRel := strings.TrimPrefix(filepath.ToSlash(p), "./")
		if cleanRel == "" || cleanRel == "." || strings.HasPrefix(filepath.Base(cleanRel), ".ota-") {
			return nil
		}
		f, err := fsys.Open(p)
		if err != nil {
			return err
		}
		h := sha256.New()
		sz, copyErr := io.Copy(h, f)
		_ = f.Close()
		if copyErr != nil {
			return copyErr
		}
		entries = append(entries, entry{
			rel:  cleanRel,
			hash: hex.EncodeToString(h.Sum(nil)),
			size: sz,
		})
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].rel < entries[j].rel
	})
	root := sha256.New()
	root.Write([]byte("RTX5-UI-TREE-V1\n"))
	for _, e := range entries {
		root.Write([]byte(fmt.Sprintf("%s\x00%d\x00%s\n", e.rel, e.size, e.hash)))
	}
	return hex.EncodeToString(root.Sum(nil)), nil
}

func IsSafeOTAFilename(name string) bool {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || trimmed != filepath.Base(trimmed) || strings.ContainsAny(trimmed, `/\`) || strings.Contains(trimmed, "..") {
		return false
	}
	lower := strings.ToLower(trimmed)
	switch lower {
	case "manifest.json", "manifest-alpha.json", "manifest-beta.json", "manifest-production.json",
		"alpha.yml", "beta.yml", "latest.yml":
		return true
	}
	return strings.HasSuffix(lower, ".zip") ||
		strings.HasSuffix(lower, ".exe") ||
		strings.HasSuffix(lower, ".deb") ||
		strings.HasSuffix(lower, ".tar.gz") ||
		strings.HasSuffix(lower, ".sql")
}

func writeFileAtomic(dstPath string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(dstPath), 0755); err != nil {
		return err
	}
	tmp := dstPath + ".tmp"
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, dstPath)
}

// PromoteOTAChannel promotes a verified OTA manifest from fromChannel to toChannel,
// updates m.Channel and m.PublishedAt, re-signs with masterPrivHex if provided,
// and writes atomically to ManifestFilenameForChannel(toChannel) (plus manifest-production.json when promoting to production).
func PromoteOTAChannel(otaDir, fromChannel, toChannel, masterPrivHex, masterPubHex string) (*OTAManifest, error) {
	fromCh := NormalizeOTAChannel(fromChannel)
	toCh := NormalizeOTAChannel(toChannel)

	srcCandidates := []string{filepath.Join(otaDir, ManifestFilenameForChannel(fromCh))}
	if fromCh == OTAChannelProduction {
		srcCandidates = append(srcCandidates, filepath.Join(otaDir, "manifest-production.json"))
	} else {
		srcCandidates = append(srcCandidates, filepath.Join(otaDir, "manifest.json"))
	}

	var raw []byte
	var readErr error
	for _, p := range srcCandidates {
		raw, readErr = os.ReadFile(p)
		if readErr == nil {
			break
		}
	}
	if readErr != nil {
		return nil, fmt.Errorf("ota: read source channel %s manifest: %w", fromCh, readErr)
	}

	var m OTAManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("ota: parse source channel %s manifest: %w", fromCh, err)
	}
	if strings.TrimSpace(masterPubHex) != "" {
		if err := VerifyOTAManifest(&m, masterPubHex); err != nil {
			return nil, fmt.Errorf("ota: verify source channel %s manifest: %w", fromCh, err)
		}
	}

	m.Channel = toCh

	if strings.TrimSpace(masterPrivHex) != "" {
		if toCh == OTAChannelProduction && m.Apps != nil {
			if prodRaw, err := os.ReadFile(filepath.Join(otaDir, "manifest.json")); err == nil {
				var existingProd OTAManifest
				if json.Unmarshal(prodRaw, &existingProd) == nil && existingProd.Apps != nil {
					for _, bkKey := range []string{"broker-linux", "web-terminal-linux"} {
						if _, has := m.Apps[bkKey]; !has && existingProd.Apps[bkKey] != nil {
							cp := *existingProd.Apps[bkKey]
							m.Apps[bkKey] = &cp
						}
					}
				}
			}
		}
		m.PublishedAt = time.Now().UTC().Unix()
		if err := SignOTAManifest(&m, masterPrivHex); err != nil {
			return nil, fmt.Errorf("ota: sign promoted %s manifest: %w", toCh, err)
		}
		if strings.TrimSpace(masterPubHex) != "" {
			if err := VerifyOTAManifest(&m, masterPubHex); err != nil {
				return nil, fmt.Errorf("ota: verify promoted %s manifest: %w", toCh, err)
			}
		}
	}

	outBytes, err := json.MarshalIndent(&m, "", "  ")
	if err != nil {
		return nil, err
	}
	dstPrimary := filepath.Join(otaDir, ManifestFilenameForChannel(toCh))
	if err := writeFileAtomic(dstPrimary, outBytes); err != nil {
		return nil, err
	}
	if toCh == OTAChannelProduction {
		_ = writeFileAtomic(filepath.Join(otaDir, "manifest-production.json"), outBytes)
	}
	return &m, nil
}

// OTAUpstreamPuller fetches an OTA path (e.g. "/ota/manifest" or "/ota/files/terminal-ui.zip")
// over the Super Admin (:9100) Encrypted Binary TCP uplink when a remote Broker VPS needs to mirror an update.
type OTAUpstreamPuller func(otaPath string) ([]byte, int, error)

// NewOTAHTTPHandler serves /ota/manifest and /ota/files/<filename> on internal loopback for Binary TCP proxying.
// If upstreamPull is provided (Broker Access Server mode), it transparently pulls, verifies Ed25519 + SHA-256,
// and caches signed releases from the Super Admin (:9100) Binary TCP Hub.
func NewOTAHTTPHandler(otaDir string, masterPubHex string, upstreamPull OTAUpstreamPuller) http.Handler {
	var cacheMu sync.Mutex
	lastUpstreamCheck := make(map[string]time.Time)

	loadVerifiedLocalManifestForChannel := func(channel string) (*OTAManifest, []byte, error) {
		ch := NormalizeOTAChannel(channel)
		var candidates []string
		if ch == OTAChannelProduction {
			candidates = []string{
				filepath.Join(otaDir, "manifest.json"),
				filepath.Join(otaDir, "manifest-production.json"),
			}
		} else {
			candidates = []string{
				filepath.Join(otaDir, ManifestFilenameForChannel(ch)),
				filepath.Join(otaDir, "manifest.json"),
				filepath.Join(otaDir, "manifest-production.json"),
			}
		}
		var raw []byte
		var err error
		for _, p := range candidates {
			raw, err = os.ReadFile(p)
			if err == nil {
				break
			}
		}
		if err != nil {
			return nil, nil, err
		}
		var m OTAManifest
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, nil, err
		}
		if masterPubHex != "" {
			if err := VerifyOTAManifest(&m, masterPubHex); err != nil {
				return nil, nil, err
			}
		}
		return &m, raw, nil
	}

	refreshManifestIfNeeded := func(channel string) (*OTAManifest, []byte, error) {
		ch := NormalizeOTAChannel(channel)
		cacheMu.Lock()
		defer cacheMu.Unlock()

		if upstreamPull != nil && time.Since(lastUpstreamCheck[ch]) > 8*time.Second {
			lastUpstreamCheck[ch] = time.Now()
			pullPath := "/ota/manifest?channel=" + ch
			if raw, status, err := upstreamPull(pullPath); err == nil && status == http.StatusOK && len(raw) > 0 {
				var m OTAManifest
				if json.Unmarshal(raw, &m) == nil && (masterPubHex == "" || VerifyOTAManifest(&m, masterPubHex) == nil) {
					_ = os.MkdirAll(otaDir, 0755)
					localM, localRaw, localErr := loadVerifiedLocalManifestForChannel(ch)
					if localErr != nil || localM.ReleaseID != m.ReleaseID || localM.PublishedAt != m.PublishedAt || localM.Channel != m.Channel {
						dstFile := filepath.Join(otaDir, ManifestFilenameForChannel(ch))
						_ = writeFileAtomic(dstFile, raw)
						if ch == OTAChannelProduction {
							_ = writeFileAtomic(filepath.Join(otaDir, "manifest-production.json"), raw)
						}
						return &m, raw, nil
					}
					return localM, localRaw, nil
				}
			}
		}
		return loadVerifiedLocalManifestForChannel(ch)
	}

	findArtifactInManifests := func(name string, manifests ...*OTAManifest) (string, int64) {
		for _, m := range manifests {
			if m == nil {
				continue
			}
			for _, app := range m.Apps {
				if app == nil {
					continue
				}
				if strings.EqualFold(app.UIZipFile, name) && app.UISHA256 != "" {
					return app.UISHA256, app.UISize
				}
				if strings.EqualFold(app.ExeFile, name) && app.ExeSHA256 != "" {
					return app.ExeSHA256, app.ExeSize
				}
			}
		}
		return "", 0
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		path := r.URL.Path
		switch path {
		case "/ota/manifest", "/ota/manifest.json", "/ota/manifest-alpha.json", "/ota/manifest-beta.json", "/ota/manifest-production.json":
			ch := OTAChannelProduction
			if q := strings.TrimSpace(r.URL.Query().Get("channel")); q != "" {
				ch = NormalizeOTAChannel(q)
			} else if path == "/ota/manifest-alpha.json" {
				ch = OTAChannelAlpha
			} else if path == "/ota/manifest-beta.json" {
				ch = OTAChannelBeta
			} else if path == "/ota/manifest-production.json" {
				ch = OTAChannelProduction
			}
			_, raw, err := refreshManifestIfNeeded(ch)
			if err != nil {
				http.Error(w, "OTA manifest unavailable: "+err.Error(), http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(raw)
			return
		}

		if strings.HasPrefix(path, "/ota/files/") {
			name := strings.TrimPrefix(path, "/ota/files/")
			if !IsSafeOTAFilename(name) {
				http.Error(w, "invalid OTA artifact name", http.StatusBadRequest)
				return
			}
			lowerName := strings.ToLower(strings.TrimSpace(name))
			if lowerName == "manifest.json" || lowerName == "manifest-alpha.json" || lowerName == "manifest-beta.json" || lowerName == "manifest-production.json" {
				ch := OTAChannelProduction
				if lowerName == "manifest-alpha.json" {
					ch = OTAChannelAlpha
				} else if lowerName == "manifest-beta.json" {
					ch = OTAChannelBeta
				}
				_, raw, err := refreshManifestIfNeeded(ch)
				if err != nil {
					http.Error(w, "OTA manifest unavailable: "+err.Error(), http.StatusNotFound)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-store")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(raw)
				return
			}

			prodM, _, prodErr := refreshManifestIfNeeded(OTAChannelProduction)
			alphaM, _, alphaErr := loadVerifiedLocalManifestForChannel(OTAChannelAlpha)
			betaM, _, betaErr := loadVerifiedLocalManifestForChannel(OTAChannelBeta)
			if prodErr != nil && alphaErr != nil && betaErr != nil {
				http.Error(w, "OTA manifest unavailable", http.StatusNotFound)
				return
			}

			expectedSHA, expectedSize := findArtifactInManifests(name, prodM, alphaM, betaM)
			if expectedSHA == "" && upstreamPull != nil {
				alphaM, _, _ = refreshManifestIfNeeded(OTAChannelAlpha)
				betaM, _, _ = refreshManifestIfNeeded(OTAChannelBeta)
				expectedSHA, expectedSize = findArtifactInManifests(name, prodM, alphaM, betaM)
			}
			if expectedSHA == "" {
				if lowerName == "alpha.yml" || lowerName == "beta.yml" || lowerName == "latest.yml" {
					ymlPath := filepath.Join(otaDir, name)
					if _, err := os.Stat(ymlPath); err == nil {
						w.Header().Set("Cache-Control", "no-store")
						http.ServeFile(w, r, ymlPath)
						return
					}
				}
				http.Error(w, "artifact not listed in verified OTA manifest", http.StatusNotFound)
				return
			}

			localPath := filepath.Join(otaDir, name)
			localValid := false
			if gotSHA, gotSize, err := ComputeFileSHA256(localPath); err == nil {
				if strings.EqualFold(gotSHA, expectedSHA) && (expectedSize <= 0 || gotSize == expectedSize) {
					localValid = true
				}
			}

			if !localValid && upstreamPull != nil {
				cacheMu.Lock()
				if gotSHA, gotSize, err := ComputeFileSHA256(localPath); err == nil &&
					strings.EqualFold(gotSHA, expectedSHA) && (expectedSize <= 0 || gotSize == expectedSize) {
					localValid = true
				} else {
					raw, status, pullErr := upstreamPull("/ota/files/" + name)
					if pullErr == nil && status == http.StatusOK {
						if VerifyOTAFileBytes(raw, expectedSHA, expectedSize) == nil {
							if writeFileAtomic(localPath, raw) == nil {
								localValid = true
							}
						}
					}
				}
				cacheMu.Unlock()
			}

			if !localValid {
				http.Error(w, "verified OTA artifact not found", http.StatusNotFound)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-RTX5-OTA-SHA256", expectedSHA)
			http.ServeFile(w, r, localPath)
			return
		}

		http.NotFound(w, r)
	})
}

