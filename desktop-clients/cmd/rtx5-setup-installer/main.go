//go:build windows

package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2"
	"golang.org/x/sys/windows/registry"

	"rtx5-desktop-clients/clientcore"
)

//go:embed rtx5-app-icon.png
var embeddedLogoPNG []byte

const setupMagic = "RTX5SET1"

type ShortcutSpec struct {
	Name string `json:"name"`
	Exe  string `json:"exe"`
}

type SetupMeta struct {
	ID         string         `json:"id"`
	Title      string         `json:"title"`
	Version    string         `json:"version"`
	Publisher  string         `json:"publisher"`
	FolderName string         `json:"folder_name"`
	MainExe    string         `json:"main_exe"`
	Shortcuts  []ShortcutSpec `json:"shortcuts"`
}

type InstallOptions struct {
	InstallDir      string `json:"install_dir"`
	DesktopShortcut bool   `json:"desktop_shortcut"`
	StartMenu       bool   `json:"start_menu"`
	LaunchAfter     bool   `json:"launch_after"`
}

type InstallResult struct {
	OK          bool   `json:"ok"`
	Error       string `json:"error,omitempty"`
	InstallDir  string `json:"install_dir"`
	FilesCopied int    `json:"files_copied"`
}

func main() {
	args := os.Args[1:]

	// Mode 1: Builder CLI mode (--pack-zip <zipPath> --out <outSetupExe>)
	var packZipPath, outExePath string
	var silentMode bool
	var uninstallDir string
	var uninstallID string

	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--pack-zip" && i+1 < len(args):
			packZipPath = args[i+1]
			i++
		case arg == "--out" && i+1 < len(args):
			outExePath = args[i+1]
			i++
		case arg == "--silent" || arg == "-silent" || strings.EqualFold(arg, "/S") || strings.EqualFold(arg, "/silent"):
			silentMode = true
		case arg == "--uninstall-id" && i+1 < len(args):
			uninstallID = args[i+1]
			i++
		case arg == "--uninstall-dir" && i+1 < len(args):
			uninstallDir = args[i+1]
			i++
		}
	}

	if packZipPath != "" && outExePath != "" {
		if err := packSelfExtractingSetup(packZipPath, outExePath); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}

	if uninstallID != "" {
		performUninstall(uninstallID, uninstallDir)
		os.Exit(0)
	}

	// Open appended ZIP payload from end of our own .exe
	zr, meta, err := openSelfPayloadZip()
	if err != nil {
		if silentMode {
			os.Exit(1)
		}
		showNativeMessageBox("RTX5 Setup Installer", "Setup payload was not found inside this executable.\n\nUse RTX5-Terminal-Setup64.exe, RTX5-Broker-Setup64.exe, or RTX5-SuperAdmin-Setup64.exe.", 0x10)
		os.Exit(1)
	}

	defaultInstallDir := resolveDefaultInstallDir(meta.FolderName)

	// Mode 2: Silent install (--silent or /S)
	if silentMode {
		res := executeInstall(zr, meta, InstallOptions{
			InstallDir:      defaultInstallDir,
			DesktopShortcut: true,
			StartMenu:       true,
			LaunchAfter:     false,
		})
		if !res.OK {
			os.Exit(1)
		}
		os.Exit(0)
	}

	// Mode 3: Interactive Native WebView2 Setup Wizard
	runInteractiveSetupWizard(zr, meta, defaultInstallDir)
}

func resolveDefaultInstallDir(folderName string) string {
	folderName = strings.TrimSpace(folderName)
	if folderName == "" {
		folderName = "Trader Terminal"
	}
	localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if localAppData == "" {
		home, _ := os.UserHomeDir()
		localAppData = filepath.Join(home, "AppData", "Local")
	}
	return filepath.Join(localAppData, "Programs", "RTX5", folderName)
}

