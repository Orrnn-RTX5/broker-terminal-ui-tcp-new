package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func makeTestDrawingJWT(brokerID string, accountLogin int64, expOffset time.Duration) string {
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claims := map[string]any{
		"broker_id":     brokerID,
		"account_login": accountLogin,
		"username":      fmt.Sprintf("%d", accountLogin),
		"exp":           time.Now().Add(expOffset).Unix(),
	}
	payloadBytes, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	return hdr + "." + payload + ".test-sig"
}

func newTestDrawingServer(t *testing.T, brokerID string) (*WebTerminalServer, string) {
	t.Helper()
	storageDir := t.TempDir()
	srv := &WebTerminalServer{
		defaultPort:   18403,
		sessionTokens: make(map[string]string),
	}
	srv.setDefaultBroker(brokerID, strings.ToUpper(brokerID), "127.0.0.1:4443")
	hub := newDrawingSyncHub(storageDir)
	hub.verifyTokenFn = func(context.Context, *brokerLink, string, drawingTokenClaims) error {
		return nil
	}
	srv.drawingHubOnce.Do(func() {
		srv.drawingHub = hub
	})
	return srv, storageDir
}

func TestDrawingSyncRESTPersistenceAndIsolation(t *testing.T) {
	srv, storageDir := newTestDrawingServer(t, "orrnn")
	ts := httptest.NewServer(http.HandlerFunc(srv.serveHTTP))
	defer ts.Close()

	tok200010 := makeTestDrawingJWT("orrnn", 200010, time.Hour)
	tok200011 := makeTestDrawingJWT("orrnn", 200011, time.Hour)
	tokOtherBroker := makeTestDrawingJWT("other-broker", 200010, time.Hour)
	tokExpired := makeTestDrawingJWT("orrnn", 200010, -time.Minute)

	// Missing / expired / cross-broker tokens are rejected
	reqNoAuth, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/fix/drawings?symbol=EURUSD", nil)
	resp, err := http.DefaultClient.Do(reqNoAuth)
	if err != nil {
		t.Fatalf("GET no auth: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", resp.StatusCode)
	}

	reqExpired, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/fix/drawings?symbol=EURUSD", nil)
	reqExpired.Header.Set("Authorization", "Bearer "+tokExpired)
	resp, _ = http.DefaultClient.Do(reqExpired)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for expired token, got %d", resp.StatusCode)
	}

	reqOtherBroker, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/fix/drawings?symbol=EURUSD", nil)
	reqOtherBroker.Header.Set("Authorization", "Bearer "+tokOtherBroker)
	resp, _ = http.DefaultClient.Do(reqOtherBroker)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for mismatched broker token, got %d", resp.StatusCode)
	}

	// Save a drawing on account 200010
	body := `{"type":"hline","symbol":"EURUSD","timeframe":"M1","properties":{"id":"d-line-1","points":[{"time":1700000000,"price":1.095}],"color":"#3b82f6"}}`
	reqSave, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/fix/drawings", bytes.NewBufferString(body))
	reqSave.Header.Set("Authorization", "Bearer "+tok200010)
	reqSave.Header.Set("Content-Type", "application/json")
	resp, err = http.DefaultClient.Do(reqSave)
	if err != nil {
		t.Fatalf("POST save: %v", err)
	}
	var saveOut struct {
		Success   bool   `json:"success"`
		DrawingID string `json:"drawingId"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&saveOut)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !saveOut.Success || saveOut.DrawingID != "d-line-1" {
		t.Fatalf("unexpected save response: status=%d body=%+v", resp.StatusCode, saveOut)
	}

	// Account 200011 on the same broker must NOT see 200010's drawings
	reqOtherAcc, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/fix/drawings?symbol=EURUSD&timeframe=M1", nil)
	reqOtherAcc.Header.Set("Authorization", "Bearer "+tok200011)
	resp, _ = http.DefaultClient.Do(reqOtherAcc)
	var otherOut struct {
		Drawings []SyncedDrawing `json:"drawings"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&otherOut)
	resp.Body.Close()
	if len(otherOut.Drawings) != 0 {
		t.Fatalf("account 200011 leaked %d drawings from 200010", len(otherOut.Drawings))
	}

	// Hide drawings on 200010 EURUSD M1
	reqHide, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/fix/drawings/visibility", bytes.NewBufferString(`{"symbol":"EURUSD","timeframe":"M1","drawingsHidden":true}`))
	reqHide.Header.Set("Authorization", "Bearer "+tok200010)
	reqHide.Header.Set("Content-Type", "application/json")
	resp, _ = http.DefaultClient.Do(reqHide)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on visibility PUT, got %d", resp.StatusCode)
	}

	// Wait briefly for async disk persistence and reload from a fresh hub pointing at storageDir
	deadline := time.Now().Add(2 * time.Second)
	for {
		reloadedHub := newDrawingSyncHub(storageDir)
		_, list, hidden, _ := reloadedHub.snapshotFor("orrnn", 200010, "EURUSD", "M1")
		if len(list) == 1 && hidden {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reloaded hub missed persisted drawing/visibility: count=%d hidden=%v", len(list), hidden)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestDrawingSyncFanoutTo100ConcurrentUsersAndVisibilityToggle(t *testing.T) {
	srv, _ := newTestDrawingServer(t, "orrnn")
	ts := httptest.NewServer(http.HandlerFunc(srv.serveHTTP))
	defer ts.Close()

	tok200010 := makeTestDrawingJWT("orrnn", 200010, time.Hour)
	tok200011 := makeTestDrawingJWT("orrnn", 200011, time.Hour)
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http") + "/__rtx5_drawing_ws"

	const subscriberCount = 100
	conns := make([]*websocket.Conn, 0, subscriberCount)
	for i := 0; i < subscriberCount; i++ {
		wsURL := fmt.Sprintf("%s?token=%s&clientId=user-%d", wsBase, tok200010, i)
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatalf("dial subscriber %d: %v", i, err)
		}
		// Consume initial snapshot frame
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, raw, rerr := conn.ReadMessage()
		if rerr != nil {
			t.Fatalf("initial snapshot %d: %v", i, rerr)
		}
		var snap struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &snap) != nil || snap.Type != "drawing_snapshot" {
			t.Fatalf("expected drawing_snapshot for subscriber %d, got %s", i, string(raw))
		}
		conns = append(conns, conn)
	}
	defer func() {
		for _, conn := range conns {
			_ = conn.Close()
		}
	}()

	// Connect an unrelated account 200011 to verify it never receives 200010 events
	otherConn, _, err := websocket.DefaultDialer.Dial(wsBase+"?token="+tok200011+"&clientId=other", nil)
	if err != nil {
		t.Fatalf("dial other account: %v", err)
	}
	defer otherConn.Close()
	_ = otherConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, _ = otherConn.ReadMessage() // initial snapshot

	// Publish one drawing upsert and one visibility hide from client user-0
	saveReq, _ := http.NewRequest(
		http.MethodPost,
		ts.URL+"/api/fix/drawings",
		bytes.NewBufferString(`{"type":"trendline","symbol":"EURUSD","timeframe":"M1","properties":{"id":"shared-tl-1","points":[{"time":1700000100,"price":1.09},{"time":1700000200,"price":1.10}]}}`),
	)
	saveReq.Header.Set("Authorization", "Bearer "+tok200010)
	saveReq.Header.Set("Content-Type", "application/json")
	saveReq.Header.Set("X-Client-ID", "user-0")
	resp, err := http.DefaultClient.Do(saveReq)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("save drawing failed: err=%v resp=%v", err, resp)
	}
	resp.Body.Close()

	hideReq, _ := http.NewRequest(
		http.MethodPut,
		ts.URL+"/api/fix/drawings/visibility",
		bytes.NewBufferString(`{"symbol":"EURUSD","timeframe":"M1","drawingsHidden":true}`),
	)
	hideReq.Header.Set("Authorization", "Bearer "+tok200010)
	hideReq.Header.Set("Content-Type", "application/json")
	hideReq.Header.Set("X-Client-ID", "user-0")
	resp, err = http.DefaultClient.Do(hideReq)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("hide drawings failed: err=%v resp=%v", err, resp)
	}
	resp.Body.Close()

	// All 100 subscribers must receive both drawing_upsert and drawing_visibility
	var wg sync.WaitGroup
	errCh := make(chan error, subscriberCount)
	for i, conn := range conns {
		wg.Add(1)
		go func(idx int, c *websocket.Conn) {
			defer wg.Done()
			gotUpsert := false
			gotHide := false
			for attempt := 0; attempt < 2; attempt++ {
				_ = c.SetReadDeadline(time.Now().Add(4 * time.Second))
				_, raw, rerr := c.ReadMessage()
				if rerr != nil {
					errCh <- fmt.Errorf("subscriber %d read %d failed: %w", idx, attempt, rerr)
					return
				}
				var msg struct {
					Type           string         `json:"type"`
					DrawingsHidden bool           `json:"drawingsHidden"`
					Drawing        *SyncedDrawing `json:"drawing"`
				}
				if json.Unmarshal(raw, &msg) != nil {
					errCh <- fmt.Errorf("subscriber %d invalid json: %s", idx, string(raw))
					return
				}
				if msg.Type == "drawing_upsert" && msg.Drawing != nil && msg.Drawing.ID == "shared-tl-1" {
					gotUpsert = true
				}
				if msg.Type == "drawing_visibility" && msg.DrawingsHidden {
					gotHide = true
				}
			}
			if !gotUpsert || !gotHide {
				errCh <- fmt.Errorf("subscriber %d missed events: upsert=%v hide=%v", idx, gotUpsert, gotHide)
			}
		}(i, conn)
	}
	wg.Wait()
	close(errCh)
	for ferr := range errCh {
		t.Fatal(ferr)
	}

	// Ensure unrelated account 200011 received nothing
	_ = otherConn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if _, raw, rerr := otherConn.ReadMessage(); rerr == nil {
		t.Fatalf("unrelated account 200011 received leaked message: %s", string(raw))
	}
}
