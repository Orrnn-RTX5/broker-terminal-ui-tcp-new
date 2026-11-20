//go:build unix

package main

import "syscall"

func execSelfBinary(exePath string, argv []string, envv []string) error {
	return syscall.Exec(exePath, argv, envv)
}
