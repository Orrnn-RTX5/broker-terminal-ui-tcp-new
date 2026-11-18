package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

// Targets that refuse at once, so no test dials a real access server on this machine.
const (
	testLocalTarget  = "127.0.0.1:1" // the broker on this host (loopback)
	testRemoteTarget = "127.0.0.2:1" // another broker (not the 127.0.0.1 loopback prefix)
)

func newPerSessionTestServer(t *testing.T) *WebTerminalServer {
	t.Helper()
	srv := &WebTerminalServer{
		localBrokerID: "yo4x",
		localTarget:   testLocalTarget,
		sessionTokens: make(map[string]string),
	}
	if srv.setDefaultBroker("yo4x", "yo4x", testLocalTarget) == nil {
		t.Fatal("default broker link was not created")
	}
	return srv
}

func doJSON(t *testing.T, srv *WebTerminalServer, method, path, sid, body string) (int, map[string]any) {
	t.Helper()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	if sid != "" {
		req.AddCookie(&http.Cookie{Name: "rtx5_wt_sid", Value: sid})
	}
	rec := httptest.NewRecorder()
	srv.serveHTTP(rec, req)
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func statusBroker(t *testing.T, srv *WebTerminalServer, sid string) (string, string) {
	t.Helper()
	code, st := doJSON(t, srv, http.MethodGet, "/api/tcp-client/status", sid, "")
	if code != http.StatusOK {
		t.Fatalf("status for session %q: HTTP %d", sid, code)
	}
	id, _ := st["broker_id"].(string)
	target, _ := st["target_tcp"].(string)
	return id, target
}

// The incident of 2026-11-14: a Tradex login on the yo4x web server moved every page,
// including the yo4x Admin, to Tradex. A switch must move only the session that asked.
func TestSwitchBrokerMovesOnlyTheCallingSession(t *testing.T) {
	srv := newPerSessionTestServer(t)

	code, resp := doJSON(t, srv, http.MethodPost, "/api/tcp-client/switch-broker", "session-terminal",
		`{"broker_id":"tradex","broker_name":"Tradex","tcp_addr":"`+testRemoteTarget+`"}`)
	if code != http.StatusOK || resp["broker_id"] != "tradex" || resp["target_tcp"] != testRemoteTarget {
		t.Fatalf("switch answer = HTTP %d %v, want tradex at %s", code, resp, testRemoteTarget)
	}

	if id, target := statusBroker(t, srv, "session-terminal"); id != "tradex" || target != testRemoteTarget {
		t.Fatalf("switched session sees %s at %s, want tradex at %s", id, target, testRemoteTarget)
	}
	if id, target := statusBroker(t, srv, "session-admin"); id != "yo4x" || target != testLocalTarget {
		t.Fatalf("other session sees %s at %s, want yo4x at %s (it must not follow the switch)", id, target, testLocalTarget)
	}
	if id, _ := statusBroker(t, srv, ""); id != "yo4x" {
		t.Fatalf("a new page sees %s, want the server's own broker yo4x", id)
	}

	// The runtime config each page loads names its own broker too.
	for sid, want := range map[string]string{"session-terminal": `"BROKER_ID":"tradex"`, "session-admin": `"BROKER_ID":"yo4x"`} {
		req := httptest.NewRequest(http.MethodGet, "/runtime-config.js", nil)
		req.AddCookie(&http.Cookie{Name: "rtx5_wt_sid", Value: sid})
		rec := httptest.NewRecorder()
		srv.serveHTTP(rec, req)
		if !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("runtime config for %s lacks %s: %s", sid, want, rec.Body.String())
		}
	}
}

