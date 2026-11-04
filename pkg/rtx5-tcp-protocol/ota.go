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

// OTAAppArtifact describes an Ed25519-signed UI bundle (.zip) and Windows binary (.exe)
// for a specific RTX5 desktop application ("superadmin", "admin", "manager", "terminal").
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
	return strings.HasSuffix(lower, ".zip") || strings.HasSuffix(lower, ".exe") || lower == "manifest.json"
}

// OTAUpstreamPuller fetches an OTA path (e.g. "/ota/manifest" or "/ota/files/terminal-ui.zip")
// over the Super Admin (:9100) Encrypted Binary TCP uplink when a remote Broker VPS needs to mirror an update.
type OTAUpstreamPuller func(otaPath string) ([]byte, int, error)

// NewOTAHTTPHandler serves /ota/manifest and /ota/files/<filename> on internal loopback for Binary TCP proxying.
// If upstreamPull is provided (Broker Access Server mode), it transparently pulls, verifies Ed25519 + SHA-256,
// and caches signed releases from the Super Admin (:9100) Binary TCP Hub.
func NewOTAHTTPHandler(otaDir string, masterPubHex string, upstreamPull OTAUpstreamPuller) http.Handler {
	var cacheMu sync.Mutex
	var lastUpstreamCheck time.Time

	loadVerifiedLocalManifest := func() (*OTAManifest, []byte, error) {
		raw, err := os.ReadFile(filepath.Join(otaDir, "manifest.json"))
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

	refreshManifestIfNeeded := func() (*OTAManifest, []byte, error) {
		cacheMu.Lock()
		defer cacheMu.Unlock()

		if upstreamPull != nil && time.Since(lastUpstreamCheck) > 8*time.Second {
			lastUpstreamCheck = time.Now()
			if raw, status, err := upstreamPull("/ota/manifest"); err == nil && status == http.StatusOK && len(raw) > 0 {
				var m OTAManifest
				if json.Unmarshal(raw, &m) == nil && (masterPubHex == "" || VerifyOTAManifest(&m, masterPubHex) == nil) {
					_ = os.MkdirAll(otaDir, 0755)
					localM, localRaw, localErr := loadVerifiedLocalManifest()
					if localErr != nil || localM.ReleaseID != m.ReleaseID || localM.PublishedAt != m.PublishedAt {
						tmp := filepath.Join(otaDir, "manifest.json.tmp")
						if os.WriteFile(tmp, raw, 0644) == nil {
							_ = os.Rename(tmp, filepath.Join(otaDir, "manifest.json"))
						}
						return &m, raw, nil
					}
					return localM, localRaw, nil
				}
			}
		}
		return loadVerifiedLocalManifest()
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		path := r.URL.Path
		if path == "/ota/manifest" || path == "/ota/manifest.json" {
			_, raw, err := refreshManifestIfNeeded()
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
			manifest, _, err := refreshManifestIfNeeded()
			if err != nil {
				http.Error(w, "OTA manifest unavailable", http.StatusNotFound)
				return
			}

			var expectedSHA string
			var expectedSize int64
			for _, app := range manifest.Apps {
				if app == nil {
					continue
				}
				if strings.EqualFold(app.UIZipFile, name) {
					expectedSHA = app.UISHA256
					expectedSize = app.UISize
					break
				}
				if strings.EqualFold(app.ExeFile, name) {
					expectedSHA = app.ExeSHA256
					expectedSize = app.ExeSize
					break
				}
			}
			if expectedSHA == "" {
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
				// Re-check after lock
				if gotSHA, gotSize, err := ComputeFileSHA256(localPath); err == nil &&
					strings.EqualFold(gotSHA, expectedSHA) && (expectedSize <= 0 || gotSize == expectedSize) {
					localValid = true
				} else {
					raw, status, pullErr := upstreamPull("/ota/files/" + name)
					if pullErr == nil && status == http.StatusOK {
						if VerifyOTAFileBytes(raw, expectedSHA, expectedSize) == nil {
							_ = os.MkdirAll(otaDir, 0755)
							tmp := localPath + ".tmp"
							if os.WriteFile(tmp, raw, 0644) == nil && os.Rename(tmp, localPath) == nil {
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

