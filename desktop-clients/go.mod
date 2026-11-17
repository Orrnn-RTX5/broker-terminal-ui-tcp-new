module rtx5-desktop-clients

go 1.25.0

require (
	github.com/gorilla/websocket v1.5.3
	github.com/jchv/go-webview2 v0.0.0-20260205173254-56598839c808
	golang.org/x/sys v0.31.0
	rtx5-tcp-protocol v0.0.0
)

require (
	github.com/jchv/go-winloader v0.0.0-20250406163304-c1995be93bd1 // indirect
	golang.org/x/crypto v0.36.0 // indirect
)

replace rtx5-tcp-protocol => ../pkg/rtx5-tcp-protocol
