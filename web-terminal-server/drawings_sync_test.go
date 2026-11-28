package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
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
	resp, err = http.DefaultClient.Do(reqExpired)
	if err != nil {
		t.Fatalf("GET expired auth: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for expired token, got %d", resp.StatusCode)
	}

	reqOtherBroker, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/fix/drawings?symbol=EURUSD", nil)
	reqOtherBroker.Header.Set("Authorization", "Bearer "+tokOtherBroker)
	resp, err = http.DefaultClient.Do(reqOtherBroker)
	if err != nil {
		t.Fatalf("GET mismatched broker: %v", err)
	}
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
	if derr := json.NewDecoder(resp.Body).Decode(&saveOut); derr != nil {
		resp.Body.Close()
		t.Fatalf("decode save response: %v", derr)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !saveOut.Success || saveOut.DrawingID != "d-line-1" {
		t.Fatalf("unexpected save response: status=%d body=%+v", resp.StatusCode, saveOut)
	}

	// Account 200011 on the same broker must NOT see 200010's drawings
	reqOtherAcc, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/fix/drawings?symbol=EURUSD&timeframe=M1", nil)
	reqOtherAcc.Header.Set("Authorization", "Bearer "+tok200011)
	resp, err = http.DefaultClient.Do(reqOtherAcc)
	if err != nil {
		t.Fatalf("GET other account: %v", err)
	}
	var otherOut struct {
		Drawings []SyncedDrawing `json:"drawings"`
	}
	if derr := json.NewDecoder(resp.Body).Decode(&otherOut); derr != nil {
		resp.Body.Close()
		t.Fatalf("decode other account response: %v", derr)
	}
	resp.Body.Close()
	if len(otherOut.Drawings) != 0 {
		t.Fatalf("account 200011 leaked %d drawings from 200010", len(otherOut.Drawings))
	}

	// Hide drawings on 200010 EURUSD M1
	reqHide, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/fix/drawings/visibility", bytes.NewBufferString(`{"symbol":"EURUSD","timeframe":"M1","drawingsHidden":true}`))
	reqHide.Header.Set("Authorization", "Bearer "+tok200010)
	reqHide.Header.Set("Content-Type", "application/json")
	resp, err = http.DefaultClient.Do(reqHide)
	if err != nil {
		t.Fatalf("PUT visibility: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on visibility PUT, got %d", resp.StatusCode)
	}

	// Flush async disk persistence deterministically and reload from a fresh hub pointing at storageDir
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.ensureDrawingHub().waitForPersisted(ctx, "orrnn", 200010); err != nil {
		t.Fatalf("waitForPersisted failed: %v", err)
	}
	reloadedHub := newDrawingSyncHub(storageDir)
	rev, list, hidden, hiddenMap := reloadedHub.snapshotFor("orrnn", 200010, "EURUSD", "M1")
	if rev != 2 || len(list) != 1 || list[0].ID != "d-line-1" || !hidden || !hiddenMap["EURUSD::M1"] || !hiddenMap["*"] {
		t.Fatalf("reloaded hub missed persisted drawing/visibility: rev=%d count=%d hidden=%v hiddenMap=%v", rev, len(list), hidden, hiddenMap)
	}
	assertNoTempDrawingFiles(t, filepath.Join(storageDir, "orrnn"))
}

func assertNoTempDrawingFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		t.Fatalf("ReadDir(%s): %v", dir, err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp.") {
			t.Fatalf("unexpected leftover temp file in %s: %s", dir, entry.Name())
		}
	}
}

