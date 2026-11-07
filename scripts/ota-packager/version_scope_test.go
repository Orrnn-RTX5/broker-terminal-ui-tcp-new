package main

import "testing"

func TestCIAppOwnsOnlyItsOwnManifestEntries(t *testing.T) {
	cases := []struct {
		ciApp, key string
		want       bool
	}{
		{"superadmin-linux", "superadmin-linux", true},
		{"superadmin-linux", "broker-linux", false},
		{"superadmin-linux", "admin", false},
		{"broker-linux", "broker-linux", true},
		{"broker-linux", "broker-windows", true},
		{"broker-linux", "superadmin-linux", false},
		{"admin", "admin", true},
		{"admin", "manager", false},
		{"terminal", "terminal", true},
		{"terminal", "web-terminal-linux", false},
		{"version-only", "superadmin", false},
	}
	for _, c := range cases {
		if got := ciAppOwnsManifestKey(c.ciApp, c.key); got != c.want {
			t.Errorf("ciAppOwnsManifestKey(%q, %q) = %v, want %v", c.ciApp, c.key, got, c.want)
		}
	}
}
