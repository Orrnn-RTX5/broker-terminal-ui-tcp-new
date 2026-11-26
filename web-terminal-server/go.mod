module rtx5-web-terminal-tcp

go 1.25.0

require (
	github.com/gorilla/websocket v1.5.3
	rtx5-tcp-protocol v0.0.0
)

require golang.org/x/crypto v0.52.0 // indirect

replace rtx5-tcp-protocol => ../pkg/rtx5-tcp-protocol
