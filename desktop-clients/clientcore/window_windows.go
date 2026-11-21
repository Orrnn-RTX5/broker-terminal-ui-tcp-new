//go:build windows

package clientcore

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"github.com/jchv/go-webview2"
)

// SetProcessAppUserModelID sets a dedicated Windows AppUserModelID via shell32.dll
// so the Windows 10/11 Taskbar never groups RTX5 under a generic host icon.
func SetProcessAppUserModelID(appID string) {
	if strings.TrimSpace(appID) == "" {
		appID = "RTX5.Desktop.NativeClient"
	}
	shell32 := syscall.NewLazyDLL("shell32.dll")
	procSetAppID := shell32.NewProc("SetCurrentProcessExplicitAppUserModelID")
	if ptr, err := syscall.UTF16PtrFromString(appID); err == nil {
		_, _, _ = procSetAppID.Call(uintptr(unsafe.Pointer(ptr)))
	}
}

// ApplyDarkTitlebarAndIcon applies Windows 10/11 dark immersive titlebar attributes
// and sets the window & window-class icons (both BIG and SMALL) from embedded PE
// resource ID 1 (with fallback to rtx5.ico next to the executable).
func ApplyDarkTitlebarAndIcon(hwnd uintptr) {
	if hwnd == 0 {
		return
	}

	// 1. Enable Windows 10/11 Immersive Dark Titlebar (DWMWA_USE_IMMERSIVE_DARK_MODE = 20, fallback 19)
	dwmapi := syscall.NewLazyDLL("dwmapi.dll")
	procDwmSetWindowAttribute := dwmapi.NewProc("DwmSetWindowAttribute")
	darkMode := int32(1)
	_, _, _ = procDwmSetWindowAttribute.Call(hwnd, 20, uintptr(unsafe.Pointer(&darkMode)), unsafe.Sizeof(darkMode))
	_, _, _ = procDwmSetWindowAttribute.Call(hwnd, 19, uintptr(unsafe.Pointer(&darkMode)), unsafe.Sizeof(darkMode))

	// Paint a matching dark (#0a0c10) Win32 window background brush so WebView2
	// never flashes a white frame before the logo splash paints on Windows.
	gdi32 := syscall.NewLazyDLL("gdi32.dll")
	procCreateSolidBrush := gdi32.NewProc("CreateSolidBrush")
	if darkBrush, _, _ := procCreateSolidBrush.Call(uintptr(0x00100c0a)); darkBrush != 0 {
		user32Bg := syscall.NewLazyDLL("user32.dll")
		procSetClassBg := user32Bg.NewProc("SetClassLongPtrW")
		procInvalidateRect := user32Bg.NewProc("InvalidateRect")
		gclpHbrBackground := ^uintptr(9) // -10 in two's complement uintptr
		_, _, _ = procSetClassBg.Call(hwnd, gclpHbrBackground, darkBrush)
		_, _, _ = procInvalidateRect.Call(hwnd, 0, 1)
	}

	// 2. Load Icon ID 1 from embedded PE .rsrc (RT_GROUP_ICON ID 1) via LoadImageW
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	user32 := syscall.NewLazyDLL("user32.dll")
	procGetModuleHandleW := kernel32.NewProc("GetModuleHandleW")
	procLoadImageW := user32.NewProc("LoadImageW")
	procSendMessageW := user32.NewProc("SendMessageW")
	procSetClassLongPtrW := user32.NewProc("SetClassLongPtrW")

	const (
		imageIcon      = 1
		lrDefaultColor = 0x00000000
		lrLoadFromFile = 0x00000010
		wmSetIcon      = 0x0080
		iconSmall      = 0
		iconBig        = 1
	)

	hInst, _, _ := procGetModuleHandleW.Call(0)
	var hBig, hSmall uintptr
	if hInst != 0 {
		hBig, _, _ = procLoadImageW.Call(hInst, uintptr(1), imageIcon, 32, 32, lrDefaultColor)
		hSmall, _, _ = procLoadImageW.Call(hInst, uintptr(1), imageIcon, 16, 16, lrDefaultColor)
	}

	// 3. Fallback to rtx5.ico next to the executable if hBig or hSmall was not loaded
	if hBig == 0 || hSmall == 0 {
		if exePath, err := os.Executable(); err == nil {
			icoPath := filepath.Join(filepath.Dir(exePath), "rtx5.ico")
			if icoPtr, err := syscall.UTF16PtrFromString(icoPath); err == nil {
				if hBig == 0 {
					hBig, _, _ = procLoadImageW.Call(0, uintptr(unsafe.Pointer(icoPtr)), imageIcon, 32, 32, lrLoadFromFile)
				}
				if hSmall == 0 {
					hSmall, _, _ = procLoadImageW.Call(0, uintptr(unsafe.Pointer(icoPtr)), imageIcon, 16, 16, lrLoadFromFile)
				}
			}
		}
	}

	// 4. Apply both WM_SETICON and SetClassLongPtrW (GCLP_HICON = -14, GCLP_HICONSM = -34)
	gclpHIcon := ^uintptr(13)   // -14 in two's complement uintptr
	gclpHIconSm := ^uintptr(33) // -34 in two's complement uintptr
	if hBig != 0 {
		_, _, _ = procSendMessageW.Call(hwnd, wmSetIcon, iconBig, hBig)
		_, _, _ = procSetClassLongPtrW.Call(hwnd, gclpHIcon, hBig)
	}
	if hSmall != 0 {
		_, _, _ = procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, hSmall)
		_, _, _ = procSetClassLongPtrW.Call(hwnd, gclpHIconSm, hSmall)
	}
}