func packSelfExtractingSetup(zipPath, outExePath string) error {
	selfPath, err := os.Executable()
	if err != nil {
		return err
	}
	selfBytes, err := os.ReadFile(selfPath)
	if err != nil {
		return err
	}
	// Strip existing trailer + payload if self already had one
	if len(selfBytes) >= 24 && string(selfBytes[len(selfBytes)-8:]) == setupMagic {
		zipOff := binary.LittleEndian.Uint64(selfBytes[len(selfBytes)-24 : len(selfBytes)-16])
		if zipOff > 0 && zipOff < uint64(len(selfBytes)-24) {
			selfBytes = selfBytes[:zipOff]
		}
	}

	zipBytes, err := os.ReadFile(zipPath)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(outExePath), 0755); err != nil {
		return err
	}
	outFile, err := os.OpenFile(outExePath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	defer outFile.Close()

	zipOffset := uint64(len(selfBytes))
	zipSize := uint64(len(zipBytes))

	if _, err := outFile.Write(selfBytes); err != nil {
		return err
	}
	if _, err := outFile.Write(zipBytes); err != nil {
		return err
	}

	var trailer [24]byte
	binary.LittleEndian.PutUint64(trailer[0:8], zipOffset)
	binary.LittleEndian.PutUint64(trailer[8:16], zipSize)
	copy(trailer[16:24], []byte(setupMagic))
	if _, err := outFile.Write(trailer[:]); err != nil {
		return err
	}
	return nil
}

func openSelfPayloadZip() (*zip.Reader, SetupMeta, error) {
	var meta SetupMeta
	selfPath, err := os.Executable()
	if err != nil {
		return nil, meta, err
	}
	f, err := os.Open(selfPath)
	if err != nil {
		return nil, meta, err
	}
	st, err := f.Stat()
	if err != nil || st.Size() < 24 {
		_ = f.Close()
		return nil, meta, fmt.Errorf("file too small")
	}

	var trailer [24]byte
	if _, err := f.ReadAt(trailer[:], st.Size()-24); err != nil {
		_ = f.Close()
		return nil, meta, err
	}
	if string(trailer[16:24]) != setupMagic {
		_ = f.Close()
		return nil, meta, fmt.Errorf("missing %s trailer", setupMagic)
	}

	zipOffset := int64(binary.LittleEndian.Uint64(trailer[0:8]))
	zipSize := int64(binary.LittleEndian.Uint64(trailer[8:16]))
	if zipOffset <= 0 || zipSize <= 0 || zipOffset+zipSize > st.Size()-24 {
		_ = f.Close()
		return nil, meta, fmt.Errorf("invalid zip bounds")
	}

	section := io.NewSectionReader(f, zipOffset, zipSize)
	zr, err := zip.NewReader(section, zipSize)
	if err != nil {
		_ = f.Close()
		return nil, meta, err
	}

	for _, zf := range zr.File {
		if strings.EqualFold(filepath.Base(zf.Name), "setup-meta.json") {
			rc, err := zf.Open()
			if err != nil {
				return nil, meta, err
			}
			raw, err := io.ReadAll(rc)
			_ = rc.Close()
			if err != nil {
				return nil, meta, err
			}
			if err := json.Unmarshal(raw, &meta); err != nil {
				return nil, meta, err
			}
			break
		}
	}
	if meta.ID == "" {
		meta.ID = "RTX5-Desktop"
	}
	if meta.Title == "" {
		meta.Title = "RTX5 Desktop Application (64-Bit)"
	}
	if meta.Version == "" {
		meta.Version = "2.2.6"
	}
	if meta.Publisher == "" {
		meta.Publisher = "RTX5 Trading Technologies"
	}
	if meta.FolderName == "" {
		meta.FolderName = "RTX5 Desktop"
	}
	return zr, meta, nil
}

