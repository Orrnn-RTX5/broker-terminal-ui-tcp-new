//go:build darwin && cgo

package clientcore

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include <stdlib.h>

void rtx5_run_macos_webview(const char* url, const char* title);
void rtx5_quit_macos_webview(void);
*/
import "C"

import (
	"os"
	"runtime"
	"strings"
	"unsafe"
)

func (c *DesktopClient) runNativeWin32Window(urlStr string, profileName string, exeDir string, sigCh <-chan os.Signal) bool {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	title := strings.TrimSpace(c.cfg.WindowTitle)
	if title == "" {
		title = "RTX5 Desktop"
	}

	cURL := C.CString(urlStr)
	cTitle := C.CString(title)
	defer C.free(unsafe.Pointer(cURL))
	defer C.free(unsafe.Pointer(cTitle))

	go func() {
		<-sigCh
		C.rtx5_quit_macos_webview()
	}()

	C.rtx5_run_macos_webview(cURL, cTitle)
	return true
}