func TestSwitchBackToTheLocalBrokerUsesTheLoopbackTarget(t *testing.T) {
	srv := newPerSessionTestServer(t)
	doJSON(t, srv, http.MethodPost, "/api/tcp-client/switch-broker", "s1",
		`{"broker_id":"tradex","tcp_addr":"`+testRemoteTarget+`"}`)
	// The directory lists this host's broker by its public address; the session must still use loopback.
	code, resp := doJSON(t, srv, http.MethodPost, "/api/tcp-client/switch-broker", "s1",
		`{"broker_id":"YO4X","tcp_addr":"185.126.217.108:4443"}`)
	if code != http.StatusOK || resp["target_tcp"] != testLocalTarget {
		t.Fatalf("switch back = HTTP %d %v, want target %s", code, resp, testLocalTarget)
	}
	if l := srv.linkForSession("s1"); l == nil || !l.local || l != srv.defaultLink() {
		t.Fatalf("session s1 link = %+v, want the local default link", l)
	}
}

func TestSwitchToUnknownBrokerFailsAndKeepsTheSession(t *testing.T) {
	srv := newPerSessionTestServer(t)
	code, resp := doJSON(t, srv, http.MethodPost, "/api/tcp-client/switch-broker", "s1", `{"broker_id":"nobody"}`)
	if code != http.StatusBadRequest || resp["ok"] != false {
		t.Fatalf("unknown broker switch = HTTP %d %v, want 400 ok=false", code, resp)
	}
	if id, _ := statusBroker(t, srv, "s1"); id != "yo4x" {
		t.Fatalf("session after failed switch sees %s, want yo4x", id)
	}
}

func TestEachBrokerHasItsOwnMarketHub(t *testing.T) {
	srv := newPerSessionTestServer(t)
	doJSON(t, srv, http.MethodPost, "/api/tcp-client/switch-broker", "tradex-page",
		`{"broker_id":"tradex","tcp_addr":"`+testRemoteTarget+`"}`)
	tradexLink, yo4xLink := srv.linkForSession("tradex-page"), srv.linkForSession("yo4x-page")
	if tradexLink == nil || yo4xLink == nil || tradexLink == yo4xLink || tradexLink.binHub == yo4xLink.binHub {
		t.Fatalf("pages share a link or hub: tradex=%p yo4x=%p", tradexLink, yo4xLink)
	}

	depth := rtx5tcp.EncodeBinaryDepthBatch([]rtx5tcp.BinaryDepth{{
		Symbol:      "BTCUSD",
		TimestampMs: time.Now().UnixMilli(),
		Bids:        []rtx5tcp.BinaryDepthLevel{{Price: 100000, Volume: 1}},
		Asks:        []rtx5tcp.BinaryDepthLevel{{Price: 100001, Volume: 1}},
	}})
	tradexLink.binHub.handleControlFrame(rtx5tcp.FrameBinaryDepthBatch, depth)

	for sid, want := range map[string]bool{"tradex-page": true, "yo4x-page": false} {
		req := httptest.NewRequest(http.MethodGet, "/api/v2/depth/BTCUSD", nil)
		req.AddCookie(&http.Cookie{Name: "rtx5_wt_sid", Value: sid})
		if got := srv.tryServeCachedDepthSnapshot(httptest.NewRecorder(), req); got != want {
			t.Fatalf("%s sees Tradex depth = %v, want %v", sid, got, want)
		}
	}
}

func TestOrdersOfARemoteBrokerNeverUseTheLocalGatewayPool(t *testing.T) {
	prevGW := rtx5tcp.GetDefaultBinaryOrderGatewayAddr()
	t.Cleanup(func() { rtx5tcp.SetDefaultBinaryOrderGatewayAddr(prevGW) })
	gwAddr, lastPayload, _, closeGW := startCapturingRTOGateway(t)
	defer closeGW()
	rtx5tcp.SetDefaultBinaryOrderGatewayAddr(gwAddr)

	srv := newPerSessionTestServer(t)
	remote := srv.switchSessionBroker("tradex-page", "tradex", "Tradex", testRemoteTarget)
	if remote == nil || remote.local {
		t.Fatalf("remote link = %+v, want a non-local link", remote)
	}
	payload := rtx5tcp.EncodeBinaryOrderFastReq(rtx5tcp.BinaryOrderFastReq{
		Action:        rtx5tcp.BinaryOrderActionPlaceMarket,
		Side:          rtx5tcp.BinaryOrderSideBuy,
		AccountLogin:  9001,
		Volume:        0.01,
		Symbol:        rtx5tcp.PackBinarySymbol("BTCUSD"),
		ClientOrderID: rtx5tcp.PackBinaryClientOrderID("cid-remote-1"),
		AuthToken:     "tradex-token",
	})
	if _, err := srv.executeBinaryOrderPayload(remote, payload, time.Second); err == nil {
		t.Fatal("order for an unreachable remote broker succeeded")
	}
	if got := lastPayload(); len(got) != 0 {
		t.Fatalf("a Tradex order reached this host's gateway pool: %x", got)
	}
	if _, err := srv.executeBinaryOrderPayload(nil, payload, time.Second); err != errNoBrokerTarget {
		t.Fatalf("order without a broker: err = %v, want errNoBrokerTarget", err)
	}
}

