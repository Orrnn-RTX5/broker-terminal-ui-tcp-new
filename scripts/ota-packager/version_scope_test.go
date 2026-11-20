package main

import (
	"testing"

	rtx5tcp "rtx5-tcp-protocol"
)

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

func TestMissingManifestEntryName(t *testing.T) {
	cases := []struct {
		ciApp, ch, name string
		ok              bool
	}{
		{"superadmin", "production", "RTX5 Super Admin Control Plane", true},
		{"superadmin", "beta", "RTX5 Super Admin Control Plane", true},
		{"superadmin", "alpha", "RTX5 Super Admin Control Plane", true},
		{"admin", "production", "RTX5 Broker Admin", true},
		{"admin", "beta", "RTX5 Broker Admin", true},
		{"admin", "alpha", "RTX5 Broker Admin", true},
		{"manager", "production", "RTX5 Dealing Desk Manager", true},
		{"manager", "beta", "RTX5 Dealing Desk Manager", true},
		{"manager", "alpha", "RTX5 Dealing Desk Manager", true},
		{"terminal", "production", "RTX5 Trader Terminal 64-Bit", true},
		{"terminal", "beta", "RTX5 Trader Terminal 64-Bit", true},
		{"terminal", "alpha", "RTX5 Trader Terminal 64-Bit", true},
		{"superadmin-linux", "production", "RTX5 Super Admin Linux VPS Backend (:9100 Hub + :8102 Control Plane)", true},
		{"superadmin-linux", "beta", "", false},
		{"superadmin-linux", "alpha", "", false},
		{"broker-linux", "production", "RTX5 Broker Linux VPS Backend (:4443 + 256-Shard RAM Engine)", true},
		{"broker-linux", "beta", "", false},
		{"broker-linux", "alpha", "", false},
		{"version-only", "production", "", false},
		{"", "production", "", false},
		{"unknown", "beta", "", false},
	}
	for _, c := range cases {
		name, ok := missingManifestEntryName(c.ciApp, c.ch)
		if name != c.name || ok != c.ok {
			t.Errorf("missingManifestEntryName(%q, %q) = (%q, %v), want (%q, %v)", c.ciApp, c.ch, name, ok, c.name, c.ok)
		}
	}
}

func testUI() ciUploadedUI {
	return ciUploadedUI{ZipName: "admin-ui.zip", SHA: "sha-new", TreeSHA: "tree-new", Size: 1234}
}

func TestMergeCreatesMissingAdminEntry(t *testing.T) {
	for _, ch := range []string{"production", "beta", "alpha"} {
		m := &rtx5tcp.OTAManifest{Apps: map[string]*rtx5tcp.OTAAppArtifact{
			"manager":      {AppKey: "manager", Version: "1.0.0", UISHA256: "m"},
			"broker-linux": {AppKey: "broker-linux", Version: "1.2.0"},
		}}
		if !mergeCIArtifactIntoManifest(m, ch, "admin", "1.0.10", testUI()) {
			t.Fatalf("%s: expected changed=true", ch)
		}
		a := m.Apps["admin"]
		if a == nil || a.AppKey != "admin" || a.AppName != "RTX5 Broker Admin" || a.Version != "1.0.10" ||
			a.UIZipFile != "admin-ui.zip" || a.UISHA256 != "sha-new" || a.UITreeSHA256 != "tree-new" || a.UISize != 1234 {
			t.Fatalf("%s: admin entry wrong: %+v", ch, a)
		}
		if m.Apps["manager"].Version != "1.0.0" || m.Apps["manager"].UISHA256 != "m" || m.Apps["broker-linux"].Version != "1.2.0" || len(m.Apps) != 3 {
			t.Fatalf("%s: other entries modified: %+v", ch, m.Apps)
		}
	}
}

func TestMergeExistingUnchangedReturnsFalse(t *testing.T) {
	m := &rtx5tcp.OTAManifest{Apps: map[string]*rtx5tcp.OTAAppArtifact{
		"admin": {AppKey: "admin", Version: "1.0.10", UIZipFile: "admin-ui.zip", UISHA256: "sha-new", UITreeSHA256: "tree-new", UISize: 1234},
	}}
	if mergeCIArtifactIntoManifest(m, "production", "admin", "1.0.10", testUI()) {
		t.Fatal("expected changed=false for identical entry")
	}
}

