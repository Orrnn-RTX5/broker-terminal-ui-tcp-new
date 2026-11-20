//go:build !unix

package main

import "errors"

func execSelfBinary(exePath string, argv []string, envv []string) error {
	return errors.New("in-place binary self-restart is only supported on unix/linux")
}
