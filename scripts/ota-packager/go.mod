module rtx5-ota-packager

go 1.24.0

require rtx5-tcp-protocol v0.0.0

require (
	github.com/gorilla/websocket v1.5.3 // indirect
	golang.org/x/crypto v0.36.0 // indirect
)

replace rtx5-tcp-protocol => ../../pkg/rtx5-tcp-protocol