func executeInstall(zr *zip.Reader, meta SetupMeta, opts InstallOptions) InstallResult {
	installDir := strings.TrimSpace(opts.InstallDir)
	if installDir == "" {
		installDir = resolveDefaultInstallDir(meta.FolderName)
	}
	installDir = filepath.Clean(installDir)

	if err := os.MkdirAll(installDir, 0755); err != nil {
		return InstallResult{OK: false, Error: err.Error(), InstallDir: installDir}
	}

	var totalBytes uint64
	filesCopied := 0

	for _, zf := range zr.File {
		cleanRel := filepath.Clean(filepath.FromSlash(zf.Name))
		if cleanRel == "." || strings.HasPrefix(cleanRel, "..") || filepath.IsAbs(cleanRel) {
			continue
		}
		if strings.EqualFold(cleanRel, "setup-meta.json") {
			continue
		}
		dstPath := filepath.Join(installDir, cleanRel)
		if zf.FileInfo().IsDir() {
			_ = os.MkdirAll(dstPath, 0755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dstPath), 0755); err != nil {
			return InstallResult{OK: false, Error: err.Error(), InstallDir: installDir}
		}

		rc, err := zf.Open()
		if err != nil {
			return InstallResult{OK: false, Error: err.Error(), InstallDir: installDir}
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return InstallResult{OK: false, Error: err.Error(), InstallDir: installDir}
		}

		if err := writeFileReplacingLocked(dstPath, data); err != nil {
			return InstallResult{OK: false, Error: err.Error(), InstallDir: installDir}
		}
		totalBytes += uint64(len(data))
		filesCopied++
	}

	// Ensure rtx5.ico is present in installDir
	icoPath := filepath.Join(installDir, "rtx5.ico")

	// Create shortcuts using in-process Windows COM IShellLinkW (never spawns cmd/powershell!)
	if opts.DesktopShortcut {
		desktopDir := getUserShellFolder("Desktop")
		if desktopDir != "" {
			for _, sc := range meta.Shortcuts {
				if sc.Name == "" || sc.Exe == "" {
					continue
				}
				lnkPath := filepath.Join(desktopDir, sc.Name+".lnk")
				targetExe := filepath.Join(installDir, sc.Exe)
				_ = createShellLinkShortcut(lnkPath, targetExe, installDir, meta.Title, icoPath)
			}
		}
	}

	if opts.StartMenu {
		startProgramsDir := getStartMenuProgramsDir()
		if startProgramsDir != "" {
			rtxMenuDir := filepath.Join(startProgramsDir, "RTX5")
			_ = os.MkdirAll(rtxMenuDir, 0755)
			for _, sc := range meta.Shortcuts {
				if sc.Name == "" || sc.Exe == "" {
					continue
				}
				lnkPath := filepath.Join(rtxMenuDir, sc.Name+".lnk")
				targetExe := filepath.Join(installDir, sc.Exe)
				_ = createShellLinkShortcut(lnkPath, targetExe, installDir, meta.Title, icoPath)
			}
		}
	}

	// Write HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<id>
	_ = writeUninstallRegistry(meta, installDir, icoPath, totalBytes)

	return InstallResult{
		OK:          true,
		InstallDir:  installDir,
		FilesCopied: filesCopied,
	}
}

func writeFileReplacingLocked(dstPath string, data []byte) error {
	if err := os.WriteFile(dstPath, data, 0755); err == nil {
		return nil
	}
	oldBak := dstPath + ".running_old"
	_ = os.Remove(oldBak)
	_ = os.Rename(dstPath, oldBak)
	return os.WriteFile(dstPath, data, 0755)
}

func getUserShellFolder(sub string) string {
	// Query HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders`, registry.QUERY_VALUE)
	if err == nil {
		val, _, verr := k.GetStringValue(sub)
		_ = k.Close()
		if verr == nil && strings.TrimSpace(val) != "" {
			return val
		}
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		return filepath.Join(home, sub)
	}
	return ""
}

func getStartMenuProgramsDir() string {
	if p := getUserShellFolder("Programs"); p != "" {
		return p
	}
	appData := strings.TrimSpace(os.Getenv("APPDATA"))
	if appData != "" {
		return filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs")
	}
	return ""
}

