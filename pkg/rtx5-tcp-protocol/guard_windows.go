//go:build windows

package rtx5tcp

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

const ExpectedGuardMagic uint32 = 0x05585452 // 'R','T','X',0x05

// NativeGuard wraps the signed Win32 rtx5_guard.dll after verifying its disk SHA-256
// and optional Ed25519 master signature (preventing proxy-DLL / replacement attacks).
type NativeGuard struct {
	dllPath         string
	dllSHA256Hex    string
	exeSHA256Hex    string
	dll             *syscall.DLL
	procMagic       *syscall.Proc
	procCollectHWID *syscall.Proc
	procSeal        *syscall.Proc
	procUnseal      *syscall.Proc
	procHashFile    *syscall.Proc
}

// LoadVerifiedNativeGuard verifies rtx5_guard.dll on disk BEFORE calling LoadLibrary,
// checks its exported protocol magic, and computes SHA-256 digests of both the running .exe
// and rtx5_guard.dll for real-time Super Admin binary attestation.
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
		return nil, fmt.Errorf("rtx5_guard.dll missing or unreadable at %s: %w", absDLL, err)
	}
	dllSum := sha256.Sum256(dllBytes)
	dllHex := hex.EncodeToString(dllSum[:])

	// If Ed25519 signature over SHA256("RTX5-GUARD-DLL-V2:" || dllSum) is supplied, enforce before LoadLibrary!
	if len(masterPub) == ed25519.PublicKeySize && expectedDLLSigHex != "" {
		sigBytes, err := hex.DecodeString(expectedDLLSigHex)
		if err != nil || len(sigBytes) != ed25519.SignatureSize {
			return nil, errors.New("rtx5_guard.dll signature malformed")
		}
		msg := append([]byte("RTX5-GUARD-DLL-V2:"), dllSum[:]...)
		if !ed25519.Verify(masterPub, msg, sigBytes) {
			return nil, errors.New("SECURITY ALERT: rtx5_guard.dll failed Ed25519 signature verification (DLL tampered or proxied)")
		}
	}

	dll, err := syscall.LoadDLL(absDLL)
	if err != nil {
		return nil, fmt.Errorf("LoadDLL(rtx5_guard.dll) failed: %w", err)
	}

	find := func(name string) (*syscall.Proc, error) {
		return dll.FindProc(name)
	}
	pMagic, err := find("RTX5Guard_Magic")
	if err != nil {
		return nil, err
	}
	pHWID, err := find("RTX5Guard_CollectHardwareFingerprint")
	if err != nil {
		return nil, err
	}
	pSeal, err := find("RTX5Guard_SealMachineSecret")
	if err != nil {
		return nil, err
	}
	pUnseal, err := find("RTX5Guard_UnsealMachineSecret")
	if err != nil {
		return nil, err
	}
	pHash, err := find("RTX5Guard_HashFileSHA256")
	if err != nil {
		return nil, err
	}

	r1, _, _ := pMagic.Call()
	if uint32(r1) != ExpectedGuardMagic {
		return nil, fmt.Errorf("rtx5_guard.dll returned unexpected magic 0x%08X", uint32(r1))
	}

	g := &NativeGuard{
		dllPath:         absDLL,
		dllSHA256Hex:    dllHex,
		dll:             dll,
		procMagic:       pMagic,
		procCollectHWID: pHWID,
		procSeal:        pSeal,
		procUnseal:      pUnseal,
		procHashFile:    pHash,
	}

	// Self-hash running .exe via rtx5_guard.dll's native Win32 CNG SHA-256
	exePath, err := os.Executable()
	if err == nil {
		if h, herr := g.HashFileSHA256(exePath); herr == nil {
			g.exeSHA256Hex = h
		}
	}
	if g.exeSHA256Hex == "" {
		if b, rerr := os.ReadFile(exePath); rerr == nil {
			s := sha256.Sum256(b)
			g.exeSHA256Hex = hex.EncodeToString(s[:])
		}
	}

	return g, nil
}

func (g *NativeGuard) DLLSHA256() string { return g.dllSHA256Hex }
func (g *NativeGuard) ExeSHA256() string { return g.exeSHA256Hex }

// SignGuardDLLHash produces the Ed25519 signature over rtx5_guard.dll's SHA-256 digest.
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

