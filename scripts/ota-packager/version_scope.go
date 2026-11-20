package main

import rtx5tcp "rtx5-tcp-protocol"

// Each repository versions its own parts (RELEASE_RULES.md rule 5): everything
// started at v1.0.0, and after that a deploy changes only the version of the
// release-list entries it builds. A Super Admin push must not relabel the broker
// or the UIs, whose files did not change.
//
//	repo                      CI target          release-list entries
//	superadmin-backend        superadmin-linux   superadmin-linux
//	superadmin-UI             superadmin         superadmin
//	Broker-Backend-V2         broker-linux       broker-linux, broker-windows
//	Broker-Admin-UI           admin              admin
//	Broker-Manager-UI         manager            manager
//	Broker-Terminal-UI        terminal           terminal
func ciAppOwnsManifestKey(ciApp, key string) bool {
	if ciApp == "broker-linux" {
		return key == "broker-linux" || key == "broker-windows"
	}
	return key == ciApp
}

// missingManifestEntryName returns the release-list entry name to create when a
// channel manifest does not yet hold the CI app's own key. The linux backends are
// only created on the production channel (they are never shipped on alpha/beta);
// the web UI apps are created on every channel. Anything else (e.g. "version-only")
// never creates an entry.
func missingManifestEntryName(ciApp, channel string) (appName string, ok bool) {
	switch ciApp {
	case "superadmin-linux":
		if channel == "production" {
			return "RTX5 Super Admin Linux VPS Backend (:9100 Hub + :8102 Control Plane)", true
		}
	case "broker-linux":
		if channel == "production" {
			return "RTX5 Broker Linux VPS Backend (:4443 + 256-Shard RAM Engine)", true
		}
	case "superadmin":
		return "RTX5 Super Admin Control Plane", true
	case "admin":
		return "RTX5 Broker Admin", true
	case "manager":
		return "RTX5 Dealing Desk Manager", true
	case "terminal":
		return "RTX5 Trader Terminal 64-Bit", true
	}
	return "", false
}

// ciUploadedUI describes the UI bundle and optional Windows .exe the CI run just uploaded (empty SHA = none).
type ciUploadedUI struct {
	ZipName string
	SHA     string
	TreeSHA string
	Size    int64
	ExeName string
	ExeSHA  string
	ExeSize int64
}

// mergeCIArtifactIntoManifest applies one CI run to one channel manifest: creates
// the CI app's own entry if missing, bumps the version of the entries it owns, and
// fills the UI bundle / Windows .exe fields. It reports whether anything changed. It never creates
// or touches entries owned by other repositories.
func mergeCIArtifactIntoManifest(m *rtx5tcp.OTAManifest, ch, ciApp, ver string, up ciUploadedUI) bool {
	changed := false
	if (up.SHA != "" || up.ExeSHA != "") && m.Apps[ciApp] == nil {
		if name, ok := missingManifestEntryName(ciApp, ch); ok {
			m.Apps[ciApp] = &rtx5tcp.OTAAppArtifact{AppKey: ciApp, AppName: name, Version: ver}
			changed = true
		}
	}
	linux := ciApp == "superadmin-linux" || ciApp == "broker-linux"
	for k, a := range m.Apps {
		if a == nil {
			continue
		}
		if ciAppOwnsManifestKey(ciApp, k) && a.Version != ver {
			a.Version = ver
			changed = true
		}
		if k == ciApp && up.SHA != "" && (ch == "production" || !linux) {
			if a.UITreeSHA256 != up.TreeSHA || a.UISHA256 != up.SHA {
				changed = true
			}
			a.UIZipFile = up.ZipName
			a.UISHA256 = up.SHA
			a.UISize = up.Size
			a.UITreeSHA256 = up.TreeSHA
		}
		if k == ciApp && up.ExeSHA != "" && up.ExeName != "" && !linux {
			if a.ExeFile != up.ExeName || a.ExeSHA256 != up.ExeSHA || a.ExeSize != up.ExeSize {
				changed = true
			}
			a.ExeFile = up.ExeName
			a.ExeSHA256 = up.ExeSHA
			a.ExeSize = up.ExeSize
		}
	}
	return changed
}
