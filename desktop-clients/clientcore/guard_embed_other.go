//go:build !windows

package clientcore

import "log"

var embeddedAuthorityPubJSON []byte

func ensureEmbeddedGuardDLL() (string, error) {
	return "", nil
}

func fatalStartupError(format string, args ...any) {
	log.Fatalf(format, args...)
}