func TestDrawingSyncPersistenceOutOfOrderCompletionNewestWins(t *testing.T) {
	auth := drawingAuthContext{
		BrokerID:     "orrnn",
		AccountLogin: 200010,
		AccountKey:   normalizeDrawingAccountKey("orrnn", 200010),
		ClientID:     "test-client",
	}

	t.Run("in_flight_slow_write_superseded_by_upsert_delete_clear_visibility", func(t *testing.T) {
		storageDir := t.TempDir()
		hub := newDrawingSyncHub(storageDir)

		rev1Started := make(chan struct{})
		releaseRev1 := make(chan struct{})
		var rev1Once sync.Once
		var releaseRev1Once sync.Once
		releaseRev1Fn := func() { releaseRev1Once.Do(func() { close(releaseRev1) }) }

		rev5Started := make(chan struct{})
		releaseRev5 := make(chan struct{})
		var rev5Once sync.Once
		var releaseRev5Once sync.Once
		releaseRev5Fn := func() { releaseRev5Once.Do(func() { close(releaseRev5) }) }

		// LIFO defers: release hooks first, then drain worker before t.TempDir cleanup.
		defer func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = hub.waitForPersisted(ctx, "orrnn", 200010)
		}()
		defer releaseRev1Fn()
		defer releaseRev5Fn()

		hub.setPersistHooks(func(doc AccountDrawingsDocument) {
			switch doc.Revision {
			case 1:
				rev1Once.Do(func() { close(rev1Started) })
				<-releaseRev1
			case 5:
				rev5Once.Do(func() { close(rev5Started) })
				<-releaseRev5
			}
		}, nil)

		// Phase 1: Stall rev 1 write while rev 2 (upsert), rev 3 (delete), rev 4 (visibility) execute.
		if _, rev, err := hub.upsertDrawing(auth, "d-1", "hline", "EURUSD", "M1", json.RawMessage(`{"color":"#111111"}`)); err != nil || rev != 1 {
			t.Fatalf("upsert d-1: rev=%d err=%v", rev, err)
		}
		rev1Timer := time.NewTimer(3 * time.Second)
		select {
		case <-rev1Started:
			rev1Timer.Stop()
		case <-rev1Timer.C:
			t.Fatal("timed out waiting for rev 1 write to enter hook")
		}

		if _, rev, err := hub.upsertDrawing(auth, "d-2", "trendline", "EURUSD", "M1", json.RawMessage(`{"color":"#222222"}`)); err != nil || rev != 2 {
			t.Fatalf("upsert d-2: rev=%d err=%v", rev, err)
		}
		if deleted, rev := hub.deleteDrawing(auth, "d-1"); !deleted || rev != 3 {
			t.Fatalf("delete d-1: deleted=%v rev=%d", deleted, rev)
		}
		if rev, _ := hub.setVisibility(auth, "EURUSD", "M1", true); rev != 4 {
			t.Fatalf("setVisibility true: rev=%d, want 4", rev)
		}

		// Allow stalled rev 1 to finish after revisions 2..4 were already submitted.
		releaseRev1Fn()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted phase 1: %v", err)
		}

		reloaded1 := newDrawingSyncHub(storageDir)
		rev, list, hidden, _ := reloaded1.snapshotFor("orrnn", 200010, "EURUSD", "M1")
		if rev != 4 || len(list) != 1 || list[0].ID != "d-2" || !hidden {
			t.Fatalf("phase 1 newest revision lost: rev=%d list=%+v hidden=%v", rev, list, hidden)
		}

		// Phase 2: Stall rev 5 (upsert) while rev 6 (clear) and rev 7 (visibility false) execute.
		if _, rev, err := hub.upsertDrawing(auth, "d-3", "hline", "EURUSD", "M1", json.RawMessage(`{"color":"#333333"}`)); err != nil || rev != 5 {
			t.Fatalf("upsert d-3: rev=%d err=%v", rev, err)
		}
		rev5Timer := time.NewTimer(3 * time.Second)
		select {
		case <-rev5Started:
			rev5Timer.Stop()
		case <-rev5Timer.C:
			t.Fatal("timed out waiting for rev 5 write to enter hook")
		}

		if deletedCount, rev := hub.clearDrawings(auth, "EURUSD", "M1"); deletedCount != 2 || rev != 6 {
			t.Fatalf("clearDrawings: deleted=%d rev=%d", deletedCount, rev)
		}
		if rev, _ := hub.setVisibility(auth, "EURUSD", "M1", false); rev != 7 {
			t.Fatalf("setVisibility false: rev=%d, want 7", rev)
		}

		releaseRev5Fn()
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted phase 2: %v", err)
		}

		reloaded2 := newDrawingSyncHub(storageDir)
		rev, list, hidden, _ = reloaded2.snapshotFor("orrnn", 200010, "EURUSD", "M1")
		if rev != 7 || len(list) != 0 || hidden {
			t.Fatalf("phase 2 newest revision lost: rev=%d count=%d hidden=%v", rev, len(list), hidden)
		}
		assertNoTempDrawingFiles(t, filepath.Join(storageDir, "orrnn"))
	})

	t.Run("late_arrival_lower_revision_ignored_after_newer_persisted", func(t *testing.T) {
		storageDir := t.TempDir()
		hub := newDrawingSyncHub(storageDir)

		snap1 := AccountDrawingsDocument{
			BrokerID:     "orrnn",
			AccountLogin: 200010,
			Revision:     1,
			Drawings: map[string]*SyncedDrawing{
				"stale": {ID: "stale", Type: "hline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{"*": false},
		}
		snap2 := AccountDrawingsDocument{
			BrokerID:     "orrnn",
			AccountLogin: 200010,
			Revision:     2,
			Drawings: map[string]*SyncedDrawing{
				"newer": {ID: "newer", Type: "trendline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{"*": true, "EURUSD::M1": true},
		}

		// Persist rev 2 first, then simulate delayed arrival of rev 1.
		if err := hub.persistDocumentSnapshot(snap2); err != nil {
			t.Fatalf("persist snap2: %v", err)
		}
		hub.enqueuePersist(snap1)
		if err := hub.persistDocumentSnapshot(snap1); err != nil {
			t.Fatalf("late persist snap1 returned unexpected error: %v", err)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted: %v", err)
		}

		reloaded := newDrawingSyncHub(storageDir)
		rev, list, hidden, _ := reloaded.snapshotFor("orrnn", 200010, "EURUSD", "M1")
		if rev != 2 || len(list) != 1 || list[0].ID != "newer" || !hidden {
			t.Fatalf("stale rev 1 overwrote rev 2: rev=%d list=%+v hidden=%v", rev, list, hidden)
		}
	})

	t.Run("concurrent_direct_persist_out_of_order_completion", func(t *testing.T) {
		storageDir := t.TempDir()
		hub := newDrawingSyncHub(storageDir)

		rev1Started := make(chan struct{})
		releaseRev1 := make(chan struct{})
		var rev1Once sync.Once
		var releaseRev1Once sync.Once
		releaseRev1Fn := func() { releaseRev1Once.Do(func() { close(releaseRev1) }) }

		defer func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = hub.waitForPersisted(ctx, "orrnn", 200010)
		}()
		defer releaseRev1Fn()

		hub.setPersistHooks(func(doc AccountDrawingsDocument) {
			if doc.Revision == 1 {
				rev1Once.Do(func() { close(rev1Started) })
				<-releaseRev1
			}
		}, nil)

		snap1 := AccountDrawingsDocument{
			BrokerID:     "orrnn",
			AccountLogin: 200010,
			Revision:     1,
			Drawings: map[string]*SyncedDrawing{
				"old-1": {ID: "old-1", Type: "hline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{"*": false},
		}
		snap2 := AccountDrawingsDocument{
			BrokerID:     "orrnn",
			AccountLogin: 200010,
			Revision:     2,
			Drawings: map[string]*SyncedDrawing{
				"new-2": {ID: "new-2", Type: "hline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{"*": true},
		}

		errCh1 := make(chan error, 1)
		errCh2 := make(chan error, 1)
		go func() { errCh1 <- hub.persistDocumentSnapshot(snap1) }()

		rev1Timer := time.NewTimer(3 * time.Second)
		select {
		case <-rev1Started:
			rev1Timer.Stop()
		case <-rev1Timer.C:
			t.Fatal("timed out waiting for rev 1 to enter write hook")
		}

		go func() { errCh2 <- hub.persistDocumentSnapshot(snap2) }()

		// Deterministically wait on condition channel until snap2 is queued before releasing rev 1.
		st := hub.getOrCreatePersistState(normalizeDrawingAccountKey("orrnn", 200010))
		queueTimer := time.NewTimer(3 * time.Second)
		defer queueTimer.Stop()
		for {
			st.mu.Lock()
			seen := st.hasSeen && st.highestSeen >= 2
			var ch <-chan struct{}
			if !seen {
				ch = st.waitChLocked()
			}
			st.mu.Unlock()
			if seen {
				break
			}
			select {
			case <-ch:
			case <-queueTimer.C:
				t.Fatal("timed out waiting for snap2 to queue while rev 1 was blocked")
			}
		}

		releaseRev1Fn()
		if err := <-errCh1; err != nil {
			t.Fatalf("persist snap1 failed: %v", err)
		}
		if err := <-errCh2; err != nil {
			t.Fatalf("persist snap2 failed: %v", err)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted: %v", err)
		}

		reloaded := newDrawingSyncHub(storageDir)
		rev, list, hidden, _ := reloaded.snapshotFor("orrnn", 200010, "EURUSD", "M1")
		if rev != 2 || len(list) != 1 || list[0].ID != "new-2" || !hidden {
			t.Fatalf("out-of-order completion lost rev 2: rev=%d list=%+v hidden=%v", rev, list, hidden)
		}
	})

	t.Run("initial_revision_zero_and_independent_revision_waits", func(t *testing.T) {
		storageDir := t.TempDir()
		hub := newDrawingSyncHub(storageDir)

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// Drain-all on an untouched account returns immediately.
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted on untouched account: %v", err)
		}

		// Revision 0 initial snapshot must be accepted and persisted to disk.
		snap0 := AccountDrawingsDocument{
			BrokerID:     "orrnn",
			AccountLogin: 200010,
			Revision:     0,
			Drawings: map[string]*SyncedDrawing{
				"init-0": {ID: "init-0", Type: "hline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{},
		}
		if err := hub.persistDocumentSnapshot(snap0); err != nil {
			t.Fatalf("persistDocumentSnapshot(rev0): %v", err)
		}
		reloaded0 := newDrawingSyncHub(storageDir)
		rev, list, _, _ := reloaded0.snapshotFor("orrnn", 200010, "EURUSD", "M1")
		if rev != 0 || len(list) != 1 || list[0].ID != "init-0" {
			t.Fatalf("initial rev 0 snapshot lost: rev=%d list=%+v", rev, list)
		}

		// Stall rev 1 briefly so rev 2 is queued behind it; then stall rev 2 and fail it.
		// persistDocumentSnapshot(snap1) must return nil as soon as rev 1 persists, without waiting on rev 2.
		rev1Started := make(chan struct{})
		releaseRev1 := make(chan struct{})
		var rev1Once sync.Once
		var releaseRev1Once sync.Once
		releaseRev1Fn := func() { releaseRev1Once.Do(func() { close(releaseRev1) }) }

		rev2Started := make(chan struct{})
		releaseRev2 := make(chan struct{})
		var rev2Once sync.Once
		var releaseRev2Once sync.Once
		releaseRev2Fn := func() { releaseRev2Once.Do(func() { close(releaseRev2) }) }

		defer func() {
			cctx, ccancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer ccancel()
			_ = hub.waitForPersisted(cctx, "orrnn", 200010)
		}()
		defer releaseRev1Fn()
		defer releaseRev2Fn()

		var failRev2 atomic.Bool
		hub.setPersistHooks(func(doc AccountDrawingsDocument) {
			switch doc.Revision {
			case 1:
				rev1Once.Do(func() { close(rev1Started) })
				<-releaseRev1
			case 2:
				failRev2.Store(true)
				rev2Once.Do(func() { close(rev2Started) })
				<-releaseRev2
			}
		}, func(src, dst string) error {
			if failRev2.Load() {
				return errors.New("simulated rev2 write failure")
			}
			return os.Rename(src, dst)
		})

		snap1 := AccountDrawingsDocument{
			BrokerID:     "orrnn",
			AccountLogin: 200010,
			Revision:     1,
			Drawings: map[string]*SyncedDrawing{
				"d-1": {ID: "d-1", Type: "hline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{},
		}
		snap2 := AccountDrawingsDocument{
			BrokerID:     "orrnn",
			AccountLogin: 200010,
			Revision:     2,
			Drawings: map[string]*SyncedDrawing{
				"d-2": {ID: "d-2", Type: "hline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{},
		}

		snap1Done := make(chan error, 1)
		go func() { snap1Done <- hub.persistDocumentSnapshot(snap1) }()

		rev1Timer := time.NewTimer(3 * time.Second)
		select {
		case <-rev1Started:
			rev1Timer.Stop()
		case <-rev1Timer.C:
			t.Fatal("timed out waiting for rev 1 write to enter hook")
		}

		hub.enqueuePersist(snap2)
		releaseRev1Fn()

		rev2Timer := time.NewTimer(3 * time.Second)
		select {
		case <-rev2Started:
			rev2Timer.Stop()
		case <-rev2Timer.C:
			t.Fatal("timed out waiting for rev 2 write to enter hook")
		}

		// persistDocumentSnapshot(snap1) must finish immediately once rev 1 succeeds, even while rev 2 is blocked.
		snap1WaitTimer := time.NewTimer(2 * time.Second)
		select {
		case err := <-snap1Done:
			snap1WaitTimer.Stop()
			if err != nil {
				t.Fatalf("persistDocumentSnapshot(snap1) while rev 2 blocked: %v", err)
			}
		case <-snap1WaitTimer.C:
			t.Fatal("persistDocumentSnapshot(snap1) blocked behind rev 2")
		}

		// Release rev 2 so it fails; rev 1 wait must STILL return nil, while drain-all surfaces rev 2 error.
		releaseRev2Fn()
		drainErr := hub.waitForPersisted(ctx, "orrnn", 200010)
		if drainErr == nil || !strings.Contains(drainErr.Error(), "simulated rev2 write failure") {
			t.Fatalf("expected rev 2 drain error, got %v", drainErr)
		}
		if err := hub.waitForPersistedRevision(ctx, "orrnn", 200010, 1); err != nil {
			t.Fatalf("waitForPersistedRevision(1) after rev 2 failure: %v", err)
		}

		// Explicit retry of failed rev 2 succeeds once healthy.
		failRev2.Store(false)
		hub.setPersistHooks(nil, nil)
		if err := hub.persistDocumentSnapshot(snap2); err != nil {
			t.Fatalf("explicit retry of rev 2 failed: %v", err)
		}
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted after rev 2 recovery: %v", err)
		}
	})

	t.Run("restarted_hub_seeds_persist_state_and_canonical_key", func(t *testing.T) {
		storageDir := t.TempDir()
		hub1 := newDrawingSyncHub(storageDir)
		slashAuth := drawingAuthContext{
			BrokerID:     "Alpha/Beta",
			AccountLogin: 200010,
			AccountKey:   normalizeDrawingAccountKey("Alpha/Beta", 200010),
			ClientID:     "c1",
		}
		for i := 1; i <= 3; i++ {
			id := fmt.Sprintf("d-%d", i)
			if _, rev, err := hub1.upsertDrawing(slashAuth, id, "hline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != int64(i) {
				t.Fatalf("upsert %s: rev=%d err=%v", id, rev, err)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub1.waitForPersisted(ctx, "Alpha/Beta", 200010); err != nil {
			t.Fatalf("hub1 waitForPersisted: %v", err)
		}

		// Restart hub: snapshotFor loads rev 3 from disk and seeds persist state.
		hub2 := newDrawingSyncHub(storageDir)
		rev, list, _, _ := hub2.snapshotFor("Alpha/Beta", 200010, "EURUSD", "M1")
		if rev != 3 || len(list) != 3 {
			t.Fatalf("hub2 initial load: rev=%d count=%d", rev, len(list))
		}

		// Stale direct enqueue under both raw and canonical broker segments must be ignored.
		staleRaw := AccountDrawingsDocument{
			BrokerID:     "Alpha/Beta",
			AccountLogin: 200010,
			Revision:     2,
			Drawings: map[string]*SyncedDrawing{
				"stale": {ID: "stale", Type: "hline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{},
		}
		staleCanon := staleRaw
		staleCanon.BrokerID = "alpha_beta"
		hub2.enqueuePersist(staleRaw)
		hub2.enqueuePersist(staleCanon)
		if err := hub2.waitForPersisted(ctx, "Alpha/Beta", 200010); err != nil {
			t.Fatalf("hub2 waitForPersisted after stale enqueue: %v", err)
		}

		// Verify rev 3 is intact and next mutation advances to rev 4.
		reloadedBeforeMut := newDrawingSyncHub(storageDir)
		rev, list, _, _ = reloadedBeforeMut.snapshotFor("Alpha/Beta", 200010, "EURUSD", "M1")
		if rev != 3 || len(list) != 3 {
			t.Fatalf("stale enqueue overwrote seeded rev 3: rev=%d count=%d", rev, len(list))
		}
		if _, rev, err := hub2.upsertDrawing(slashAuth, "d-4", "hline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != 4 {
			t.Fatalf("hub2 upsert d-4: rev=%d err=%v", rev, err)
		}
		if err := hub2.waitForPersisted(ctx, "Alpha/Beta", 200010); err != nil {
			t.Fatalf("hub2 waitForPersisted after d-4: %v", err)
		}

		reloadedAfterMut := newDrawingSyncHub(storageDir)
		rev, list, _, _ = reloadedAfterMut.snapshotFor("Alpha/Beta", 200010, "EURUSD", "M1")
		if rev != 4 || len(list) != 4 {
			t.Fatalf("hub2 rev 4 missing: rev=%d count=%d", rev, len(list))
		}
		assertNoTempDrawingFiles(t, filepath.Join(storageDir, safeStorageSegment("Alpha/Beta")))

		// Equivalent segments mapping to "default" must share persist state ordering.
		hub3 := newDrawingSyncHub(storageDir)
		if err := hub3.persistDocumentSnapshot(AccountDrawingsDocument{
			BrokerID:     "default",
			AccountLogin: 200012,
			Revision:     2,
			Drawings: map[string]*SyncedDrawing{
				"def-2": {ID: "def-2", Type: "hline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{},
		}); err != nil {
			t.Fatalf("persist default rev 2: %v", err)
		}
		hub3.enqueuePersist(AccountDrawingsDocument{
			BrokerID:     "",
			AccountLogin: 200012,
			Revision:     1,
			Drawings: map[string]*SyncedDrawing{
				"empty-1": {ID: "empty-1", Type: "hline", Symbol: "EURUSD", Timeframe: "M1", Properties: json.RawMessage(`{}`)},
			},
			DrawingsHidden: map[string]bool{},
		})
		if err := hub3.waitForPersisted(ctx, "default", 200012); err != nil {
			t.Fatalf("hub3 waitForPersisted: %v", err)
		}
		reloadedDef := newDrawingSyncHub(storageDir)
		rev, list, _, _ = reloadedDef.snapshotFor("default", 200012, "EURUSD", "M1")
		if rev != 2 || len(list) != 1 || list[0].ID != "def-2" {
			t.Fatalf("canonical key divergence overwrote default rev 2: rev=%d list=%+v", rev, list)
		}
	})
}

func TestDrawingSyncPersistenceTempCleanupAndSharingRetry(t *testing.T) {
	auth := drawingAuthContext{
		BrokerID:     "orrnn",
		AccountLogin: 200010,
		AccountKey:   normalizeDrawingAccountKey("orrnn", 200010),
		ClientID:     "test-client",
	}

	t.Run("unique_temp_files_cleaned_and_retry_on_sharing_violation", func(t *testing.T) {
		if isRetryablePersistErr(nil) {
			t.Fatal("nil error must not be retryable")
		}
		if isRetryablePersistErr(errors.New("simulated disk full")) {
			t.Fatal("arbitrary error must not be retryable")
		}
		if runtime.GOOS == "windows" {
			if !isRetryablePersistErr(os.ErrPermission) {
				t.Fatal("os.ErrPermission must be retryable on Windows")
			}
			for _, errno := range []syscall.Errno{5, 32, 33} {
				if !isRetryablePersistErr(errno) {
					t.Fatalf("Windows errno %d must be retryable", errno)
				}
			}
		} else {
			if isRetryablePersistErr(os.ErrPermission) {
				t.Fatal("os.ErrPermission must NOT be retryable on non-Windows")
			}
			for _, err := range []error{syscall.EINTR, syscall.EAGAIN, syscall.EBUSY} {
				if !isRetryablePersistErr(err) {
					t.Fatalf("non-Windows transient errno %v must be retryable", err)
				}
			}
		}

		storageDir := t.TempDir()
		hub := newDrawingSyncHub(storageDir)

		var attempts atomic.Int32
		seenTmpNames := make(map[string]struct{})
		var namesMu sync.Mutex

		hub.setPersistHooks(nil, func(src, dst string) error {
			namesMu.Lock()
			seenTmpNames[filepath.Base(src)] = struct{}{}
			namesMu.Unlock()

			n := attempts.Add(1)
			if n <= 2 {
				if runtime.GOOS == "windows" {
					return &os.LinkError{Op: "rename", Old: src, New: dst, Err: syscall.Errno(32)}
				}
				return &os.LinkError{Op: "rename", Old: src, New: dst, Err: syscall.EBUSY}
			}
			return os.Rename(src, dst)
		})

		if _, rev, err := hub.upsertDrawing(auth, "d-retry", "hline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != 1 {
			t.Fatalf("upsertDrawing: rev=%d err=%v", rev, err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted failed after retryable errors: %v", err)
		}
		if got := attempts.Load(); got != 3 {
			t.Fatalf("rename attempts = %d, want 3", got)
		}

		// Perform a second mutation and verify unique temp names were generated and cleaned up.
		if _, rev, err := hub.upsertDrawing(auth, "d-retry-2", "hline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != 2 {
			t.Fatalf("second upsertDrawing: rev=%d err=%v", rev, err)
		}
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted second write failed: %v", err)
		}

		namesMu.Lock()
		uniqueCount := len(seenTmpNames)
		namesMu.Unlock()
		if uniqueCount < 2 {
			t.Fatalf("expected unique temp filenames across writes, got %d", uniqueCount)
		}

		reloaded := newDrawingSyncHub(storageDir)
		rev, list, _, _ := reloaded.snapshotFor("orrnn", 200010, "EURUSD", "M1")
		if rev != 2 || len(list) != 2 {
			t.Fatalf("reloaded hub after retry: rev=%d count=%d", rev, len(list))
		}
		assertNoTempDrawingFiles(t, filepath.Join(storageDir, "orrnn"))
	})

	t.Run("permanent_rename_error_surfaced_and_temp_cleaned", func(t *testing.T) {
		storageDir := t.TempDir()
		hub := newDrawingSyncHub(storageDir)

		var permAttempts atomic.Int32
		hub.setPersistHooks(nil, func(src, dst string) error {
			permAttempts.Add(1)
			if runtime.GOOS != "windows" {
				return &os.LinkError{Op: "rename", Old: src, New: dst, Err: os.ErrPermission}
			}
			return errors.New("simulated disk full")
		})

		if _, rev, err := hub.upsertDrawing(auth, "d-fail", "hline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != 1 {
			t.Fatalf("upsertDrawing: rev=%d err=%v", rev, err)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err := hub.waitForPersisted(ctx, "orrnn", 200010)
		if runtime.GOOS != "windows" {
			if !errors.Is(err, os.ErrPermission) {
				t.Fatalf("expected surfaced os.ErrPermission on non-Windows, got %v", err)
			}
		} else if err == nil || !strings.Contains(err.Error(), "simulated disk full") {
			t.Fatalf("expected surfaced error containing 'simulated disk full', got %v", err)
		}
		if got := permAttempts.Load(); got != 1 {
			t.Fatalf("permanent error must fail in 1 attempt without retry, got %d", got)
		}
		assertNoTempDrawingFiles(t, filepath.Join(storageDir, "orrnn"))

		// Recover once disk is healthy again and a new snapshot arrives.
		hub.setPersistHooks(nil, nil)
		if _, rev, uerr := hub.upsertDrawing(auth, "d-recover", "hline", "EURUSD", "M1", json.RawMessage(`{}`)); uerr != nil || rev != 2 {
			t.Fatalf("recovery upsertDrawing: rev=%d err=%v", rev, uerr)
		}
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted recovery failed: %v", err)
		}
		reloaded := newDrawingSyncHub(storageDir)
		rev, list, _, _ := reloaded.snapshotFor("orrnn", 200010, "EURUSD", "M1")
		if rev != 2 || len(list) != 2 {
			t.Fatalf("reloaded hub after recovery: rev=%d count=%d", rev, len(list))
		}
		assertNoTempDrawingFiles(t, filepath.Join(storageDir, "orrnn"))
	})
}

func TestDrawingSyncFanoutTo100ConcurrentUsersAndVisibilityToggle(t *testing.T) {
	srv, storageDir := newTestDrawingServer(t, "orrnn")
	ts := httptest.NewServer(http.HandlerFunc(srv.serveHTTP))
	defer ts.Close()

	tok200010 := makeTestDrawingJWT("orrnn", 200010, time.Hour)
	tok200011 := makeTestDrawingJWT("orrnn", 200011, time.Hour)
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http") + "/__rtx5_drawing_ws"

	const subscriberCount = 100
	conns := make([]*websocket.Conn, 0, subscriberCount)
	defer func() {
		for _, conn := range conns {
			_ = conn.Close()
		}
	}()
	for i := 0; i < subscriberCount; i++ {
		wsURL := fmt.Sprintf("%s?token=%s&clientId=user-%d", wsBase, tok200010, i)
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatalf("dial subscriber %d: %v", i, err)
		}
		conns = append(conns, conn)
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
	}

	// Connect an unrelated account 200011 to verify it never receives 200010 events
	otherConn, _, err := websocket.DefaultDialer.Dial(wsBase+"?token="+tok200011+"&clientId=other", nil)
	if err != nil {
		t.Fatalf("dial other account: %v", err)
	}
	defer otherConn.Close()
	_ = otherConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, rerr := otherConn.ReadMessage(); rerr != nil {
		t.Fatalf("other account initial snapshot: %v", rerr)
	}

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
	if err != nil {
		t.Fatalf("save drawing failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save drawing status = %d", resp.StatusCode)
	}

	hideReq, _ := http.NewRequest(
		http.MethodPut,
		ts.URL+"/api/fix/drawings/visibility",
		bytes.NewBufferString(`{"symbol":"EURUSD","timeframe":"M1","drawingsHidden":true}`),
	)
	hideReq.Header.Set("Authorization", "Bearer "+tok200010)
	hideReq.Header.Set("Content-Type", "application/json")
	hideReq.Header.Set("X-Client-ID", "user-0")
	resp, err = http.DefaultClient.Do(hideReq)
	if err != nil {
		t.Fatalf("hide drawings failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("hide drawings status = %d", resp.StatusCode)
	}

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

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.ensureDrawingHub().waitForPersisted(ctx, "orrnn", 200010); err != nil {
		t.Fatalf("waitForPersisted failed: %v", err)
	}
	assertNoTempDrawingFiles(t, filepath.Join(storageDir, "orrnn"))
}

func TestDrawingSyncConcurrentBroadcastAndSubscriberClose(t *testing.T) {
	t.Run("hub_broadcast_concurrent_with_unregister_and_slow_consumer_close", func(t *testing.T) {
		hub := newDrawingSyncHub(t.TempDir())
		accountKey := normalizeDrawingAccountKey("orrnn", 200010)

		const (
			rounds         = 12
			subsPerRound   = 24
			broadcasters   = 6
			msgsPerWorker  = 40
		)
		for round := 0; round < rounds; round++ {
			subs := make([]*drawingWSSub, subsPerRound)
			for i := 0; i < subsPerRound; i++ {
				sub := newDrawingWSSub(accountKey, fmt.Sprintf("sub-%d-%d", round, i))
				// Half start full to force the drop-oldest branch under concurrent close.
				if i%2 == 0 {
					for j := 0; j < drawingWSSendQueueCap; j++ {
						sub.sendCh <- []byte(`{"type":"prefill"}`)
					}
				}
				subs[i] = sub
				hub.registerSub(sub)
			}

			start := make(chan struct{})
			var wg sync.WaitGroup
			for b := 0; b < broadcasters; b++ {
				wg.Add(1)
				go func(worker int) {
					defer wg.Done()
					<-start
					for m := 0; m < msgsPerWorker; m++ {
						hub.broadcast(accountKey, map[string]any{
							"type":   "drawing_upsert",
							"worker": worker,
							"seq":    m,
						})
					}
				}(b)
			}
			for _, sub := range subs {
				wg.Add(1)
				go func(s *drawingWSSub) {
					defer wg.Done()
					<-start
					s.enqueue([]byte(`{"type":"drawing_snapshot"}`))
					hub.unregisterSub(s)
					s.close()
				}(sub)
			}
			close(start)
			wg.Wait()
		}
	})

	t.Run("ws_subscribers_close_while_broadcasts_in_flight", func(t *testing.T) {
		srv, storageDir := newTestDrawingServer(t, "orrnn")
		ts := httptest.NewServer(http.HandlerFunc(srv.serveHTTP))
		defer ts.Close()

		tok := makeTestDrawingJWT("orrnn", 200010, time.Hour)
		wsBase := "ws" + strings.TrimPrefix(ts.URL, "http") + "/__rtx5_drawing_ws"
		auth := drawingAuthContext{
			BrokerID:     "orrnn",
			AccountLogin: 200010,
			AccountKey:   normalizeDrawingAccountKey("orrnn", 200010),
			ClientID:     "broadcaster",
		}
		hub := srv.ensureDrawingHub()

		const (
			writerCount = 4
			writesEach  = 30
			clientCount = 16
		)
		start := make(chan struct{})
		var writersWG sync.WaitGroup
		var clientsWG sync.WaitGroup

		for w := 0; w < writerCount; w++ {
			writersWG.Add(1)
			go func(wid int) {
				defer writersWG.Done()
				<-start
				for i := 0; i < writesEach; i++ {
					id := fmt.Sprintf("race-drw-%d-%d", wid, i)
					_, _, _ = hub.upsertDrawing(auth, id, "hline", "EURUSD", "M1", json.RawMessage(`{}`))
					if i%5 == 0 {
						_, _ = hub.setVisibility(auth, "EURUSD", "M1", i%2 == 0)
					}
				}
			}(w)
		}

		errCh := make(chan error, clientCount)
		for c := 0; c < clientCount; c++ {
			clientsWG.Add(1)
			go func(cid int) {
				defer clientsWG.Done()
				<-start
				for iter := 0; iter < 3; iter++ {
					wsURL := fmt.Sprintf("%s?token=%s&clientId=churn-%d-%d", wsBase, tok, cid, iter)
					conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
					if err != nil {
						errCh <- fmt.Errorf("dial churn-%d-%d: %w", cid, iter, err)
						return
					}
					_ = conn.WriteJSON(map[string]any{"action": "ping"})
					_ = conn.WriteJSON(map[string]any{"action": "sync"})
					_ = conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
					_, _, _ = conn.ReadMessage()
					_ = conn.Close()
				}
			}(c)
		}

		close(start)
		clientsWG.Wait()
		writersWG.Wait()
		close(errCh)
		for err := range errCh {
			t.Fatal(err)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
			t.Fatalf("waitForPersisted failed: %v", err)
		}
		assertNoTempDrawingFiles(t, filepath.Join(storageDir, "orrnn"))
	})
}

func TestDrawingSyncCanonicalAccountKeyAnd1218Compat(t *testing.T) {
	t.Run("reviewer_counterexample_two_spellings_shared_load_and_upserts", func(t *testing.T) {
		storageDir := t.TempDir()
		hub1 := newDrawingSyncHub(storageDir)
		defer func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = hub1.waitForPersisted(ctx, "Alpha/Beta", 200010)
		}()

		alphaAuth := drawingAuthContext{
			BrokerID:     "Alpha/Beta",
			AccountLogin: 200010,
			AccountKey:   normalizeDrawingAccountKey("Alpha/Beta", 200010),
			ClientID:     "c-alpha",
		}
		betaAuth := drawingAuthContext{
			BrokerID:     "alpha_beta",
			AccountLogin: 200010,
			AccountKey:   normalizeDrawingAccountKey("alpha_beta", 200010),
			ClientID:     "c-beta",
		}
		if alphaAuth.AccountKey != betaAuth.AccountKey {
			t.Fatalf("canonical AccountKey mismatch: %q vs %q", alphaAuth.AccountKey, betaAuth.AccountKey)
		}

		// Step 1: Alpha/Beta persists up to revision 3.
		for i := 1; i <= 3; i++ {
			id := fmt.Sprintf("d-%d", i)
			if _, rev, err := hub1.upsertDrawing(alphaAuth, id, "hline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != int64(i) {
				t.Fatalf("hub1 upsert %s: rev=%d err=%v", id, rev, err)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub1.waitForPersisted(ctx, "Alpha/Beta", 200010); err != nil {
			t.Fatalf("hub1 waitForPersisted: %v", err)
		}
		expectedPath := filepath.Join(storageDir, "alpha_beta", "200010.json")
		if _, err := os.Stat(expectedPath); err != nil {
			t.Fatalf("expected persisted file at %s: %v", expectedPath, err)
		}

		// Step 2: Restarted hub loads via alpha_beta first, then both spellings operate on the shared account.
		hub2 := newDrawingSyncHub(storageDir)
		defer func() {
			dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer dcancel()
			_ = hub2.waitForPersisted(dctx, "alpha_beta", 200010)
		}()
		rev, list, _, _ := hub2.snapshotFor("alpha_beta", 200010, "EURUSD", "M1")
		if rev != 3 || len(list) != 3 {
			t.Fatalf("hub2 shared load via alpha_beta: rev=%d count=%d", rev, len(list))
		}
		revAlpha, listAlpha, _, _ := hub2.snapshotFor("Alpha/Beta", 200010, "EURUSD", "M1")
		if revAlpha != 3 || len(listAlpha) != 3 {
			t.Fatalf("hub2 shared load via Alpha/Beta: rev=%d count=%d", revAlpha, len(listAlpha))
		}

		// Step 3: Alpha/Beta upserts (3 -> 4) and persists.
		if _, rev, err := hub2.upsertDrawing(alphaAuth, "d-alpha-4", "hline", "EURUSD", "M1", json.RawMessage(`{"step":4}`)); err != nil || rev != 4 {
			t.Fatalf("step 3 Alpha/Beta upsert: rev=%d err=%v", rev, err)
		}
		if err := hub2.waitForPersisted(ctx, "Alpha/Beta", 200010); err != nil {
			t.Fatalf("step 3 waitForPersisted: %v", err)
		}

		// Step 4: alpha_beta upserts (4 -> 5, never skipped as duplicate rev 4) and persists.
		if _, rev, err := hub2.upsertDrawing(betaAuth, "d-beta-5", "trendline", "EURUSD", "M1", json.RawMessage(`{"step":5}`)); err != nil || rev != 5 {
			t.Fatalf("step 4 alpha_beta upsert: rev=%d err=%v", rev, err)
		}
		if err := hub2.waitForPersisted(ctx, "alpha_beta", 200010); err != nil {
			t.Fatalf("step 4 waitForPersisted: %v", err)
		}
		checkStep4 := newDrawingSyncHub(storageDir)
		rev, list, _, _ = checkStep4.snapshotFor("Alpha/Beta", 200010, "EURUSD", "M1")
		if rev != 5 || len(list) != 5 {
			t.Fatalf("step 4 disk state missing d-alpha-4 or d-beta-5: rev=%d count=%d", rev, len(list))
		}

		// Step 5: alpha_beta upserts (5 -> 6) and Alpha/Beta upserts (6 -> 7); no stale fork resurrected.
		if _, rev, err := hub2.upsertDrawing(betaAuth, "d-beta-6", "hline", "EURUSD", "M1", json.RawMessage(`{"step":6}`)); err != nil || rev != 6 {
			t.Fatalf("step 5 alpha_beta upsert: rev=%d err=%v", rev, err)
		}
		if _, rev, err := hub2.upsertDrawing(alphaAuth, "d-alpha-7", "hline", "EURUSD", "M1", json.RawMessage(`{"step":7}`)); err != nil || rev != 7 {
			t.Fatalf("step 5 Alpha/Beta upsert: rev=%d err=%v", rev, err)
		}
		if err := hub2.waitForPersisted(ctx, "Alpha/Beta", 200010); err != nil {
			t.Fatalf("step 5 waitForPersisted: %v", err)
		}

		reloaded := newDrawingSyncHub(storageDir)
		rev, list, _, _ = reloaded.snapshotFor("alpha_beta", 200010, "EURUSD", "M1")
		if rev != 7 || len(list) != 7 {
			t.Fatalf("step 5 final disk state: rev=%d count=%d, want rev=7 count=7", rev, len(list))
		}
		seenIDs := make(map[string]bool, len(list))
		for _, d := range list {
			seenIDs[d.ID] = true
		}
		for _, wantID := range []string{"d-1", "d-2", "d-3", "d-alpha-4", "d-beta-5", "d-beta-6", "d-alpha-7"} {
			if !seenIDs[wantID] {
				t.Fatalf("final disk state missing drawing %q (got %+v)", wantID, seenIDs)
			}
		}

		// Empty and "default" broker spellings must also share one account, persist state, and file.
		if normalizeDrawingAccountKey("", 200012) != normalizeDrawingAccountKey("default", 200012) {
			t.Fatalf("empty and default account keys diverged: %q vs %q", normalizeDrawingAccountKey("", 200012), normalizeDrawingAccountKey("default", 200012))
		}
		emptyAuth := drawingAuthContext{BrokerID: "", AccountLogin: 200012, ClientID: "c-empty"}
		defaultAuth := drawingAuthContext{BrokerID: "default", AccountLogin: 200012, ClientID: "c-default"}
		defer func() {
			dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer dcancel()
			_ = hub2.waitForPersisted(dctx, "default", 200012)
		}()
		if _, rev, err := hub2.upsertDrawing(emptyAuth, "def-1", "hline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != 1 {
			t.Fatalf("empty broker upsert: rev=%d err=%v", rev, err)
		}
		if _, rev, err := hub2.upsertDrawing(defaultAuth, "def-2", "hline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != 2 {
			t.Fatalf("default broker upsert: rev=%d err=%v", rev, err)
		}
		if err := hub2.waitForPersisted(ctx, "", 200012); err != nil {
			t.Fatalf("empty/default waitForPersisted: %v", err)
		}
		reloadedDef := newDrawingSyncHub(storageDir)
		rev, list, _, _ = reloadedDef.snapshotFor("", 200012, "EURUSD", "M1")
		if rev != 2 || len(list) != 2 {
			t.Fatalf("empty/default reloaded state: rev=%d count=%d", rev, len(list))
		}

		// HTTP + WebSocket end-to-end: subscribers using both spellings share one WS room and document.
		srv, srvStorageDir := newTestDrawingServer(t, "")
		defer func() {
			dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer dcancel()
			_ = srv.ensureDrawingHub().waitForPersisted(dctx, "Alpha/Beta", 200010)
		}()
		ts := httptest.NewServer(http.HandlerFunc(srv.serveHTTP))
		defer ts.Close()

		tokAlpha := makeTestDrawingJWT("Alpha/Beta", 200010, time.Hour)
		tokBeta := makeTestDrawingJWT("alpha_beta", 200010, time.Hour)
		wsBase := "ws" + strings.TrimPrefix(ts.URL, "http") + "/__rtx5_drawing_ws"

		wsAlpha, _, err := websocket.DefaultDialer.Dial(wsBase+"?token="+tokAlpha+"&clientId=ws-alpha", nil)
		if err != nil {
			t.Fatalf("dial wsAlpha: %v", err)
		}
		defer wsAlpha.Close()
		wsBeta, _, err := websocket.DefaultDialer.Dial(wsBase+"?token="+tokBeta+"&clientId=ws-beta", nil)
		if err != nil {
			t.Fatalf("dial wsBeta: %v", err)
		}
		defer wsBeta.Close()

		for name, c := range map[string]*websocket.Conn{"wsAlpha": wsAlpha, "wsBeta": wsBeta} {
			_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
			if _, _, rerr := c.ReadMessage(); rerr != nil {
				t.Fatalf("%s initial snapshot: %v", name, rerr)
			}
		}

		postDrawing := func(tok, clientID, id string) {
			req, _ := http.NewRequest(
				http.MethodPost,
				ts.URL+"/api/fix/drawings",
				bytes.NewBufferString(fmt.Sprintf(`{"type":"hline","symbol":"EURUSD","timeframe":"M1","properties":{"id":%q}}`, id)),
			)
			req.Header.Set("Authorization", "Bearer "+tok)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Client-ID", clientID)
			resp, derr := http.DefaultClient.Do(req)
			if derr != nil {
				t.Fatalf("POST %s: %v", id, derr)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("POST %s status = %d", id, resp.StatusCode)
			}
		}
		postDrawing(tokAlpha, "ws-alpha", "http-alpha-1")
		postDrawing(tokBeta, "ws-beta", "http-beta-2")

		for name, c := range map[string]*websocket.Conn{"wsAlpha": wsAlpha, "wsBeta": wsBeta} {
			got := make(map[string]bool)
			for i := 0; i < 2; i++ {
				_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
				_, raw, rerr := c.ReadMessage()
				if rerr != nil {
					t.Fatalf("%s read %d: %v", name, i, rerr)
				}
				var msg struct {
					Type    string         `json:"type"`
					Drawing *SyncedDrawing `json:"drawing"`
				}
				if json.Unmarshal(raw, &msg) != nil || msg.Type != "drawing_upsert" || msg.Drawing == nil {
					t.Fatalf("%s unexpected event: %s", name, string(raw))
				}
				got[msg.Drawing.ID] = true
			}
			if !got["http-alpha-1"] || !got["http-beta-2"] {
				t.Fatalf("%s missed shared-room drawings: %+v", name, got)
			}
		}
		if err := srv.ensureDrawingHub().waitForPersisted(ctx, "alpha_beta", 200010); err != nil {
			t.Fatalf("http/ws waitForPersisted: %v", err)
		}
		reloadedWS := newDrawingSyncHub(srvStorageDir)
		rev, list, _, _ = reloadedWS.snapshotFor("Alpha/Beta", 200010, "EURUSD", "M1")
		if rev != 2 || len(list) != 2 {
			t.Fatalf("http/ws final persisted state: rev=%d count=%d", rev, len(list))
		}
	})

	t.Run("loads_1_2_18_written_file_without_moving", func(t *testing.T) {
		storageDir := t.TempDir()

		writeLegacyFile := func(dirSeg, brokerField string, login, rev int64, drawingID string, hidden bool) string {
			dir := filepath.Join(storageDir, dirSeg)
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatalf("mkdir legacy %s: %v", dir, err)
			}
			fp := filepath.Join(dir, fmt.Sprintf("%d.json", login))
			legacyDoc := AccountDrawingsDocument{
				BrokerID:     brokerField,
				AccountLogin: login,
				Revision:     rev,
				Drawings: map[string]*SyncedDrawing{
					drawingID: {
						ID:         drawingID,
						Type:       "hline",
						Symbol:     "EURUSD",
						Timeframe:  "M1",
						UserID:     fmt.Sprintf("%d", login),
						Properties: json.RawMessage(`{"price":1.095}`),
						CreatedAt:  "2026-11-20T10:00:00Z",
						UpdatedAt:  "2026-11-20T10:00:00Z",
					},
				},
				DrawingsHidden: map[string]bool{"*": hidden, "EURUSD::M1": hidden},
				UpdatedAt:      "2026-11-20T10:00:00Z",
			}
			raw, err := json.Marshal(&legacyDoc)
			if err != nil {
				t.Fatalf("marshal legacy doc: %v", err)
			}
			if err := os.WriteFile(fp, raw, 0600); err != nil {
				t.Fatalf("write legacy file %s: %v", fp, err)
			}
			return fp
		}

		// Exact 1.2.18 on-disk layout: <storageDir>/<safeStorageSegment(brokerID)>/<login>.json
		alphaPath := writeLegacyFile("alpha_beta", "alpha/beta", 200010, 3, "legacy-alpha-1", true)
		defaultPath := writeLegacyFile("default", "", 200011, 2, "legacy-default-1", false)
		orrnnPath := writeLegacyFile("orrnn", "orrnn", 200012, 4, "legacy-orrnn-1", false)

		hub := newDrawingSyncHub(storageDir)
		defer func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = hub.waitForPersisted(ctx, "Alpha/Beta", 200010)
			_ = hub.waitForPersisted(ctx, "", 200011)
			_ = hub.waitForPersisted(ctx, "orrnn", 200012)
		}()

		rev, list, hidden, hiddenMap := hub.snapshotFor("Alpha/Beta", 200010, "EURUSD", "M1")
		if rev != 3 || len(list) != 1 || list[0].ID != "legacy-alpha-1" || !hidden || !hiddenMap["EURUSD::M1"] {
			t.Fatalf("legacy alpha/beta load failed: rev=%d list=%+v hidden=%v hiddenMap=%v", rev, list, hidden, hiddenMap)
		}
		rev, list, hidden, _ = hub.snapshotFor("alpha_beta", 200010, "EURUSD", "M1")
		if rev != 3 || len(list) != 1 || list[0].ID != "legacy-alpha-1" || !hidden {
			t.Fatalf("legacy alpha_beta lookup failed: rev=%d list=%+v hidden=%v", rev, list, hidden)
		}
		rev, list, hidden, _ = hub.snapshotFor("", 200011, "EURUSD", "M1")
		if rev != 2 || len(list) != 1 || list[0].ID != "legacy-default-1" || hidden {
			t.Fatalf("legacy empty broker load failed: rev=%d list=%+v hidden=%v", rev, list, hidden)
		}
		rev, list, _, _ = hub.snapshotFor("default", 200011, "EURUSD", "M1")
		if rev != 2 || len(list) != 1 || list[0].ID != "legacy-default-1" {
			t.Fatalf("legacy default broker lookup failed: rev=%d list=%+v", rev, list)
		}
		rev, list, _, _ = hub.snapshotFor("orrnn", 200012, "EURUSD", "M1")
		if rev != 4 || len(list) != 1 || list[0].ID != "legacy-orrnn-1" {
			t.Fatalf("legacy orrnn load failed: rev=%d list=%+v", rev, list)
		}

		// Verify existing files stayed in place and subsequent mutations persist to those exact paths.
		if _, rev, err := hub.upsertDrawing(drawingAuthContext{BrokerID: "alpha_beta", AccountLogin: 200010}, "post-1218", "trendline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != 4 {
			t.Fatalf("post-1.2.18 upsert alpha_beta: rev=%d err=%v", rev, err)
		}
		if _, rev, err := hub.upsertDrawing(drawingAuthContext{BrokerID: "", AccountLogin: 200011}, "post-1218-def", "hline", "EURUSD", "M1", json.RawMessage(`{}`)); err != nil || rev != 3 {
			t.Fatalf("post-1.2.18 upsert default: rev=%d err=%v", rev, err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub.waitForPersisted(ctx, "alpha_beta", 200010); err != nil {
			t.Fatalf("waitForPersisted alpha_beta: %v", err)
		}
		if err := hub.waitForPersisted(ctx, "", 200011); err != nil {
			t.Fatalf("waitForPersisted default: %v", err)
		}
		for _, fp := range []string{alphaPath, defaultPath, orrnnPath} {
			if _, err := os.Stat(fp); err != nil {
				t.Fatalf("expected 1.2.18 file path %s to remain in place: %v", fp, err)
			}
		}
		entries, err := os.ReadDir(storageDir)
		if err != nil || len(entries) != 3 {
			t.Fatalf("unexpected storage directories after 1.2.18 load/update: err=%v count=%d", err, len(entries))
		}

		reloaded := newDrawingSyncHub(storageDir)
		rev, list, _, _ = reloaded.snapshotFor("Alpha/Beta", 200010, "EURUSD", "M1")
		if rev != 4 || len(list) != 2 {
			t.Fatalf("reloaded 1.2.18 alpha_beta after upsert: rev=%d count=%d", rev, len(list))
		}
		rev, list, _, _ = reloaded.snapshotFor("default", 200011, "EURUSD", "M1")
		if rev != 3 || len(list) != 2 {
			t.Fatalf("reloaded 1.2.18 default after upsert: rev=%d count=%d", rev, len(list))
		}
	})
}

type stopReadPeerListener struct {
	net.Listener
	mu          sync.Mutex
	conns       []*stopReadPeerConn
	connReady   chan *stopReadPeerConn
	blockFirst  atomic.Bool
}

func (l *stopReadPeerListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	wrapped := &stopReadPeerConn{
		Conn:   c,
		parent: l,
		closed: make(chan struct{}),
	}
	l.mu.Lock()
	idx := len(l.conns)
	l.conns = append(l.conns, wrapped)
	l.mu.Unlock()
	if idx == 0 {
		wrapped.stallWrites = true
	}
	select {
	case l.connReady <- wrapped:
	default:
	}
	return wrapped, nil
}

type stopReadPeerConn struct {
	net.Conn
	parent        *stopReadPeerListener
	stallWrites   bool
	mu            sync.Mutex
	writeDeadline time.Time
	closed        chan struct{}
	closeOnce     sync.Once
}

func (c *stopReadPeerConn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	c.writeDeadline = t
	c.mu.Unlock()
	return c.Conn.SetWriteDeadline(t)
}

func (c *stopReadPeerConn) SetDeadline(t time.Time) error {
	c.mu.Lock()
	c.writeDeadline = t
	c.mu.Unlock()
	return c.Conn.SetDeadline(t)
}

func (c *stopReadPeerConn) Write(b []byte) (int, error) {
	if c.stallWrites && c.parent.blockFirst.Load() {
		c.mu.Lock()
		dl := c.writeDeadline
		c.mu.Unlock()
		if !dl.IsZero() {
			wait := time.Until(dl)
			if wait <= 0 {
				return 0, os.ErrDeadlineExceeded
			}
			timer := time.NewTimer(wait)
			defer timer.Stop()
			select {
			case <-c.closed:
				return 0, net.ErrClosed
			case <-timer.C:
				return 0, os.ErrDeadlineExceeded
			}
		}
		<-c.closed
		return 0, net.ErrClosed
	}
	return c.Conn.Write(b)
}

func (c *stopReadPeerConn) Close() error {
	c.closeOnce.Do(func() {
		close(c.closed)
	})
	return c.Conn.Close()
}

func TestDrawingSyncWSWriteErrorPeerStopsReading(t *testing.T) {
	srv, storageDir := newTestDrawingServer(t, "orrnn")
	hub := srv.ensureDrawingHub()
	hub.wsWriteWait = 40 * time.Millisecond
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hub.waitForPersisted(ctx, "orrnn", 200010)
	}()

	rawLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ln := &stopReadPeerListener{
		Listener:  rawLn,
		connReady: make(chan *stopReadPeerConn, 4),
	}
	ts := httptest.NewUnstartedServer(http.HandlerFunc(srv.serveHTTP))
	ts.Listener = ln
	ts.Start()
	defer ts.Close()

	tok := makeTestDrawingJWT("orrnn", 200010, time.Hour)
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http") + "/__rtx5_drawing_ws"

	stalledClient, _, err := websocket.DefaultDialer.Dial(wsBase+"?token="+tok+"&clientId=stalled-reader", nil)
	if err != nil {
		t.Fatalf("dial stalledClient: %v", err)
	}
	defer stalledClient.Close()
	_ = stalledClient.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, rerr := stalledClient.ReadMessage(); rerr != nil {
		t.Fatalf("stalledClient initial snapshot: %v", rerr)
	}

	var serverConn *stopReadPeerConn
	connTimer := time.NewTimer(3 * time.Second)
	select {
	case serverConn = <-ln.connReady:
		connTimer.Stop()
	case <-connTimer.C:
		t.Fatal("timed out waiting for server conn")
	}

	healthyClient, _, err := websocket.DefaultDialer.Dial(wsBase+"?token="+tok+"&clientId=healthy-reader", nil)
	if err != nil {
		t.Fatalf("dial healthyClient: %v", err)
	}
	defer healthyClient.Close()
	_ = healthyClient.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, rerr := healthyClient.ReadMessage(); rerr != nil {
		t.Fatalf("healthyClient initial snapshot: %v", rerr)
	}

	auth := drawingAuthContext{
		BrokerID:     "orrnn",
		AccountLogin: 200010,
		AccountKey:   normalizeDrawingAccountKey("orrnn", 200010),
		ClientID:     "broadcaster",
	}
	if got := hub.subscriberCount(auth.AccountKey); got != 2 {
		t.Fatalf("initial subscriberCount = %d, want 2", got)
	}

	// Simulate peer stopping reads while keeping the read loop alive by sending pings.
	ln.blockFirst.Store(true)
	stopPinger := make(chan struct{})
	var stopPingerOnce sync.Once
	stopPingerFn := func() { stopPingerOnce.Do(func() { close(stopPinger) }) }
	pingerDone := make(chan struct{})
	defer func() {
		stopPingerFn()
		<-pingerDone
	}()
	go func() {
		defer close(pingerDone)
		ticker := time.NewTicker(15 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopPinger:
				return
			case <-ticker.C:
				_ = stalledClient.SetWriteDeadline(time.Now().Add(time.Second))
				if werr := stalledClient.WriteJSON(map[string]any{"action": "ping"}); werr != nil {
					return
				}
			}
		}
	}()

	if _, _, uerr := hub.upsertDrawing(auth, "d-stall-trigger", "hline", "EURUSD", "M1", json.RawMessage(`{}`)); uerr != nil {
		t.Fatalf("upsert d-stall-trigger: %v", uerr)
	}

	// Write pump must time out, close sub & conn in defer, unblock ReadMessage, and unregister sub.
	closeTimer := time.NewTimer(3 * time.Second)
	select {
	case <-serverConn.closed:
		closeTimer.Stop()
	case <-closeTimer.C:
		t.Fatal("server did not close stalled-reader connection after WriteMessage error")
	}

	// Wait for the read loop to exit and unregister the dead subscriber while healthy broadcasts still work.
	unregDeadline := time.NewTimer(3 * time.Second)
	defer unregDeadline.Stop()
	pollTicker := time.NewTicker(10 * time.Millisecond)
	defer pollTicker.Stop()
	for hub.subscriberCount(auth.AccountKey) != 1 {
		select {
		case <-unregDeadline.C:
			t.Fatalf("stalled subscriber not unregistered in time; subscriberCount=%d", hub.subscriberCount(auth.AccountKey))
		case <-pollTicker.C:
		}
	}

	stopPingerFn()
	<-pingerDone

	// Stalled client must observe a closed connection instead of hanging open.
	_ = stalledClient.SetReadDeadline(time.Now().Add(time.Second))
	_, _, rerr := stalledClient.ReadMessage()
	if rerr == nil {
		t.Fatal("expected stalledClient ReadMessage to fail after server closed conn")
	}
	var netErr net.Error
	if errors.As(rerr, &netErr) && netErr.Timeout() {
		t.Fatalf("stalledClient ReadMessage timed out instead of seeing closed conn: %v", rerr)
	}

	// Healthy subscriber continues receiving subsequent upserts without panic or stall.
	if _, _, uerr := hub.upsertDrawing(auth, "d-after-stall", "trendline", "EURUSD", "M1", json.RawMessage(`{}`)); uerr != nil {
		t.Fatalf("upsert d-after-stall: %v", uerr)
	}
	gotIDs := make(map[string]bool)
	for i := 0; i < 2; i++ {
		_ = healthyClient.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, raw, rerr := healthyClient.ReadMessage()
		if rerr != nil {
			t.Fatalf("healthyClient read %d: %v", i, rerr)
		}
		var msg struct {
			Type    string         `json:"type"`
			Drawing *SyncedDrawing `json:"drawing"`
		}
		if json.Unmarshal(raw, &msg) == nil && msg.Drawing != nil {
			gotIDs[msg.Drawing.ID] = true
		}
	}
	if !gotIDs["d-stall-trigger"] || !gotIDs["d-after-stall"] {
		t.Fatalf("healthyClient missed broadcasts: %+v", gotIDs)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := hub.waitForPersisted(ctx, "orrnn", 200010); err != nil {
		t.Fatalf("waitForPersisted failed: %v", err)
	}
	assertNoTempDrawingFiles(t, filepath.Join(storageDir, "orrnn"))
}
