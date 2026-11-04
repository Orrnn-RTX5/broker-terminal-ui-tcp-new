package rtx5tcp

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestNativeGuardAndMultiplexedBinaryTCP(t *testing.T) {
	dllPath := filepath.Clean(`..\build\rtx5_guard.dll`)
	masterPub, masterPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dllHash, dllSig, err := SignGuardDLLHash(masterPriv, dllPath)
	if err != nil {
		t.Fatalf("SignGuardDLLHash failed: %v", err)
	}

	guard, err := LoadVerifiedNativeGuard(dllPath, masterPub, dllSig)
	if err != nil {
		t.Fatalf("LoadVerifiedNativeGuard failed: %v", err)
	}
	if guard.DLLSHA256() != dllHash {
		t.Fatalf("DLL hash mismatch: %s vs %s", guard.DLLSHA256(), dllHash)
	}

	hwid, summary, err := guard.CollectHardwareFingerprint()
	if err != nil || len(hwid) != 64 {
		t.Fatalf("CollectHardwareFingerprint failed: hwid=%q err=%v", hwid, err)
	}
	t.Logf("Verified Native HWID: %s | Summary: %s", hwid, summary)

	// Verify Windows DPAPI machine seal & anti-copy foreign-entropy rejection
	tmpSeal := filepath.Join(t.TempDir(), "device_key.dpapi.json")
	devPriv1, st1, err := LoadOrCreateDPAPIDeviceKey(guard, tmpSeal, "friendfx-live", hwid)
	if err != nil || st1 != "SEALED_NEW" {
		t.Fatalf("initial DPAPI seal failed: st=%s err=%v", st1, err)
	}
	devPriv2, st2, err := LoadOrCreateDPAPIDeviceKey(guard, tmpSeal, "friendfx-live", hwid)
	if err != nil || st2 != "UNSEALED_OK" || !devPriv1.Equal(devPriv2) {
		t.Fatalf("DPAPI unseal roundtrip failed: st=%s err=%v", st2, err)
	}
	// Simulate Friend #2 copying the folder onto different hardware (different HWID) -> MUST FAIL CLOSED!
	fakeHWID := strings.Repeat("f", 64)
	if _, st3, err3 := LoadOrCreateDPAPIDeviceKey(guard, tmpSeal, "friendfx-live", fakeHWID); err3 == nil || st3 != SecErrDPAPIUnsealFailed {
		t.Fatalf("expected DPAPI clone rejection on foreign HWID, got st=%s err=%v", st3, err3)
	}
	os.Remove(tmpSeal)

	// Start a mock local 127.0.0.1 backend serving both REST and WebSocket (/OnTick)
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "http://127.0.0.1:5173" }}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/OnTick" && websocket.IsWebSocketUpgrade(r) {
			c, uerr := upgrader.Upgrade(w, r, nil)
			if uerr != nil {
				return
			}
			defer c.Close()
			_ = c.WriteMessage(websocket.TextMessage, []byte(`{"symbol":"EURUSD","bid":1.08542,"ask":1.08546}`))
			mt, msg, rerr := c.ReadMessage()
			if rerr == nil {
				_ = c.WriteMessage(mt, append([]byte("ECHO:"), msg...))
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"path":"` + r.URL.Path + `"}`))
	}))
	defer backend.Close()

	// Spin up Encrypted Binary TCP Server listener
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	// Verify byte-1 Magic Number guard rejects raw HTTP / non-RTX5 scanners immediately
	go func() {
		for {
			raw, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			go func(c net.Conn) {
				tc, herr := AcceptTunnel(c, 5*time.Second)
				if herr != nil {
					return
				}
				// Issue 32-byte ChallengeNonce
				ch, _ := NewAuthChallengePacket("hub-test")
				sess := NewMuxSession(tc, true, func(svc, p string) (string, string, error) {
					return backend.URL, "http://127.0.0.1:5173", nil
				}, nil)
				// Verify Auth Challenge-Response before entering mux loop
				chBytes := mustJSON(ch)
				if err := tc.WriteMuxFrame(FrameAuthChallenge, 0, FlagNone, chBytes); err != nil {
					tc.Close()
					return
				}
				ft, _, _, proofBytes, err := tc.ReadMuxFrame()
				if err != nil || ft != FrameAuthProof {
					tc.Close()
					return
				}
				var proof AuthProofPacket
				mustUnmarshal(proofBytes, &proof)
				if err := VerifyChallengeProof(tc.TranscriptHash(), ch.ChallengeNonceHex, &proof); err != nil {
					tc.Close()
					return
				}
				lease := &ExecutionLease{
					Accepted:      true,
					Code:          SecOK,
					Status:        "active",
					LeaseID:       "lease-001",
					BrokerID:      proof.Certificate.BrokerID,
					LockedHWID:    proof.HWIDHex,
					IssuedAtUnix:  time.Now().Unix(),
					ExpiresAtUnix: time.Now().Add(60 * time.Second).Unix(),
				}
				_ = SignExecutionLease(masterPriv, lease)
				_ = tc.WriteMuxFrame(FrameAuthLease, 0, FlagNone, mustJSON(lease))
				_ = sess.ServeLoop()
			}(raw)
		}
	}()

	// 1. Test scanner sending HTTP GET instead of 'R','T','X',0x05 -> must fail!
	badConn, _ := net.Dial("tcp", ln.Addr().String())
	_, _ = badConn.Write([]byte("GET / HTTP/1.1\r\n\r\n"))
	buf := make([]byte, 16)
	_ = badConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, berr := badConn.Read(buf)
	badConn.Close()
	if berr == nil {
		t.Fatal("expected non-RTX5 magic connection to be dropped immediately")
	}

	// 2. Test full Encrypted Binary TCP Client + Nonce Proof + 60s Signed Lease + REST + WebSocket over Binary TCP
	clientTC, err := DialTunnel(ln.Addr().String(), RoleBrokerUplink, 5*time.Second)
	if err != nil {
		t.Fatalf("DialTunnel failed: %v", err)
	}
	ft, _, _, chPayload, err := clientTC.ReadMuxFrame()
	if err != nil || ft != FrameAuthChallenge {
		t.Fatalf("expected FrameAuthChallenge, got ft=%d err=%v", ft, err)
	}
	var chPkt AuthChallengePacket
	mustUnmarshal(chPayload, &chPkt)

	cert := BrokerLicenseCertificate{
		LicenseID:       "lic-1",
		LicenseKey:      "RTX5-PRO-KEY",
		BrokerID:        "friendfx-live",
		BrokerName:      "FriendFX",
		AllowedServerIP: "127.0.0.1",
		IssuedAtUnix:    time.Now().Unix(),
		ExpiresAtUnix:   time.Now().Add(365 * 24 * time.Hour).Unix(),
	}
	_ = SignBrokerLicenseCertificate(masterPriv, &cert)

	proof := AuthProofPacket{
		Certificate:       cert,
		ChallengeNonceHex: chPkt.ChallengeNonceHex,
		BrokerUnixTime:    time.Now().Unix(),
		HWIDHex:           hwid,
		HardwareSummary:   summary,
		ExeSHA256Hex:      guard.ExeSHA256(),
		GuardDLLSHA256Hex: guard.DLLSHA256(),
		DPAPISealStatus:   "SEALED_NEW",
	}
	SignChallengeProof(devPriv1, clientTC.TranscriptHash(), &proof)
	if err := clientTC.WriteMuxFrame(FrameAuthProof, 0, FlagNone, mustJSON(proof)); err != nil {
		t.Fatal(err)
	}
	ft, _, _, leasePayload, err := clientTC.ReadMuxFrame()
	if err != nil || ft != FrameAuthLease {
		t.Fatalf("expected FrameAuthLease, got ft=%d err=%v", ft, err)
	}
	var lease ExecutionLease
	mustUnmarshal(leasePayload, &lease)
	if err := VerifyExecutionLease(masterPub, &lease, "friendfx-live", hwid); err != nil {
		t.Fatalf("VerifyExecutionLease failed: %v", err)
	}

	clientSess := NewMuxSession(clientTC, false, nil, nil)
	go clientSess.ServeLoop()
	defer clientSess.Close()

	// Local loopback edge server using clientSess.ProxyHTTP
	edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clientSess.ProxyHTTP(w, r, "manager")
	}))
	defer edge.Close()

	// Test REST over Binary TCP
	resp, err := http.Get(edge.URL + "/api/v2/symbols")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), `"/api/v2/symbols"`) {
		t.Fatalf("unexpected REST body over binary TCP: %s", string(body))
	}

	// Test WebSocket (/OnTick) over Binary TCP (zero WS on outer TCP wire!)
	wsURL := "ws" + strings.TrimPrefix(edge.URL, "http") + "/OnTick"
	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("WS over Binary TCP dial failed: %v", err)
	}
	defer wsConn.Close()

	_, tickMsg, err := wsConn.ReadMessage()
	if err != nil || !strings.Contains(string(tickMsg), "EURUSD") {
		t.Fatalf("unexpected tick message over Binary TCP: %q err=%v", string(tickMsg), err)
	}
	_ = wsConn.WriteMessage(websocket.TextMessage, []byte("SUB_XAUUSD"))
	_, echoMsg, err := wsConn.ReadMessage()
	if err != nil || string(echoMsg) != "ECHO:SUB_XAUUSD" {
		t.Fatalf("unexpected WS echo over Binary TCP: %q err=%v", string(echoMsg), err)
	}
	t.Logf("6-Layer Security + Native rtx5_guard.dll (SHA256=%s) + Multiplexed REST & WebSocket over Encrypted Binary TCP PASSED!", dllHash[:16])
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func mustUnmarshal(b []byte, v any) {
	if err := json.Unmarshal(b, v); err != nil {
		panic(err)
	}
}

func TestBinaryTickAndCandleEncoding(t *testing.T) {
	inTicks := []BinaryTick{
		{Symbol: "BTCUSD", TimestampMs: 1793359841127, Bid: 77597.49, Ask: 77602.49, Sequence: 5355227},
		{Symbol: "XAUUSD", TimestampMs: 1793359841135, Bid: 3989.77, Ask: 3989.84, Sequence: 5355228},
	}
	encodedTicks := EncodeBinaryTickBatch(inTicks)
	if len(encodedTicks) != 2+2*BinaryTickRecordSize {
		t.Fatalf("unexpected encoded tick batch len %d", len(encodedTicks))
	}
	outTicks, err := DecodeBinaryTickBatch(encodedTicks)
	if err != nil || len(outTicks) != 2 {
		t.Fatalf("DecodeBinaryTickBatch failed: %v", err)
	}
	if outTicks[0].Symbol != "BTCUSD" || outTicks[0].Bid != 77597.49 || outTicks[1].Symbol != "XAUUSD" || outTicks[1].Sequence != 5355228 {
		t.Fatalf("decoded tick mismatch: %+v", outTicks)
	}

	inCandles := []BinaryCandle{
		{Symbol: "BTCUSD", OpenTimeSec: 1793359800, Open: 77590.00, High: 77610.50, Low: 77588.10, Close: 77605.25, TickVolume: 42, Closed: false, TimeframeCode: TFCodeM1},
		{Symbol: "BTCUSD", OpenTimeSec: 1793359740, Open: 77580.00, High: 77595.00, Low: 77575.00, Close: 77590.00, TickVolume: 68, Closed: true, TimeframeCode: TFCodeM1},
	}
	encodedCandles := EncodeBinaryCandleBatch(inCandles)
	if len(encodedCandles) != 2+2*BinaryCandleRecordSize {
		t.Fatalf("unexpected encoded candle batch len %d", len(encodedCandles))
	}
	outCandles, err := DecodeBinaryCandleBatch(encodedCandles)
	if err != nil || len(outCandles) != 2 {
		t.Fatalf("DecodeBinaryCandleBatch failed: %v", err)
	}
	if outCandles[0].Closed != false || outCandles[1].Closed != true || outCandles[0].Close != 77605.25 || outCandles[1].TickVolume != 68 {
		t.Fatalf("decoded candle mismatch: %+v", outCandles)
	}
}