// createShellLinkShortcut creates a standard Windows .lnk shortcut in-process via COM IShellLinkW + IPersistFile
// without ever launching cmd.exe, powershell.exe, or wscript.exe.
func createShellLinkShortcut(lnkPath, targetPath, workingDir, description, iconPath string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	ole32 := syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx := ole32.NewProc("CoInitializeEx")
	procCoCreateInstance := ole32.NewProc("CoCreateInstance")

	// COINIT_APARTMENTTHREADED = 0x2
	_, _, _ = procCoInitializeEx.Call(0, 0x2)

	// CLSID_ShellLink = {00021401-0000-0000-C000-000000000046}
	clsidShellLink := [16]byte{0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}
	// IID_IShellLinkW = {000214F9-0000-0000-C000-000000000046}
	iidIShellLinkW := [16]byte{0xF9, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}
	// IID_IPersistFile = {0000010b-0000-0000-C000-000000000046}
	iidIPersistFile := [16]byte{0x0B, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}

	const clsctxInprocServer = 1
	var pShellLink uintptr
	hr, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidShellLink[0])),
		0,
		clsctxInprocServer,
		uintptr(unsafe.Pointer(&iidIShellLinkW[0])),
		uintptr(unsafe.Pointer(&pShellLink)),
	)
	if int32(hr) < 0 || pShellLink == 0 {
		return fmt.Errorf("CoCreateInstance IShellLinkW failed: 0x%x", hr)
	}
	vtable := (*[32]uintptr)(*(*unsafe.Pointer)(unsafe.Pointer(pShellLink)))
	defer syscall.SyscallN(vtable[2], pShellLink) // Release

	// SetPath (index 20)
	if uTarget, err := syscall.UTF16PtrFromString(targetPath); err == nil {
		_, _, _ = syscall.SyscallN(vtable[20], pShellLink, uintptr(unsafe.Pointer(uTarget)))
	}
	// SetWorkingDirectory (index 9)
	if uWork, err := syscall.UTF16PtrFromString(workingDir); err == nil {
		_, _, _ = syscall.SyscallN(vtable[9], pShellLink, uintptr(unsafe.Pointer(uWork)))
	}
	// SetDescription (index 7)
	if uDesc, err := syscall.UTF16PtrFromString(description); err == nil {
		_, _, _ = syscall.SyscallN(vtable[7], pShellLink, uintptr(unsafe.Pointer(uDesc)))
	}
	// SetIconLocation (index 17)
	iconSource := iconPath
	if st, err := os.Stat(iconSource); err != nil || st.IsDir() {
		iconSource = targetPath
	}
	if uIcon, err := syscall.UTF16PtrFromString(iconSource); err == nil {
		_, _, _ = syscall.SyscallN(vtable[17], pShellLink, uintptr(unsafe.Pointer(uIcon)), 0)
	}

	// QueryInterface (index 0) for IID_IPersistFile
	var pPersistFile uintptr
	hr, _, _ = syscall.SyscallN(
		vtable[0],
		pShellLink,
		uintptr(unsafe.Pointer(&iidIPersistFile[0])),
		uintptr(unsafe.Pointer(&pPersistFile)),
	)
	if int32(hr) < 0 || pPersistFile == 0 {
		return fmt.Errorf("QueryInterface IPersistFile failed: 0x%x", hr)
	}
	pfVtable := (*[16]uintptr)(*(*unsafe.Pointer)(unsafe.Pointer(pPersistFile)))
	defer syscall.SyscallN(pfVtable[2], pPersistFile) // Release

	_ = os.MkdirAll(filepath.Dir(lnkPath), 0755)
	uLnk, err := syscall.UTF16PtrFromString(lnkPath)
	if err != nil {
		return err
	}
	// IPersistFile::Save (index 6)
	hr, _, _ = syscall.SyscallN(pfVtable[6], pPersistFile, uintptr(unsafe.Pointer(uLnk)), 1)
	if int32(hr) < 0 {
		return fmt.Errorf("IPersistFile.Save failed: 0x%x", hr)
	}
	return nil
}

