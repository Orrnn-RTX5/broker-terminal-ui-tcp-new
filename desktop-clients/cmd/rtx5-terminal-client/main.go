package main

import (
	"embed"

	"rtx5-desktop-clients/clientcore"
	rtx5tcp "rtx5-tcp-protocol"
)

//go:embed all:dist
var embeddedDist embed.FS

func main() {
	clientcore.Run(clientcore.AppConfig{
		Kind:                 clientcore.KindTerminal,
		WindowTitle:          "RTX5 Trader Terminal 64-Bit",
		PeerRole:             rtx5tcp.RoleTraderTerminalClient,
		DefaultTargetTCP:     "51.195.188.172:4443",
		DefaultSuperAdminTCP: "51.195.188.172:9100",
		DefaultLocalAddr:     "127.0.0.1:18403",
		DefaultBrokerID:      "animeshfx",
		DefaultBrokerName:    "AnimeshFX-Live",
		EmbeddedDist:         embeddedDist,
	})
}
