package clientcore

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func TestOnDemandBrokerDirectoryRefreshAndSwitchBroker(t *testing.T) {
	var dirMu sync.Mutex
	serverBrokers := []DiscoveredBroker{
		{
			BrokerID:   "fxtrust-tcp",
			BrokerName: "FXTrust-TCP-Live",
			TCPAddr:    "192.168.1.59:4443",
			Plan:       "Enterprise-TCP",
			Online:     true,
		},
	}

	hubLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen mock hub: %v", err)
	}
	defer hubLn.Close()

	go func() {
		for {
			raw, aerr := hubLn.Accept()
			if aerr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				tc, terr := rtx5tcp.AcceptTunnel(c, 2*time.Second)
				if terr != nil {
					return
				}
				defer tc.Close()
				ft, sid, _, _, rerr := tc.ReadMuxFrame()
				if rerr != nil || ft != rtx5tcp.FrameBrokerDirectoryReq {
					return
				}
				dirMu.Lock()
				snap := make([]DiscoveredBroker, len(serverBrokers))
				copy(snap, serverBrokers)
				dirMu.Unlock()
				b, _ := json.Marshal(snap)
				_ = tc.WriteMuxFrame(rtx5tcp.FrameBrokerDirectoryResp, sid, rtx5tcp.FlagFIN, b)
			}(raw)
		}
	}()

	dc := &DesktopClient{
		cfg: AppConfig{
			Kind:        KindTerminal,
			WindowTitle: "RTX5 Terminal Test",
			PeerRole:    rtx5tcp.RoleTraderTerminalClient,
		},
		localOrigin:      "http://127.0.0.1:18430",
		localHost:        "127.0.0.1",
		localPort:        18430,
		fastOrderOrigin:  "http://127.0.0.1:18440",
		fastOrderPort:    18440,
		superAdminTCP:    hubLn.Addr().String(),
		targetTCPAddr:    "192.168.1.59:4443",
		activeBrokerID:   "fxtrust-tcp",
		activeBrokerName: "FXTrust-TCP-Live",
		cachedBrokers:    append([]DiscoveredBroker(nil), serverBrokers...),
		cachedBrokersAt:  time.Now().Add(-2500 * time.Millisecond),
		binHub:           newClientBinaryMarketHub(),
	}

	// Register a second broker on the mock SuperAdmin hub
	dirMu.Lock()
	serverBrokers = append(serverBrokers, DiscoveredBroker{
		BrokerID:   "friendfx",
		BrokerName: "FriendFX",
		TCPAddr:    "192.168.1.48:4443",
		Plan:       "Professional-TCP",
		Online:     true,
	})
	dirMu.Unlock()

	// 1. Request GET /api/v2/broker/servers when len(cachedBrokers) == 1 and age > 2s -> should refresh within 400ms
	req1 := httptest.NewRequest(http.MethodGet, "/api/v2/broker/servers", nil)
	rec1 := httptest.NewRecorder()
	dc.serveHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("expected 200 from /api/v2/broker/servers, got %d", rec1.Code)
	}
	var serversResp []map[string]any
	if err := json.Unmarshal(rec1.Body.Bytes(), &serversResp); err != nil {
		t.Fatalf("unmarshal /api/v2/broker/servers: %v", err)
	}
	if len(serversResp) != 2 {
		t.Fatalf("expected 2 brokers after fast refresh, got %d: %+v", len(serversResp), serversResp)
	}

	// 2. Call POST /api/tcp-client/switch-broker with only broker_id -> should resolve broker_name & tcp_addr from cache
	switchBody, _ := json.Marshal(map[string]string{
		"broker_id": "friendfx",
	})
	req2 := httptest.NewRequest(http.MethodPost, "/api/tcp-client/switch-broker", bytes.NewReader(switchBody))
	rec2 := httptest.NewRecorder()
	dc.serveHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200 from /api/tcp-client/switch-broker, got %d", rec2.Code)
	}

	// 3. Verify /api/tcp-client/status immediately reflects the switched broker
	req3 := httptest.NewRequest(http.MethodGet, "/api/tcp-client/status", nil)
	rec3 := httptest.NewRecorder()
	dc.serveHTTP(rec3, req3)
	var statusResp map[string]any
	if err := json.Unmarshal(rec3.Body.Bytes(), &statusResp); err != nil {
		t.Fatalf("unmarshal /api/tcp-client/status: %v", err)
	}
	if statusResp["broker_id"] != "friendfx" || statusResp["broker_name"] != "FriendFX" || statusResp["target_tcp"] != "192.168.1.48:4443" {
		t.Fatalf("unexpected /api/tcp-client/status after switch: %+v", statusResp)
	}

	// 4. Verify /runtime-config.js immediately reflects the switched broker
	req4 := httptest.NewRequest(http.MethodGet, "/runtime-config.js", nil)
	rec4 := httptest.NewRecorder()
	dc.serveHTTP(rec4, req4)
	jsBody := rec4.Body.String()
	if !strings.Contains(jsBody, `"BROKER_ID":"friendfx"`) ||
		!strings.Contains(jsBody, `"BROKER_NAME":"FriendFX"`) ||
		!strings.Contains(jsBody, `"TCP_SERVER_ADDR":"192.168.1.48:4443"`) {
		t.Fatalf("unexpected /runtime-config.js after switch: %s", jsBody)
	}
}