func writeUninstallRegistry(meta SetupMeta, installDir, icoPath string, totalBytes uint64) error {
	keyPath := `Software\Microsoft\Windows\CurrentVersion\Uninstall\` + meta.ID
	k, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()

	displayIcon := icoPath
	if st, err := os.Stat(displayIcon); err != nil || st.IsDir() {
		if meta.MainExe != "" {
			displayIcon = filepath.Join(installDir, meta.MainExe)
		}
	}

	// Copy uninstaller binary (without payload) into installDir\ RTX5-Uninstall.exe
	uninstallExe := filepath.Join(installDir, "RTX5-Uninstall.exe")
	if selfPath, err := os.Executable(); err == nil {
		if selfBytes, err := os.ReadFile(selfPath); err == nil {
			if len(selfBytes) >= 24 && string(selfBytes[len(selfBytes)-8:]) == setupMagic {
				zipOff := binary.LittleEndian.Uint64(selfBytes[len(selfBytes)-24 : len(selfBytes)-16])
				if zipOff > 0 && zipOff < uint64(len(selfBytes)-24) {
					selfBytes = selfBytes[:zipOff]
				}
			}
			_ = os.WriteFile(uninstallExe, selfBytes, 0755)
		}
	}
	uninstallCmd := fmt.Sprintf(`"%s" --uninstall-id "%s" --uninstall-dir "%s"`, uninstallExe, meta.ID, installDir)

	_ = k.SetStringValue("DisplayName", meta.Title)
	_ = k.SetStringValue("DisplayVersion", meta.Version)
	_ = k.SetStringValue("Publisher", meta.Publisher)
	_ = k.SetStringValue("InstallLocation", installDir)
	_ = k.SetStringValue("DisplayIcon", displayIcon)
	_ = k.SetStringValue("UninstallString", uninstallCmd)
	_ = k.SetStringValue("InstallDate", time.Now().Format("20060102"))
	_ = k.SetDWordValue("NoModify", 1)
	_ = k.SetDWordValue("NoRepair", 1)
	sizeKB := uint32(totalBytes / 1024)
	if sizeKB == 0 {
		sizeKB = 10240
	}
	_ = k.SetDWordValue("EstimatedSize", sizeKB)
	return nil
}

func performUninstall(appID, installDir string) {
	keyPath := `Software\Microsoft\Windows\CurrentVersion\Uninstall\` + appID
	_ = registry.DeleteKey(registry.CURRENT_USER, keyPath)
	if installDir != "" && strings.Contains(strings.ToLower(installDir), "rtx5") {
		_ = os.RemoveAll(installDir)
	}
}

func showNativeMessageBox(title, message string, flags uintptr) {
	user32 := syscall.NewLazyDLL("user32.dll")
	procMessageBoxW := user32.NewProc("MessageBoxW")
	uTitle, _ := syscall.UTF16PtrFromString(title)
	uMsg, _ := syscall.UTF16PtrFromString(message)
	_, _, _ = procMessageBoxW.Call(0, uintptr(unsafe.Pointer(uMsg)), uintptr(unsafe.Pointer(uTitle)), flags)
}

func launchInstalledMainExe(installDir, mainExe string) {
	if mainExe == "" {
		return
	}
	exePath := filepath.Join(installDir, mainExe)
	if _, err := os.Stat(exePath); err != nil {
		return
	}
	cmd := exec.Command(exePath)
	cmd.Dir = installDir
	_ = cmd.Start()
}

func runInteractiveSetupWizard(zr *zip.Reader, meta SetupMeta, defaultInstallDir string) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	clientcore.EnableProcessDPIAwareness()
	clientcore.SetProcessAppUserModelID("RTX5.Desktop.SetupInstaller." + meta.ID)

	baseProfileDir := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if baseProfileDir == "" {
		baseProfileDir = os.TempDir()
	}
	profileDir := filepath.Join(baseProfileDir, "RTX5-Native-WebView2", "setup-wizard-"+meta.ID)
	_ = os.MkdirAll(profileDir, 0700)

	_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
		"--disable-extensions --disable-component-extensions-with-background-pages --disable-default-apps --disable-sync --no-first-run --no-default-browser-check")

	logoB64 := base64.StdEncoding.EncodeToString(embeddedLogoPNG)
	wizardHTML := buildWizardHTML(meta, defaultInstallDir, logoB64)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		// Fallback to direct silent install + launch if loopback listener fails
		res := executeInstall(zr, meta, InstallOptions{
			InstallDir:      defaultInstallDir,
			DesktopShortcut: true,
			StartMenu:       true,
			LaunchAfter:     true,
		})
		if res.OK {
			launchInstalledMainExe(res.InstallDir, meta.MainExe)
		}
		return
	}
	defer ln.Close()

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  profileDir,
		WindowOptions: webview2.WindowOptions{
			Title:  meta.Title + " Setup",
			Width:  640,
			Height: 480,
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		res := executeInstall(zr, meta, InstallOptions{
			InstallDir:      defaultInstallDir,
			DesktopShortcut: true,
			StartMenu:       true,
			LaunchAfter:     true,
		})
		if res.OK {
			launchInstalledMainExe(res.InstallDir, meta.MainExe)
		}
		return
	}
	defer w.Destroy()

	if hwnd := uintptr(w.Window()); hwnd != 0 {
		clientcore.ApplyDarkTitlebarAndIcon(hwnd)
	}

	doInstall := func(opts InstallOptions) InstallResult {
		res := executeInstall(zr, meta, opts)
		if res.OK && opts.LaunchAfter {
			go func(dir string) {
				time.Sleep(450 * time.Millisecond)
				launchInstalledMainExe(dir, meta.MainExe)
				time.Sleep(250 * time.Millisecond)
				w.Terminate()
			}(res.InstallDir)
		}
		return res
	}

	_ = w.Bind("rtx5Install", func(opts InstallOptions) InstallResult {
		return doInstall(opts)
	})
	_ = w.Bind("rtx5Close", func() {
		w.Terminate()
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = rw.Write([]byte(wizardHTML))
	})
	mux.HandleFunc("/api/install", func(rw http.ResponseWriter, r *http.Request) {
		var opts InstallOptions
		_ = json.NewDecoder(r.Body).Decode(&opts)
		res := doInstall(opts)
		rw.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(rw).Encode(res)
	})
	mux.HandleFunc("/api/close", func(rw http.ResponseWriter, r *http.Request) {
		rw.WriteHeader(http.StatusOK)
		go func() {
			time.Sleep(100 * time.Millisecond)
			w.Terminate()
		}()
	})

	srv := &http.Server{Handler: mux}
	go func() {
		_ = srv.Serve(ln)
	}()

	w.Navigate("http://" + ln.Addr().String() + "/")
	w.Run()
}

func buildWizardHTML(meta SetupMeta, defaultInstallDir, logoB64 string) string {
	metaJSON, _ := json.Marshal(meta)
	dirJSON, _ := json.Marshal(defaultInstallDir)

	var buf bytes.Buffer
	buf.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RTX5 Setup</title>
<style>
  * { box-sizing: border-box; user-select: none; margin: 0; padding: 0; }
  body {
    background: linear-gradient(160deg, #13161c 0%, #0d0f14 100%);
    color: #e6edf3;
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 26px 30px 22px;
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 18px;
    padding-bottom: 18px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .logo {
    width: 62px;
    height: 62px;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    flex-shrink: 0;
  }
  .title-wrap h1 {
    font-size: 19px;
    font-weight: 600;
    color: #ffffff;
    letter-spacing: -0.2px;
  }
  .badges {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .badge {
    font-size: 11.5px;
    font-weight: 600;
    padding: 2px 9px;
    border-radius: 999px;
    background: rgba(122, 193, 66, 0.16);
    color: #8ce24c;
    border: 1px solid rgba(122, 193, 66, 0.35);
  }
  .publisher {
    font-size: 12px;
    color: #8b949e;
  }
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 16px;
  }
  .field-label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #8b949e;
    margin-bottom: 6px;
  }
  .dir-input {
    width: 100%;
    background: #181c24;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px;
    color: #f0f6fc;
    font-family: Consolas, "Segoe UI", monospace;
    font-size: 12.5px;
    padding: 10px 12px;
    outline: none;
  }
  .dir-input:focus {
    border-color: #7ac142;
  }
  .options {
    background: rgba(24, 28, 36, 0.72);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    padding: 13px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  label.chk {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13.5px;
    color: #d0d7de;
    cursor: pointer;
  }
  label.chk input {
    width: 16px;
    height: 16px;
    accent-color: #7ac142;
    cursor: pointer;
  }
  .progress-wrap {
    display: none;
    flex-direction: column;
    gap: 8px;
  }
  .progress-bar-bg {
    width: 100%;
    height: 8px;
    background: #1c212b;
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #6cc036, #9be85d);
    transition: width 0.25s ease;
  }
  .status-text {
    font-size: 12.5px;
    color: #8ce24c;
  }
  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 16px;
    border-top: 1px solid rgba(255,255,255,0.08);
  }
  .sec-note {
    font-size: 11.5px;
    color: #6e7681;
  }
  .btns {
    display: flex;
    gap: 10px;
  }
  button {
    font-family: inherit;
    font-size: 13.5px;
    font-weight: 600;
    padding: 9px 20px;
    border-radius: 8px;
    cursor: pointer;
    border: none;
    transition: all 0.15s ease;
  }
  .btn-cancel {
    background: rgba(255,255,255,0.06);
    color: #c9d1d9;
    border: 1px solid rgba(255,255,255,0.1);
  }
  .btn-cancel:hover {
    background: rgba(255,255,255,0.11);
  }
  .btn-install {
    background: linear-gradient(180deg, #7ed348 0%, #63b331 100%);
    color: #0b0e12;
    box-shadow: 0 4px 14px rgba(114, 198, 60, 0.3);
  }
  .btn-install:hover {
    filter: brightness(1.06);
  }
  .btn-install:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
</head>
<body>
  <div class="header">
    <img class="logo" src="data:image/png;base64,` + logoB64 + `" alt="RTX5" />
    <div class="title-wrap">
      <h1 id="appTitle"></h1>
      <div class="badges">
        <span class="badge" id="appVer"></span>
        <span class="publisher" id="appPub"></span>
      </div>
    </div>
  </div>

  <div class="content">
    <div>
      <div class="field-label">Target Installation Folder</div>
      <input id="installDir" class="dir-input" type="text" spellcheck="false" />
    </div>

    <div class="options">
      <label class="chk"><input type="checkbox" id="chkDesktop" checked /> Create Desktop shortcut(s)</label>
      <label class="chk"><input type="checkbox" id="chkStartMenu" checked /> Create Start Menu shortcut(s)</label>
      <label class="chk"><input type="checkbox" id="chkLaunch" checked /> Launch application when setup finishes</label>
    </div>

    <div class="progress-wrap" id="progressWrap">
      <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressFill"></div></div>
      <div class="status-text" id="statusText">Installing native 64-bit binaries &amp; guard verification...</div>
    </div>
  </div>

  <div class="footer">
    <div class="sec-note">Ed25519 + X25519 Encrypted Binary TCP Native Suite</div>
    <div class="btns">
      <button class="btn-cancel" id="btnCancel" onclick="closeSetup()">Cancel</button>
      <button class="btn-install" id="btnInstall" onclick="startInstall()">Install Now</button>
    </div>
  </div>

<script>
  const meta = ` + string(metaJSON) + `;
  const defaultDir = ` + string(dirJSON) + `;
  document.getElementById('appTitle').textContent = meta.title;
  document.getElementById('appVer').textContent = 'v' + meta.version;
  document.getElementById('appPub').textContent = meta.publisher;
  document.getElementById('installDir').value = defaultDir;

  async function closeSetup() {
    if (typeof window.rtx5Close === 'function') {
      await window.rtx5Close();
    } else {
      await fetch('/api/close', { method: 'POST' });
    }
  }

  async function startInstall() {
    const btn = document.getElementById('btnInstall');
    const cancelBtn = document.getElementById('btnCancel');
    const pw = document.getElementById('progressWrap');
    const pf = document.getElementById('progressFill');
    const st = document.getElementById('statusText');

    btn.disabled = true;
    btn.textContent = 'Installing...';
    pw.style.display = 'flex';
    pf.style.width = '45%';

    const opts = {
      install_dir: document.getElementById('installDir').value,
      desktop_shortcut: document.getElementById('chkDesktop').checked,
      start_menu: document.getElementById('chkStartMenu').checked,
      launch_after: document.getElementById('chkLaunch').checked
    };

    try {
      let res;
      if (typeof window.rtx5Install === 'function') {
        res = await window.rtx5Install(opts);
      } else {
        const r = await fetch('/api/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts)
        });
        res = await r.json();
      }
      if (res && res.ok) {
        pf.style.width = '100%';
        st.textContent = '100% Complete — Installed to ' + res.install_dir;
        btn.textContent = 'Installed (100%)';
        cancelBtn.textContent = 'Close';
      } else {
        st.style.color = '#ff7b72';
        st.textContent = 'Error: ' + ((res && res.error) ? res.error : 'Installation failed');
        btn.disabled = false;
        btn.textContent = 'Retry Install';
      }
    } catch (e) {
      st.style.color = '#ff7b72';
      st.textContent = 'Error: ' + e;
      btn.disabled = false;
      btn.textContent = 'Retry Install';
    }
  }
</script>
</body>
</html>`)
	return buf.String()
}
