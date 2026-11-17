//go:build (!windows && !darwin && !linux) || (!windows && !cgo)

package clientcore

import "os"

func (c *DesktopClient) runNativeWin32Window(urlStr string, profileName string, exeDir string, sigCh <-chan os.Signal) bool {
	return false
}
