//go:build windows

package clientcore

import (
	"bytes"
	_ "embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

//go:embed rtx5_guard.dll
var embeddedGuardDLL []byte

//go:embed authority-pub.json
var embeddedAuthorityPubJSON []byte

// ensureEmbeddedGuardDLL writes the embedded rtx5_guard.dll to a per-user
// directory so standalone .exe builds work even when shared without sidecar files.
func ensureEmbeddedGuardDLL() (string, error) {
	if len(embeddedGuardDLL) == 0 {
		return "", fmt.Errorf("embedded rtx5_guard.dll is empty")
	}
	baseDir := os.Getenv("LOCALAPPDATA")
	if baseDir == "" {
		baseDir = os.TempDir()
	}
	guardDir := filepath.Join(baseDir, "RTX5", "guard")
	if err := os.MkdirAll(guardDir, 0755); err != nil {
		return "", err
	}
	dst := filepath.Join(guardDir, "rtx5_guard.dll")
	if existing, err := os.ReadFile(dst); err == nil && bytes.Equal(existing, embeddedGuardDLL) {
		return dst, nil
	}
	if err := os.WriteFile(dst, embeddedGuardDLL, 0755); err != nil {
		return "", err
	}
	return dst, nil
}

// fatalStartupError logs the error and shows a Win32 MessageBox so -H=windowsgui
// binaries never exit silently when a startup check fails.
func fatalStartupError(format string, args ...any) {
	EnableProcessDPIAwareness()
	msg := fmt.Sprintf(format, args...)
	log.Println(msg)
	user32 := syscall.NewLazyDLL("user32.dll")
	msgBox := user32.NewProc("MessageBoxW")
	titlePtr, _ := syscall.UTF16PtrFromString("RTX5 Startup Error")
	msgPtr, _ := syscall.UTF16PtrFromString(msg)
	const mbOKError = 0x00000010
	_, _, _ = msgBox.Call(0, uintptr(unsafe.Pointer(msgPtr)), uintptr(unsafe.Pointer(titlePtr)), uintptr(mbOKError))
	os.Exit(1)
}