func TestMergeExistingUpdatedReturnsTrue(t *testing.T) {
	m := &rtx5tcp.OTAManifest{Apps: map[string]*rtx5tcp.OTAAppArtifact{
		"admin": {AppKey: "admin", Version: "1.0.9", UISHA256: "old"},
	}}
	if !mergeCIArtifactIntoManifest(m, "beta", "admin", "1.0.10", testUI()) {
		t.Fatal("expected changed=true")
	}
	if m.Apps["admin"].Version != "1.0.10" || m.Apps["admin"].UISHA256 != "sha-new" {
		t.Fatalf("not updated: %+v", m.Apps["admin"])
	}
}

func TestMergeLinuxNotCreatedOnBeta(t *testing.T) {
	m := &rtx5tcp.OTAManifest{Apps: map[string]*rtx5tcp.OTAAppArtifact{
		"admin": {AppKey: "admin", Version: "1.0.0"},
	}}
	if mergeCIArtifactIntoManifest(m, "beta", "superadmin-linux", "2.0.0", testUI()) {
		t.Fatal("expected changed=false")
	}
	if m.Apps["superadmin-linux"] != nil || m.Apps["admin"].Version != "1.0.0" {
		t.Fatalf("unexpected modification: %+v", m.Apps)
	}
	if !mergeCIArtifactIntoManifest(m, "production", "superadmin-linux", "2.0.0", testUI()) || m.Apps["superadmin-linux"] == nil {
		t.Fatal("expected creation on production")
	}
}

func TestMergeVersionOnlyCreatesNothing(t *testing.T) {
	m := &rtx5tcp.OTAManifest{Apps: map[string]*rtx5tcp.OTAAppArtifact{"admin": {AppKey: "admin", Version: "1.0.0"}}}
	if mergeCIArtifactIntoManifest(m, "production", "version-only", "9.9.9", ciUploadedUI{}) || len(m.Apps) != 1 {
		t.Fatal("version-only must not change or create")
	}
}

func TestMergeUpdatesExeFieldsWithoutTouchingOtherApps(t *testing.T) {
	m := &rtx5tcp.OTAManifest{Apps: map[string]*rtx5tcp.OTAAppArtifact{
		"terminal": {
			AppKey:       "terminal",
			Version:      "1.0.10",
			UIZipFile:    "terminal-ui.zip",
			UISHA256:     "ui-sha",
			UITreeSHA256: "ui-tree",
			UISize:       500,
			ExeFile:      "RTX5-Terminal64.exe",
			ExeSHA256:    "exe-old",
			ExeSize:      1000,
		},
		"admin": {
			AppKey:    "admin",
			Version:   "1.0.5",
			ExeFile:   "RTX5-Admin64.exe",
			ExeSHA256: "admin-exe",
			ExeSize:   2000,
		},
	}}
	up := ciUploadedUI{
		ZipName: "terminal-ui.zip",
		SHA:     "ui-sha",
		TreeSHA: "ui-tree",
		Size:    500,
		ExeName: "RTX5-Terminal64.exe",
		ExeSHA:  "exe-new",
		ExeSize: 4096,
	}
	if !mergeCIArtifactIntoManifest(m, "production", "terminal", "1.0.10", up) {
		t.Fatal("expected changed=true when exe fields differ")
	}
	term := m.Apps["terminal"]
	if term.ExeFile != "RTX5-Terminal64.exe" || term.ExeSHA256 != "exe-new" || term.ExeSize != 4096 {
		t.Fatalf("terminal exe fields not updated: %+v", term)
	}
	adm := m.Apps["admin"]
	if adm.Version != "1.0.5" || adm.ExeFile != "RTX5-Admin64.exe" || adm.ExeSHA256 != "admin-exe" || adm.ExeSize != 2000 {
		t.Fatalf("other app modified: %+v", adm)
	}
	if mergeCIArtifactIntoManifest(m, "production", "terminal", "1.0.10", up) {
		t.Fatal("expected changed=false on repeated identical exe merge")
	}
}