// CollectHardwareFingerprint invokes rtx5_guard.dll to gather MachineGuid + SMBIOS UEFI table + CPUID + Boot Volume Serial.
func (g *NativeGuard) CollectHardwareFingerprint() (hwidHex string, summary string, err error) {
	var hwid [32]byte
	var sumBuf [512]byte
	rc, _, _ := g.procCollectHWID.Call(
		uintptr(unsafe.Pointer(&hwid[0])),
		uintptr(unsafe.Pointer(&sumBuf[0])),
		uintptr(len(sumBuf)),
	)
	if int32(rc) != 0 {
		return "", "", fmt.Errorf("RTX5Guard_CollectHardwareFingerprint failed (rc=%d)", int32(rc))
	}
	n := 0
	for n < len(sumBuf) && sumBuf[n] != 0 {
		n++
	}
	return hex.EncodeToString(hwid[:]), string(sumBuf[:n]), nil
}

// SealMachineSecret encrypts plain bytes using Windows OS DPAPI (CRYPTPROTECT_LOCAL_MACHINE) + HWID/Broker entropy.
func (g *NativeGuard) SealMachineSecret(plain []byte, entropy []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, errors.New("empty secret")
	}
	var entPtr uintptr
	if len(entropy) > 0 {
		entPtr = uintptr(unsafe.Pointer(&entropy[0]))
	}
	outCap := uint32(len(plain) + 4096)
	outBuf := make([]byte, outCap)
	rc, _, _ := g.procSeal.Call(
		uintptr(unsafe.Pointer(&plain[0])),
		uintptr(uint32(len(plain))),
		entPtr,
		uintptr(uint32(len(entropy))),
		uintptr(unsafe.Pointer(&outBuf[0])),
		uintptr(unsafe.Pointer(&outCap)),
	)
	if int32(rc) == -3 && outCap > 0 {
		outBuf = make([]byte, outCap)
		rc, _, _ = g.procSeal.Call(
			uintptr(unsafe.Pointer(&plain[0])),
			uintptr(uint32(len(plain))),
			entPtr,
			uintptr(uint32(len(entropy))),
			uintptr(unsafe.Pointer(&outBuf[0])),
			uintptr(unsafe.Pointer(&outCap)),
		)
	}
	if int32(rc) != 0 {
		return nil, fmt.Errorf("Windows DPAPI CryptProtectData failed (rc=%d)", int32(rc))
	}
	return outBuf[:outCap], nil
}

// UnsealMachineSecret decrypts a DPAPI-sealed machine blob. Fails immediately if copied to another Windows PC or different HWID!
func (g *NativeGuard) UnsealMachineSecret(cipherBlob []byte, entropy []byte) ([]byte, error) {
	if len(cipherBlob) == 0 {
		return nil, errors.New("empty cipher blob")
	}
	var entPtr uintptr
	if len(entropy) > 0 {
		entPtr = uintptr(unsafe.Pointer(&entropy[0]))
	}
	outCap := uint32(len(cipherBlob) + 1024)
	outBuf := make([]byte, outCap)
	rc, _, _ := g.procUnseal.Call(
		uintptr(unsafe.Pointer(&cipherBlob[0])),
		uintptr(uint32(len(cipherBlob))),
		entPtr,
		uintptr(uint32(len(entropy))),
		uintptr(unsafe.Pointer(&outBuf[0])),
		uintptr(unsafe.Pointer(&outCap)),
	)
	if int32(rc) != 0 {
		return nil, fmt.Errorf("DPAPI machine-lock unseal rejected (copied folder or foreign hardware/OS detected, rc=%d)", int32(rc))
	}
	res := make([]byte, outCap)
	copy(res, outBuf[:outCap])
	for i := range outBuf {
		outBuf[i] = 0
	}
	return res, nil
}

// HashFileSHA256 hashes a binary image on disk via rtx5_guard.dll Win32 CNG SHA-256.
func (g *NativeGuard) HashFileSHA256(path string) (string, error) {
	u16, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	var out [32]byte
	rc, _, _ := g.procHashFile.Call(
		uintptr(unsafe.Pointer(u16)),
		uintptr(unsafe.Pointer(&out[0])),
	)
	if int32(rc) != 0 {
		return "", fmt.Errorf("RTX5Guard_HashFileSHA256 failed (rc=%d)", int32(rc))
	}
	return hex.EncodeToString(out[:]), nil
}
