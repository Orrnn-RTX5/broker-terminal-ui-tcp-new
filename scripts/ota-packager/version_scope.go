package main

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