func (c *DesktopClient) runNativeWin32Window(urlStr string, profileName string, exeDir string, sigCh <-chan os.Signal) bool {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	appID := "RTX5.Desktop.NativeClient"
	if kindStr := strings.TrimSpace(string(c.cfg.Kind)); kindStr != "" {
		appID = "RTX5.Desktop.NativeClient." + kindStr
	}
	SetProcessAppUserModelID(appID)

	baseProfileDir := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if baseProfileDir == "" {
		baseProfileDir = os.TempDir()
	}
	profileDir := filepath.Join(baseProfileDir, "RTX5-Native-WebView2", profileName)
	_ = os.MkdirAll(profileDir, 0700)

	// Ensure WebView2 never loads browser extensions or Edge UI features
	_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
		"--disable-extensions --disable-component-extensions-with-background-pages --disable-default-apps --disable-sync --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-ipc-flooding-protection --disable-features=Translate,msEdgeSidebarV2,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ExtensionsToolbarMenu")

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     true,
		AutoFocus: true,
		DataPath:  profileDir,
		WindowOptions: webview2.WindowOptions{
			Title:  c.cfg.WindowTitle,
			Width:  1480,
			Height: 920,
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		return false
	}
	defer w.Destroy()

	// Apply custom RTX5 icon & dark titlebar to native Win32 HWND titlebar & taskbar and maximize window like MT5
	if hwnd := uintptr(w.Window()); hwnd != 0 {
		c.applyWin32WindowIconAndMaximize(hwnd)
	}

	go func() {
		<-sigCh
		w.Terminate()
	}()

	w.Navigate(urlStr)
	w.Run()
	return true
}

func (c *DesktopClient) applyWin32WindowIconAndMaximize(hwnd uintptr) {
	user32 := syscall.NewLazyDLL("user32.dll")
	procShowWindow := user32.NewProc("ShowWindow")
	procCreateIconFromResourceEx := user32.NewProc("CreateIconFromResourceEx")
	procSendMessageW := user32.NewProc("SendMessageW")
	procSetClassLongPtrW := user32.NewProc("SetClassLongPtrW")
	procGetClassLongPtrW := user32.NewProc("GetClassLongPtrW")

	// Apply PE RT_GROUP_ICON ID 1 + rtx5.ico fallback + dark titlebar
	ApplyDarkTitlebarAndIcon(hwnd)

	// Maximize window (SW_MAXIMIZE = 3)
	_, _, _ = procShowWindow.Call(hwnd, 3)

	// If neither PE resource ID 1 nor rtx5.ico yielded a class icon, fallback to embedded PNG via CreateIconFromResourceEx
	gclpHIcon := ^uintptr(13)
	existingBig, _, _ := procGetClassLongPtrW.Call(hwnd, gclpHIcon)
	if existingBig != 0 {
		return
	}

	activeFS := c.getActiveDistFS()
	candidates := []string{
		"brand/rtx5-app-icon.png",
		"titlebar-icon.png",
		"rtx5-logo.png",
		"admin-symbol.png",
		"favicon.png",
	}
	for _, cand := range candidates {
		f, err := activeFS.Open(cand)
		if err != nil {
			continue
		}
		pngBytes, rerr := io.ReadAll(f)
		_ = f.Close()
		if rerr == nil && len(pngBytes) > 8 {
			const lrDefaultColor = 0x00000000
			const wmSetIcon = 0x0080
			const iconSmall = 0
			const iconBig = 1

			hIconBig, _, _ := procCreateIconFromResourceEx.Call(
				uintptr(unsafe.Pointer(&pngBytes[0])),
				uintptr(len(pngBytes)),
				1,
				0x00030000,
				64,
				64,
				lrDefaultColor,
			)
			hIconSmall, _, _ := procCreateIconFromResourceEx.Call(
				uintptr(unsafe.Pointer(&pngBytes[0])),
				uintptr(len(pngBytes)),
				1,
				0x00030000,
				32,
				32,
				lrDefaultColor,
			)
			gclpHIconSm := ^uintptr(33)
			if hIconBig != 0 {
				_, _, _ = procSendMessageW.Call(hwnd, wmSetIcon, iconBig, hIconBig)
				_, _, _ = procSetClassLongPtrW.Call(hwnd, gclpHIcon, hIconBig)
			}
			if hIconSmall != 0 {
				_, _, _ = procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, hIconSmall)
				_, _, _ = procSetClassLongPtrW.Call(hwnd, gclpHIconSm, hIconSmall)
			}
			break
		}
	}
}