func TestPruneIdleKeepsDefaultAndSessionChoices(t *testing.T) {
	srv := newPerSessionTestServer(t)
	chosen := srv.switchSessionBroker("s1", "tradex", "Tradex", testRemoteTarget)
	unused := srv.ensureLink("other", "Other", "127.0.0.3:1")
	if chosen == nil || unused == nil {
		t.Fatal("links were not created")
	}
	later := time.Now().Add(linkIdleTimeout + time.Minute)
	srv.pruneIdle(later)

	srv.linksMu.RLock()
	_, hasChosen := srv.links["tradex"]
	_, hasUnused := srv.links["other"]
	_, hasDefault := srv.links[srv.defaultLinkKey]
	srv.linksMu.RUnlock()
	if !hasDefault || !hasChosen || hasUnused {
		t.Fatalf("after prune: default=%v chosen=%v unused=%v, want true true false", hasDefault, hasChosen, hasUnused)
	}
	if l := srv.linkForSession("s1"); l != chosen {
		t.Fatalf("session s1 lost its broker after prune: %+v", l)
	}

	srv.pruneIdle(time.Now().Add(sessionBindingTTL + time.Hour))
	if l := srv.linkForSession("s1"); l != srv.defaultLink() {
		t.Fatalf("expired session choice still used: %+v", l)
	}
}

func TestSessionKeyIsStableWithinOneRequest(t *testing.T) {
	srv := newPerSessionTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/tcp-client/switch-broker",
		strings.NewReader(`{"broker_id":"tradex","tcp_addr":"`+testRemoteTarget+`"}`))
	rec := httptest.NewRecorder()
	srv.serveHTTP(rec, req) // no cookie: the server issues one
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "rtx5_wt_sid" {
		t.Fatalf("want exactly one session cookie, got %v", cookies)
	}
	if id, _ := statusBroker(t, srv, cookies[0].Value); id != "tradex" {
		t.Fatalf("the issued cookie's session sees %s, want tradex", id)
	}
}

func TestCookielessXBrokerIDRoutingAndCanonicalID(t *testing.T) {
	srv := &WebTerminalServer{
		sessionTokens: make(map[string]string),
		cachedBrokers: []DiscoveredBroker{
			{BrokerID: "9010", BrokerName: "Delta", TCPAddr: "194.110.169.111:4443", Online: true},
			{BrokerID: "orrnn", BrokerName: "Orrnn", TCPAddr: "51.195.188.172:4443", Online: true},
		},
	}
	def := srv.setDefaultBroker("legacy-alias", "Legacy", "51.195.188.172:4443")
	if got := srv.canonicalBrokerIDForLink(def); got != "orrnn" {
		t.Fatalf("canonicalBrokerIDForLink(def) = %q, want %q", got, "orrnn")
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v2/instruments", nil)
	req.Header.Set("X-Broker-ID", "9010")
	chosen := srv.linkForRequest(req)
	if chosen == nil || chosen == def || chosen.id != "9010" || chosen.target != "194.110.169.111:4443" {
		t.Fatalf("cookieless request with X-Broker-ID: 9010 resolved to %+v, want 9010 at 194.110.169.111:4443", chosen)
	}
}
