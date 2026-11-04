//go:build !windows

package rtx5tcp

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const ExpectedGuardMagic uint32 = 0x05585452 // 'R','T','X',0x05

// NativeGuard provides the Linux/POSIX hardware-lock & binary attestation guard
// matching the exact Win32 NativeGuard API and Ed25519 signature verification contract.
type NativeGuard struct {
	dllPath      string
	dllSHA256Hex string
	exeSHA256Hex string
	hwidBytes    [32]byte
	hwidHex      string
	hwSummary    string
}

// LoadVerifiedNativeGuard verifies the signed guard image on disk against masterPub
// and computes SHA-256 digests of both the running binary and guard file for Super Admin attestation.
func LoadVerifiedNativeGuard(dllPath string, masterPub ed25519.PublicKey, expectedDLLSigHex string) (*NativeGuard, error) {
	if dllPath == "" {
		exePath, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("resolve executable path: %w", err)
		}
		dllPath = filepath.Join(filepath.Dir(exePath), "rtx5_guard.dll")
	}
	absDLL, err := filepath.Abs(dllPath)
	if err != nil {
		return nil, err
	}
	dllBytes, err := os.ReadFile(absDLL)
	if err != nil {
		return nil, fmt.Errorf("guard binary missing or unreadable at %s: %w", absDLL, err)
	}
	dllSum := sha256.Sum256(dllBytes)
	dllHex := hex.EncodeToString(dllSum[:])

	if len(masterPub) == ed25519.PublicKeySize && expectedDLLSigHex != "" {
		sigBytes, err := hex.DecodeString(expectedDLLSigHex)
		if err != nil || len(sigBytes) != ed25519.SignatureSize {
			return nil, errors.New("rtx5_guard signature malformed")
		}
		msg := append([]byte("RTX5-GUARD-DLL-V2:"), dllSum[:]...)
		if !ed25519.Verify(masterPub, msg, sigBytes) {
			return nil, errors.New("SECURITY ALERT: rtx5_guard failed Ed25519 signature verification (file tampered)")
		}
	}

	hwidBytes, hwidHex, summary := collectLinuxHardwareFingerprint()

	g := &NativeGuard{
		dllPath:      absDLL,
		dllSHA256Hex: dllHex,
		hwidBytes:    hwidBytes,
		hwidHex:      hwidHex,
		hwSummary:    summary,
	}

	if exePath, err := os.Executable(); err == nil {
		if h, herr := g.HashFileSHA256(exePath); herr == nil {
			g.exeSHA256Hex = h
		}
	}
	return g, nil
}

func (g *NativeGuard) DLLSHA256() string { return g.dllSHA256Hex }
func (g *NativeGuard) ExeSHA256() string { return g.exeSHA256Hex }

// SignGuardDLLHash produces the Ed25519 signature over the guard file's SHA-256 digest.
func SignGuardDLLHash(masterPriv ed25519.PrivateKey, dllPath string) (dllSHA256Hex string, sigHex string, err error) {
	b, err := os.ReadFile(dllPath)
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256(b)
	msg := append([]byte("RTX5-GUARD-DLL-V2:"), sum[:]...)
	sig := ed25519.Sign(masterPriv, msg)
	return hex.EncodeToString(sum[:]), hex.EncodeToString(sig), nil
}

func readTrimmedFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func collectLinuxHardwareFingerprint() (hwidBytes [32]byte, hwidHex string, summary string) {
	machineID := readTrimmedFile("/etc/machine-id")
	if machineID == "" {
		machineID = readTrimmedFile("/var/lib/dbus/machine-id")
	}
	productUUID := readTrimmedFile("/sys/class/dmi/id/product_uuid")
	boardSerial := readTrimmedFile("/sys/class/dmi/id/board_serial")
	sysVendor := readTrimmedFile("/sys/class/dmi/id/sys_vendor")
	productName := readTrimmedFile("/sys/class/dmi/id/product_name")
	hostname, _ := os.Hostname()

	cpuModel := runtime.GOARCH
	if cpuBytes, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		for _, line := range strings.Split(string(cpuBytes), "\n") {
			if strings.HasPrefix(strings.ToLower(line), "model name") {
				if idx := strings.IndexByte(line, ':'); idx >= 0 {
					cpuModel = strings.TrimSpace(line[idx+1:])
					break
				}
			}
		}
	}

	raw := fmt.Sprintf("RTX5-LINUX-HWID-V2|mid=%s|uuid=%s|board=%s|vendor=%s|prod=%s|cpu=%s|host=%s",
		machineID, productUUID, boardSerial, sysVendor, productName, cpuModel, hostname)
	hwidBytes = sha256.Sum256([]byte(raw))
	hwidHex = hex.EncodeToString(hwidBytes[:])

	shortMid := machineID
	if len(shortMid) > 12 {
		shortMid = shortMid[:12]
	}
	summary = fmt.Sprintf("Linux/%s|Host:%s|MID:%s|Vendor:%s|CPU:%s",
		runtime.GOARCH, hostname, shortMid, sysVendor, cpuModel)
	if len(summary) > 240 {
		summary = summary[:240]
	}
	return hwidBytes, hwidHex, summary
}

// CollectHardwareFingerprint gathers the Linux machine-id, DMI SMBIOS UUID, board serial, and CPU model.
func (g *NativeGuard) CollectHardwareFingerprint() (hwidHex string, summary string, err error) {
	if g.hwidHex == "" {
		g.hwidBytes, g.hwidHex, g.hwSummary = collectLinuxHardwareFingerprint()
	}
	return g.hwidHex, g.hwSummary, nil
}

func (g *NativeGuard) deriveMachineSealKey(entropy []byte) [32]byte {
	if g.hwidHex == "" {
		g.hwidBytes, g.hwidHex, g.hwSummary = collectLinuxHardwareFingerprint()
	}
	h := sha256.New()
	_, _ = h.Write([]byte("RTX5-LINUX-MACHINE-SEAL-V2:"))
	_, _ = h.Write(g.hwidBytes[:])
	if len(entropy) > 0 {
		_, _ = h.Write(entropy)
	}
	var key [32]byte
	copy(key[:], h.Sum(nil))
	return key
}

// SealMachineSecret encrypts plain bytes using hardware-bound AES-256-GCM keyed by the Linux HWID + Broker entropy.
func (g *NativeGuard) SealMachineSecret(plain []byte, entropy []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, errors.New("empty secret")
	}
	key := g.deriveMachineSealKey(entropy)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nonce, nonce, plain, entropy)
	return sealed, nil
}

// UnsealMachineSecret decrypts a hardware-sealed Linux machine blob. Fails immediately if copied to another Linux host!
func (g *NativeGuard) UnsealMachineSecret(cipherBlob []byte, entropy []byte) ([]byte, error) {
	if len(cipherBlob) == 0 {
		return nil, errors.New("empty cipher blob")
	}
	key := g.deriveMachineSealKey(entropy)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(cipherBlob) < ns+gcm.Overhead() {
		return nil, errors.New("Linux machine-lock unseal rejected: truncated cipher blob")
	}
	plain, err := gcm.Open(nil, cipherBlob[:ns], cipherBlob[ns:], entropy)
	if err != nil {
		return nil, fmt.Errorf("Linux machine-lock unseal rejected (copied folder or foreign hardware/OS detected): %w", err)
	}
	return plain, nil
}

// HashFileSHA256 computes the SHA-256 hex digest of a binary image on disk.
func (g *NativeGuard) HashFileSHA256(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}
