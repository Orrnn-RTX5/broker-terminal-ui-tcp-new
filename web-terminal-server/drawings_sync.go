package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxDrawingBodyBytes      = 4 * 1024 * 1024 // 4 MiB per drawing mutation
	drawingWSPingInterval    = 30 * time.Second
	drawingWSPongWait        = 65 * time.Second
	drawingWSWriteWait       = 10 * time.Second
	drawingWSAuthWait        = 5 * time.Second
	drawingWSSendQueueCap    = 256
	drawingTokenCacheMaxTTL  = 10 * time.Minute
)

var drawingSafeSegmentRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

var drawingSyncWSUpgrader = websocket.Upgrader{
	ReadBufferSize:    16 * 1024,
	WriteBufferSize:   64 * 1024,
	EnableCompression: false,
	CheckOrigin:       isAllowedWebTerminalOrigin,
}

type SyncedDrawing struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	Symbol     string          `json:"symbol"`
	Timeframe  string          `json:"timeframe,omitempty"`
	UserID     string          `json:"userId"`
	Properties json.RawMessage `json:"properties"`
	CreatedAt  string          `json:"createdAt"`
	UpdatedAt  string          `json:"updatedAt"`
}

type AccountDrawingsDocument struct {
	BrokerID       string                    `json:"brokerId"`
	AccountLogin   int64                     `json:"accountLogin"`
	Revision       int64                     `json:"revision"`
	Drawings       map[string]*SyncedDrawing `json:"drawings"`
	DrawingsHidden map[string]bool           `json:"drawingsHidden"`
	UpdatedAt      string                    `json:"updatedAt"`
}

type drawingTokenClaims struct {
	BrokerID     string
	AccountLogin int64
	ExpiresAt    int64
}

type drawingAuthContext struct {
	BrokerID     string
	AccountLogin int64
	AccountKey   string
	ClientID     string
}

type drawingWSSub struct {
	accountKey string
	clientID   string
	sendCh     chan []byte
	done       chan struct{}
	closeOnce  sync.Once
}

func newDrawingWSSub(accountKey, clientID string) *drawingWSSub {
	return &drawingWSSub{
		accountKey: accountKey,
		clientID:   clientID,
		sendCh:     make(chan []byte, drawingWSSendQueueCap),
		done:       make(chan struct{}),
	}
}

func (s *drawingWSSub) close() {
	s.closeOnce.Do(func() {
		close(s.done)
	})
}

func (s *drawingWSSub) enqueue(payload []byte) {
	select {
	case <-s.done:
		return
	default:
	}
	select {
	case <-s.done:
	case s.sendCh <- payload:
	default:
	}
}

func (s *drawingWSSub) enqueueDropOldest(payload []byte) {
	select {
	case <-s.done:
		return
	default:
	}
	select {
	case <-s.done:
		return
	case s.sendCh <- payload:
	default:
		// Slow consumer: drop oldest queued message so real-time state stays fresh
		// without blocking the other 99+ subscribers on the same account.
		select {
		case <-s.done:
			return
		case <-s.sendCh:
		default:
		}
		select {
		case <-s.done:
		case s.sendCh <- payload:
		default:
		}
	}
}

type verifiedTokenEntry struct {
	claims    drawingTokenClaims
	expiresAt time.Time
}

type drawingTokenVerifier func(ctx context.Context, link *brokerLink, token string, claims drawingTokenClaims) error

type accountPersistState struct {
	mu           sync.Mutex
	notifyCh     chan struct{}
	writing      bool
	hasSeen      bool
	highestSeen  int64
	hasPersisted bool
	persistedRev int64
	hasFailed    bool
	failedRev    int64
	lastErr      error
	pending      *AccountDrawingsDocument
}

func (s *accountPersistState) signalLocked() {
	if s.notifyCh != nil {
		close(s.notifyCh)
		s.notifyCh = nil
	}
}

func (s *accountPersistState) waitChLocked() <-chan struct{} {
	if s.notifyCh == nil {
		s.notifyCh = make(chan struct{})
	}
	return s.notifyCh
}

type drawingSyncHub struct {
	storageDir string

	mu       sync.RWMutex
	accounts map[string]*AccountDrawingsDocument
	subs     map[string]map[*drawingWSSub]struct{}

	persistMu        sync.Mutex
	persistState     map[string]*accountPersistState
	persistWriteHook func(AccountDrawingsDocument)
	renameSnapshotFn func(string, string) error
	wsWriteWait      time.Duration

	tokenMu        sync.RWMutex
	verifiedTokens map[[32]byte]verifiedTokenEntry

	verifyTokenFn drawingTokenVerifier
}

func (h *drawingSyncHub) effectiveWSWriteWait() time.Duration {
	if h != nil && h.wsWriteWait > 0 {
		return h.wsWriteWait
	}
	return drawingWSWriteWait
}

func newDrawingSyncHub(storageDir string) *drawingSyncHub {
	return &drawingSyncHub{
		storageDir:     strings.TrimSpace(storageDir),
		accounts:       make(map[string]*AccountDrawingsDocument),
		subs:           make(map[string]map[*drawingWSSub]struct{}),
		persistState:   make(map[string]*accountPersistState),
		verifiedTokens: make(map[[32]byte]verifiedTokenEntry),
	}
}

func (c *WebTerminalServer) ensureDrawingHub() *drawingSyncHub {
	c.drawingHubOnce.Do(func() {
		storageDir := ""
		if strings.TrimSpace(c.exeDir) != "" {
			storageDir = filepath.Join(c.exeDir, "..", "runtime-data", "drawings")
		}
		hub := newDrawingSyncHub(storageDir)
		hub.verifyTokenFn = c.verifyDrawingTokenUpstream
		c.drawingHub = hub
	})
	return c.drawingHub
}

func normalizeDrawingAccountKey(brokerID string, accountLogin int64) string {
	return safeStorageSegment(brokerID) + "::" + strconv.FormatInt(accountLogin, 10)
}

func normalizeDrawingSymbol(symbol string) string {
	return strings.ToUpper(strings.TrimSpace(symbol))
}

func normalizeDrawingTimeframe(timeframe string) string {
	return strings.ToUpper(strings.TrimSpace(timeframe))
}

func normalizeVisibilityKey(symbol, timeframe string) string {
	sym := normalizeDrawingSymbol(symbol)
	tf := normalizeDrawingTimeframe(timeframe)
	if sym == "" {
		return "*"
	}
	if tf == "" {
		return sym + "::*"
	}
	return sym + "::" + tf
}

func safeStorageSegment(raw string) string {
	cleaned := drawingSafeSegmentRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(raw)), "_")
	cleaned = strings.Trim(cleaned, "._-")
	if cleaned == "" {
		return "default"
	}
	return cleaned
}

func (h *drawingSyncHub) accountFilePath(brokerID string, accountLogin int64) string {
	if h.storageDir == "" {
		return ""
	}
	brokerSeg := safeStorageSegment(brokerID)
	fileName := fmt.Sprintf("%d.json", accountLogin)
	base := filepath.Clean(h.storageDir)
	full := filepath.Join(base, brokerSeg, fileName)
	rel, err := filepath.Rel(base, full)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return ""
	}
	return full
}

func (h *drawingSyncHub) getOrLoadLocked(brokerID string, accountLogin int64) *AccountDrawingsDocument {
	key := normalizeDrawingAccountKey(brokerID, accountLogin)
	if doc, ok := h.accounts[key]; ok && doc != nil {
		return doc
	}
	doc := &AccountDrawingsDocument{
		BrokerID:       strings.ToLower(strings.TrimSpace(brokerID)),
		AccountLogin:   accountLogin,
		Revision:       0,
		Drawings:       make(map[string]*SyncedDrawing),
		DrawingsHidden: make(map[string]bool),
		UpdatedAt:      time.Now().UTC().Format(time.RFC3339Nano),
	}
	if fp := h.accountFilePath(brokerID, accountLogin); fp != "" {
		if raw, err := os.ReadFile(fp); err == nil && len(raw) > 0 {
			var loaded AccountDrawingsDocument
			if json.Unmarshal(raw, &loaded) == nil {
				if loaded.Drawings == nil {
					loaded.Drawings = make(map[string]*SyncedDrawing)
				}
				if loaded.DrawingsHidden == nil {
					loaded.DrawingsHidden = make(map[string]bool)
				}
				loaded.BrokerID = doc.BrokerID
				loaded.AccountLogin = accountLogin
				if loaded.Revision < 0 {
					loaded.Revision = 0
				}
				doc = &loaded
				h.seedPersistStateFromLoaded(brokerID, accountLogin, doc.Revision)
			}
		}
	}
	h.accounts[key] = doc
	return doc
}

func (h *drawingSyncHub) seedPersistStateFromLoaded(brokerID string, accountLogin int64, rev int64) {
	if h.accountFilePath(brokerID, accountLogin) == "" {
		return
	}
	key := normalizeDrawingAccountKey(brokerID, accountLogin)
	st := h.getOrCreatePersistState(key)
	st.mu.Lock()
	if !st.hasSeen || rev > st.highestSeen {
		st.highestSeen = rev
		st.hasSeen = true
	}
	if !st.hasPersisted || rev > st.persistedRev {
		st.persistedRev = rev
		st.hasPersisted = true
	}
	st.mu.Unlock()
}

func cloneAccountDocumentLocked(doc *AccountDrawingsDocument) AccountDrawingsDocument {
	copyDoc := AccountDrawingsDocument{
		BrokerID:       doc.BrokerID,
		AccountLogin:   doc.AccountLogin,
		Revision:       doc.Revision,
		Drawings:       make(map[string]*SyncedDrawing, len(doc.Drawings)),
		DrawingsHidden: make(map[string]bool, len(doc.DrawingsHidden)),
		UpdatedAt:      doc.UpdatedAt,
	}
	for id, d := range doc.Drawings {
		if d == nil {
			continue
		}
		cp := *d
		if len(d.Properties) > 0 {
			cp.Properties = append(json.RawMessage(nil), d.Properties...)
		}
		copyDoc.Drawings[id] = &cp
	}
	for k, v := range doc.DrawingsHidden {
		copyDoc.DrawingsHidden[k] = v
	}
	return copyDoc
}

func (h *drawingSyncHub) setPersistHooks(writeHook func(AccountDrawingsDocument), renameFn func(string, string) error) {
	h.persistMu.Lock()
	h.persistWriteHook = writeHook
	h.renameSnapshotFn = renameFn
	h.persistMu.Unlock()
}

func (h *drawingSyncHub) getPersistHooks() (func(AccountDrawingsDocument), func(string, string) error) {
	h.persistMu.Lock()
	writeHook := h.persistWriteHook
	renameFn := h.renameSnapshotFn
	h.persistMu.Unlock()
	return writeHook, renameFn
}

func (h *drawingSyncHub) getOrCreatePersistState(key string) *accountPersistState {
	h.persistMu.Lock()
	if h.persistState == nil {
		h.persistState = make(map[string]*accountPersistState)
	}
	st := h.persistState[key]
	if st == nil {
		st = &accountPersistState{}
		h.persistState[key] = st
	}
	h.persistMu.Unlock()
	return st
}

// enqueuePersist schedules an account snapshot for ordered single-writer persistence off
// the request/WebSocket path. Older revisions are discarded so they can never overwrite newer ones.
func (h *drawingSyncHub) enqueuePersist(doc AccountDrawingsDocument) {
	if h.accountFilePath(doc.BrokerID, doc.AccountLogin) == "" {
		return
	}
	key := normalizeDrawingAccountKey(doc.BrokerID, doc.AccountLogin)
	st := h.getOrCreatePersistState(key)

	st.mu.Lock()
	if st.hasSeen {
		if doc.Revision < st.highestSeen {
			st.mu.Unlock()
			return
		}
		if doc.Revision == st.highestSeen {
			// Permit an explicit retry only when this latest revision failed and no write is active or queued.
			if !st.hasFailed || st.failedRev != doc.Revision || st.writing || st.pending != nil {
				st.mu.Unlock()
				return
			}
			st.lastErr = nil
			st.failedRev = 0
			st.hasFailed = false
		}
	}
	st.hasSeen = true
	st.highestSeen = doc.Revision
	cp := doc
	st.pending = &cp
	startWorker := !st.writing
	if startWorker {
		st.writing = true
	}
	st.signalLocked()
	st.mu.Unlock()

	if startWorker {
		go h.runAccountPersistLoop(key, st)
	}
}

func (h *drawingSyncHub) runAccountPersistLoop(key string, st *accountPersistState) {
	for {
		st.mu.Lock()
		next := st.pending
		if next == nil {
			st.writing = false
			st.signalLocked()
			st.mu.Unlock()
			return
		}
		st.pending = nil
		st.mu.Unlock()

		writeHook, _ := h.getPersistHooks()
		if writeHook != nil {
			writeHook(*next)
		}

		err := h.writeDocumentSnapshotToDisk(*next)

		st.mu.Lock()
		if err != nil {
			log.Printf("[drawing-sync] persist snapshot failed (account=%s rev=%d): %v", key, next.Revision, err)
			// Retain failure metadata for the newest snapshot unless a newer revision has already arrived.
			if st.pending == nil {
				st.lastErr = err
				st.failedRev = next.Revision
				st.hasFailed = true
			}
		} else {
			if !st.hasPersisted || next.Revision > st.persistedRev {
				st.persistedRev = next.Revision
				st.hasPersisted = true
			}
			if !st.hasFailed || next.Revision >= st.failedRev {
				st.lastErr = nil
				st.failedRev = 0
				st.hasFailed = false
			}
		}
		if st.pending == nil {
			st.writing = false
			st.signalLocked()
			st.mu.Unlock()
			return
		}
		st.signalLocked()
		st.mu.Unlock()
	}
}

func isRetryablePersistErr(err error) bool {
	if err == nil {
		return false
	}
	if runtime.GOOS == "windows" {
		if errors.Is(err, os.ErrPermission) {
			return true
		}
		const (
			winErrAccessDenied     syscall.Errno = 5
			winErrSharingViolation syscall.Errno = 32
			winErrLockViolation    syscall.Errno = 33
		)
		var errno syscall.Errno
		if errors.As(err, &errno) {
			switch errno {
			case winErrAccessDenied, winErrSharingViolation, winErrLockViolation:
				return true
			}
		}
		return false
	}
	return errors.Is(err, syscall.EINTR) || errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EBUSY)
}

func (h *drawingSyncHub) writeDocumentSnapshotToDisk(doc AccountDrawingsDocument) error {
	fp := h.accountFilePath(doc.BrokerID, doc.AccountLogin)
	if fp == "" {
		return nil
	}
	data, err := json.Marshal(&doc)
	if err != nil {
		return fmt.Errorf("marshal drawing snapshot: %w", err)
	}
	dir := filepath.Dir(fp)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create drawing dir %s: %w", dir, err)
	}

	tmpFile, err := os.CreateTemp(dir, filepath.Base(fp)+".tmp.*")
	if err != nil {
		return fmt.Errorf("create temp drawing snapshot: %w", err)
	}
	tmpPath := tmpFile.Name()
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		return fmt.Errorf("write temp drawing snapshot: %w", err)
	}
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		return fmt.Errorf("sync temp drawing snapshot: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return fmt.Errorf("close temp drawing snapshot: %w", err)
	}

	_, renameFn := h.getPersistHooks()
	backoffs := []time.Duration{
		2 * time.Millisecond,
		5 * time.Millisecond,
		10 * time.Millisecond,
		20 * time.Millisecond,
		35 * time.Millisecond,
		50 * time.Millisecond,
		75 * time.Millisecond,
		100 * time.Millisecond,
	}
	var renameErr error
	for attempt := 0; attempt <= len(backoffs); attempt++ {
		if renameFn != nil {
			renameErr = renameFn(tmpPath, fp)
		} else {
			renameErr = os.Rename(tmpPath, fp)
		}
		if renameErr == nil {
			cleanupTmp = false
			return nil
		}
		if attempt == len(backoffs) || !isRetryablePersistErr(renameErr) {
			break
		}
		time.Sleep(backoffs[attempt])
	}
	return fmt.Errorf("rename drawing snapshot to %s: %w", fp, renameErr)
}

func (h *drawingSyncHub) waitForPersisted(ctx context.Context, brokerID string, accountLogin int64) error {
	return h.waitForPersistState(ctx, brokerID, accountLogin, 0, true)
}

func (h *drawingSyncHub) waitForPersistedRevision(ctx context.Context, brokerID string, accountLogin int64, minRevision int64) error {
	return h.waitForPersistState(ctx, brokerID, accountLogin, minRevision, false)
}

func (h *drawingSyncHub) waitForPersistState(ctx context.Context, brokerID string, accountLogin int64, minRevision int64, drainAll bool) error {
	if h.accountFilePath(brokerID, accountLogin) == "" {
		return nil
	}
	key := normalizeDrawingAccountKey(brokerID, accountLogin)
	st := h.getOrCreatePersistState(key)

	for {
		st.mu.Lock()
		if drainAll {
			if !st.writing && st.pending == nil {
				if !st.hasSeen {
					st.mu.Unlock()
					return nil
				}
				if st.lastErr != nil && st.hasFailed && st.failedRev >= st.highestSeen {
					err := st.lastErr
					st.mu.Unlock()
					return err
				}
				if st.hasPersisted && st.persistedRev >= st.highestSeen {
					st.mu.Unlock()
					return nil
				}
			}
		} else {
			if st.hasPersisted && st.persistedRev >= minRevision {
				st.mu.Unlock()
				return nil
			}
			if !st.writing && st.pending == nil && st.lastErr != nil && st.hasFailed && st.failedRev >= minRevision {
				err := st.lastErr
				st.mu.Unlock()
				return err
			}
		}
		ch := st.waitChLocked()
		st.mu.Unlock()

		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (h *drawingSyncHub) persistDocumentSnapshot(doc AccountDrawingsDocument) error {
	if h.accountFilePath(doc.BrokerID, doc.AccountLogin) == "" {
		return nil
	}
	h.enqueuePersist(doc)
	return h.waitForPersistedRevision(context.Background(), doc.BrokerID, doc.AccountLogin, doc.Revision)
}

func (h *drawingSyncHub) persistAndBroadcast(snap AccountDrawingsDocument, accountKey string, event any) {
	if accountKey == "" {
		accountKey = normalizeDrawingAccountKey(snap.BrokerID, snap.AccountLogin)
	}
	h.enqueuePersist(snap)
	h.broadcast(accountKey, event)
}

func sortedDrawingsSlice(drawings map[string]*SyncedDrawing, symbol, timeframe string) []*SyncedDrawing {
	sym := normalizeDrawingSymbol(symbol)
	tf := normalizeDrawingTimeframe(timeframe)
	out := make([]*SyncedDrawing, 0, len(drawings))
	for _, d := range drawings {
		if d == nil {
			continue
		}
		if sym != "" && !strings.EqualFold(d.Symbol, sym) {
			continue
		}
		if tf != "" && d.Timeframe != "" && !strings.EqualFold(d.Timeframe, tf) {
			continue
		}
		cp := *d
		if len(d.Properties) > 0 {
			cp.Properties = append(json.RawMessage(nil), d.Properties...)
		}
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func resolveHiddenForScope(hiddenMap map[string]bool, symbol, timeframe string) bool {
	if len(hiddenMap) == 0 {
		return false
	}
	sym := normalizeDrawingSymbol(symbol)
	tf := normalizeDrawingTimeframe(timeframe)
	if sym != "" && tf != "" {
		if hidden, ok := hiddenMap[sym+"::"+tf]; ok {
			return hidden
		}
	}
	if sym != "" {
		if hidden, ok := hiddenMap[sym+"::*"]; ok {
			return hidden
		}
	}
	if hidden, ok := hiddenMap["*"]; ok {
		return hidden
	}
	return false
}

func copyHiddenMap(src map[string]bool) map[string]bool {
	out := make(map[string]bool, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

func (h *drawingSyncHub) snapshotFor(brokerID string, accountLogin int64, symbol, timeframe string) (int64, []*SyncedDrawing, bool, map[string]bool) {
	h.mu.Lock()
	doc := h.getOrLoadLocked(brokerID, accountLogin)
	rev := doc.Revision
	list := sortedDrawingsSlice(doc.Drawings, symbol, timeframe)
	hidden := resolveHiddenForScope(doc.DrawingsHidden, symbol, timeframe)
	hiddenMap := copyHiddenMap(doc.DrawingsHidden)
	h.mu.Unlock()
	return rev, list, hidden, hiddenMap
}

func (h *drawingSyncHub) registerSub(sub *drawingWSSub) {
	h.mu.Lock()
	if h.subs[sub.accountKey] == nil {
		h.subs[sub.accountKey] = make(map[*drawingWSSub]struct{})
	}
	h.subs[sub.accountKey][sub] = struct{}{}
	h.mu.Unlock()
}

func (h *drawingSyncHub) unregisterSub(sub *drawingWSSub) {
	h.mu.Lock()
	if set := h.subs[sub.accountKey]; set != nil {
		delete(set, sub)
		if len(set) == 0 {
			delete(h.subs, sub.accountKey)
		}
	}
	h.mu.Unlock()
	sub.close()
}

func (h *drawingSyncHub) subscriberCount(accountKey string) int {
	h.mu.RLock()
	n := len(h.subs[accountKey])
	h.mu.RUnlock()
	return n
}

func (h *drawingSyncHub) broadcast(accountKey string, event any) {
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.mu.RLock()
	set := h.subs[accountKey]
	if len(set) == 0 {
		h.mu.RUnlock()
		return
	}
	targets := make([]*drawingWSSub, 0, len(set))
	for sub := range set {
		targets = append(targets, sub)
	}
	h.mu.RUnlock()

	for _, sub := range targets {
		sub.enqueueDropOldest(payload)
	}
}

func extractClientDrawingID(props json.RawMessage) string {
	if len(props) == 0 {
		return ""
	}
	var obj struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(props, &obj) == nil {
		return strings.TrimSpace(obj.ID)
	}
	return ""
}

func generateDrawingServerID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("drw-%d", time.Now().UnixNano())
	}
	return "drw-" + hex.EncodeToString(b[:])
}

func (h *drawingSyncHub) upsertDrawing(
	auth drawingAuthContext,
	explicitID string,
	drawingType string,
	symbol string,
	timeframe string,
	properties json.RawMessage,
) (*SyncedDrawing, int64, error) {
	sym := normalizeDrawingSymbol(symbol)
	if sym == "" {
		return nil, 0, errors.New("symbol is required")
	}
	dtype := strings.TrimSpace(drawingType)
	if dtype == "" {
		return nil, 0, errors.New("drawing type is required")
	}
	tf := normalizeDrawingTimeframe(timeframe)
	id := strings.TrimSpace(explicitID)
	if id == "" {
		id = extractClientDrawingID(properties)
	}
	if id == "" {
		id = generateDrawingServerID()
	}
	if len(properties) == 0 {
		properties = json.RawMessage(`{}`)
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	h.mu.Lock()
	doc := h.getOrLoadLocked(auth.BrokerID, auth.AccountLogin)
	createdAt := now
	if existing, ok := doc.Drawings[id]; ok && existing != nil && existing.CreatedAt != "" {
		createdAt = existing.CreatedAt
		if tf == "" {
			tf = existing.Timeframe
		}
	}
	saved := &SyncedDrawing{
		ID:         id,
		Type:       dtype,
		Symbol:     sym,
		Timeframe:  tf,
		UserID:     strconv.FormatInt(auth.AccountLogin, 10),
		Properties: append(json.RawMessage(nil), properties...),
		CreatedAt:  createdAt,
		UpdatedAt:  now,
	}
	doc.Drawings[id] = saved
	doc.Revision++
	doc.UpdatedAt = now
	rev := doc.Revision
	snap := cloneAccountDocumentLocked(doc)
	savedCopy := *saved
	savedCopy.Properties = append(json.RawMessage(nil), saved.Properties...)
	h.mu.Unlock()

	h.persistAndBroadcast(snap, auth.AccountKey, map[string]any{
		"type":           "drawing_upsert",
		"brokerId":       auth.BrokerID,
		"accountLogin":   auth.AccountLogin,
		"revision":       rev,
		"originClientId": auth.ClientID,
		"drawing":        &savedCopy,
	})
	return &savedCopy, rev, nil
}

func (h *drawingSyncHub) deleteDrawing(auth drawingAuthContext, targetID string) (bool, int64) {
	id := strings.TrimSpace(targetID)
	if id == "" {
		return false, 0
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	h.mu.Lock()
	doc := h.getOrLoadLocked(auth.BrokerID, auth.AccountLogin)
	removed, found := doc.Drawings[id]
	removedKey := id
	if !found {
		for k, candidate := range doc.Drawings {
			if candidate != nil && extractClientDrawingID(candidate.Properties) == id {
				removed = candidate
				removedKey = k
				found = true
				break
			}
		}
	}
	if !found {
		rev := doc.Revision
		h.mu.Unlock()
		return false, rev
	}
	delete(doc.Drawings, removedKey)
	doc.Revision++
	doc.UpdatedAt = now
	rev := doc.Revision
	snap := cloneAccountDocumentLocked(doc)
	h.mu.Unlock()

	clientDrawingID := extractClientDrawingID(removed.Properties)
	if clientDrawingID == "" {
		clientDrawingID = removed.ID
	}
	h.persistAndBroadcast(snap, auth.AccountKey, map[string]any{
		"type":            "drawing_delete",
		"brokerId":        auth.BrokerID,
		"accountLogin":    auth.AccountLogin,
		"revision":        rev,
		"originClientId":  auth.ClientID,
		"drawingId":       removed.ID,
		"clientDrawingId": clientDrawingID,
		"symbol":          removed.Symbol,
		"timeframe":       removed.Timeframe,
	})
	return true, rev
}

func (h *drawingSyncHub) clearDrawings(auth drawingAuthContext, symbol, timeframe string) (int, int64) {
	sym := normalizeDrawingSymbol(symbol)
	tf := normalizeDrawingTimeframe(timeframe)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	h.mu.Lock()
	doc := h.getOrLoadLocked(auth.BrokerID, auth.AccountLogin)
	deleted := 0
	for id, candidate := range doc.Drawings {
		if candidate == nil {
			delete(doc.Drawings, id)
			continue
		}
		if sym != "" && !strings.EqualFold(candidate.Symbol, sym) {
			continue
		}
		if tf != "" && candidate.Timeframe != "" && !strings.EqualFold(candidate.Timeframe, tf) {
			continue
		}
		delete(doc.Drawings, id)
		deleted++
	}
	doc.Revision++
	doc.UpdatedAt = now
	rev := doc.Revision
	snap := cloneAccountDocumentLocked(doc)
	h.mu.Unlock()

	h.persistAndBroadcast(snap, auth.AccountKey, map[string]any{
		"type":           "drawings_clear",
		"brokerId":       auth.BrokerID,
		"accountLogin":   auth.AccountLogin,
		"revision":       rev,
		"originClientId": auth.ClientID,
		"symbol":         sym,
		"timeframe":      tf,
	})
	return deleted, rev
}

func (h *drawingSyncHub) setVisibility(auth drawingAuthContext, symbol, timeframe string, hidden bool) (int64, map[string]bool) {
	sym := normalizeDrawingSymbol(symbol)
	tf := normalizeDrawingTimeframe(timeframe)
	visKey := normalizeVisibilityKey(sym, tf)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	h.mu.Lock()
	doc := h.getOrLoadLocked(auth.BrokerID, auth.AccountLogin)
	if doc.DrawingsHidden == nil {
		doc.DrawingsHidden = make(map[string]bool)
	}
	doc.DrawingsHidden[visKey] = hidden
	doc.DrawingsHidden["*"] = hidden
	doc.Revision++
	doc.UpdatedAt = now
	rev := doc.Revision
	hiddenMap := copyHiddenMap(doc.DrawingsHidden)
	snap := cloneAccountDocumentLocked(doc)
	h.mu.Unlock()

	h.persistAndBroadcast(snap, auth.AccountKey, map[string]any{
		"type":           "drawing_visibility",
		"brokerId":       auth.BrokerID,
		"accountLogin":   auth.AccountLogin,
		"revision":       rev,
		"originClientId": auth.ClientID,
		"symbol":         sym,
		"timeframe":      tf,
		"accountWide":    true,
		"drawingsHidden": hidden,
		"hiddenMap":      hiddenMap,
	})
	return rev, hiddenMap
}

func parseDrawingJWTClaims(token string) (drawingTokenClaims, error) {
	trimmed := strings.TrimSpace(token)
	parts := strings.Split(trimmed, ".")
	if len(parts) != 3 || parts[1] == "" {
		return drawingTokenClaims{}, errors.New("malformed bearer token")
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		payloadBytes, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return drawingTokenClaims{}, errors.New("invalid bearer token payload")
		}
	}
	var raw map[string]any
	if err := json.Unmarshal(payloadBytes, &raw); err != nil {
		return drawingTokenClaims{}, errors.New("invalid bearer token json")
	}

	readPositiveInt64 := func(keys ...string) int64 {
		for _, k := range keys {
			v, exists := raw[k]
			if !exists || v == nil {
				continue
			}
			switch val := v.(type) {
			case float64:
				if val > 0 {
					return int64(val)
				}
			case string:
				if parsed, perr := strconv.ParseInt(strings.TrimSpace(val), 10, 64); perr == nil && parsed > 0 {
					return parsed
				}
			}
		}
		return 0
	}

	login := readPositiveInt64("account_login", "accountLogin", "login", "username", "sub")
	if login <= 0 {
		return drawingTokenClaims{}, errors.New("token missing account_login")
	}
	exp := readPositiveInt64("exp")
	if exp > 0 && time.Now().Unix() >= exp {
		return drawingTokenClaims{}, errors.New("token expired")
	}
	brokerID := ""
	for _, k := range []string{"broker_id", "brokerId"} {
		if s, ok := raw[k].(string); ok && strings.TrimSpace(s) != "" {
			brokerID = strings.ToLower(strings.TrimSpace(s))
			break
		}
	}
	return drawingTokenClaims{
		BrokerID:     brokerID,
		AccountLogin: login,
		ExpiresAt:    exp,
	}, nil
}

type drawingMemResponseWriter struct {
	header http.Header
	status int
	buf    bytes.Buffer
}

func (m *drawingMemResponseWriter) Header() http.Header {
	if m.header == nil {
		m.header = make(http.Header)
	}
	return m.header
}

func (m *drawingMemResponseWriter) Write(p []byte) (int, error) {
	if m.status == 0 {
		m.status = http.StatusOK
	}
	return m.buf.Write(p)
}

func (m *drawingMemResponseWriter) WriteHeader(statusCode int) {
	if m.status == 0 {
		m.status = statusCode
	}
}

func (c *WebTerminalServer) verifyDrawingTokenUpstream(ctx context.Context, link *brokerLink, token string, claims drawingTokenClaims) error {
	if link == nil {
		return errors.New("no active broker link")
	}
	sess, err := link.getOrDialSession()
	if err != nil || sess == nil {
		return fmt.Errorf("broker session unavailable: %w", err)
	}
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	reqURL := fmt.Sprintf("http://127.0.0.1:18403/api/v2/account/%d", claims.AccountLogin)
	req, err := http.NewRequestWithContext(checkCtx, http.MethodGet, reqURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if canon := c.canonicalBrokerIDForLink(link); canon != "" {
		req.Header.Set("X-Broker-ID", canon)
	}
	rec := &drawingMemResponseWriter{}
	sess.ProxyHTTP(rec, req, "gateway")
	if rec.status == http.StatusUnauthorized || rec.status == http.StatusForbidden {
		return errors.New("token rejected by broker gateway")
	}
	if rec.status >= 200 && rec.status < 300 {
		return nil
	}
	return fmt.Errorf("token verification failed with status %d", rec.status)
}

func (h *drawingSyncHub) verifyToken(ctx context.Context, link *brokerLink, token string, claims drawingTokenClaims) error {
	sum := sha256.Sum256([]byte(token))
	now := time.Now()
	h.tokenMu.RLock()
	if entry, ok := h.verifiedTokens[sum]; ok && now.Before(entry.expiresAt) {
		h.tokenMu.RUnlock()
		return nil
	}
	h.tokenMu.RUnlock()

	if h.verifyTokenFn != nil {
		if err := h.verifyTokenFn(ctx, link, token, claims); err != nil {
			return err
		}
	}

	ttl := now.Add(drawingTokenCacheMaxTTL)
	if claims.ExpiresAt > 0 {
		expTime := time.Unix(claims.ExpiresAt, 0)
		if expTime.Before(ttl) {
			ttl = expTime
		}
	}
	h.tokenMu.Lock()
	if len(h.verifiedTokens) > 4096 {
		for k, v := range h.verifiedTokens {
			if now.After(v.expiresAt) {
				delete(h.verifiedTokens, k)
			}
		}
	}
	h.verifiedTokens[sum] = verifiedTokenEntry{claims: claims, expiresAt: ttl}
	h.tokenMu.Unlock()
	return nil
}

func extractBearerFromRequest(r *http.Request) string {
	if r == nil {
		return ""
	}
	authz := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(authz) > 7 && strings.EqualFold(authz[:7], "Bearer ") {
		return strings.TrimSpace(authz[7:])
	}
	if r.URL != nil {
		if tok := strings.TrimSpace(r.URL.Query().Get("token")); tok != "" {
			return tok
		}
	}
	return ""
}

func (c *WebTerminalServer) resolveDrawingAuth(r *http.Request, link *brokerLink, tokenOverride string) (drawingAuthContext, int, error) {
	token := strings.TrimSpace(tokenOverride)
	if token == "" {
		token = extractBearerFromRequest(r)
	}
	if token == "" {
		return drawingAuthContext{}, http.StatusUnauthorized, errors.New("authorization token required")
	}
	claims, err := parseDrawingJWTClaims(token)
	if err != nil {
		return drawingAuthContext{}, http.StatusUnauthorized, err
	}

	linkBrokerID := strings.ToLower(strings.TrimSpace(c.canonicalBrokerIDForLink(link)))
	if linkBrokerID == "" && link != nil {
		bid, _, _ := c.linkIdentity(link)
		linkBrokerID = strings.ToLower(strings.TrimSpace(bid))
	}
	brokerID := claims.BrokerID
	if brokerID == "" {
		brokerID = linkBrokerID
	}
	if brokerID == "" {
		brokerID = "default"
	}
	if claims.BrokerID != "" && linkBrokerID != "" && !strings.EqualFold(claims.BrokerID, linkBrokerID) {
		return drawingAuthContext{}, http.StatusForbidden, errors.New("token broker mismatch")
	}
	if r != nil {
		if hdrBroker := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Broker-ID"))); hdrBroker != "" && !strings.EqualFold(hdrBroker, brokerID) {
			return drawingAuthContext{}, http.StatusForbidden, errors.New("broker header mismatch")
		}
	}

	hub := c.ensureDrawingHub()
	ctx := context.Background()
	if r != nil {
		ctx = r.Context()
	}
	if err := hub.verifyToken(ctx, link, token, claims); err != nil {
		return drawingAuthContext{}, http.StatusUnauthorized, err
	}

	clientID := ""
	if r != nil {
		clientID = strings.TrimSpace(r.Header.Get("X-Client-ID"))
		if clientID == "" && r.URL != nil {
			clientID = strings.TrimSpace(r.URL.Query().Get("clientId"))
		}
	}
	return drawingAuthContext{
		BrokerID:     brokerID,
		AccountLogin: claims.AccountLogin,
		AccountKey:   normalizeDrawingAccountKey(brokerID, claims.AccountLogin),
		ClientID:     clientID,
	}, http.StatusOK, nil
}

func (c *WebTerminalServer) serveDrawingSyncHTTP(w http.ResponseWriter, r *http.Request, normPath string) {
	link := c.linkForRequest(r)
	auth, status, err := c.resolveDrawingAuth(r, link, "")
	if err != nil {
		writeJSON(w, status, map[string]any{"success": false, "error": err.Error()})
		return
	}

	hub := c.ensureDrawingHub()
	subPath := strings.TrimPrefix(normPath, "/api/fix/drawings")
	subPath = strings.TrimSuffix(subPath, "/")

	// Visibility endpoint: GET / PUT /api/fix/drawings/visibility
	if subPath == "/visibility" {
		switch r.Method {
		case http.MethodGet:
			sym := r.URL.Query().Get("symbol")
			tf := r.URL.Query().Get("timeframe")
			rev, _, hidden, hiddenMap := hub.snapshotFor(auth.BrokerID, auth.AccountLogin, sym, tf)
			writeJSON(w, http.StatusOK, map[string]any{
				"success":        true,
				"brokerId":       auth.BrokerID,
				"accountLogin":   auth.AccountLogin,
				"revision":       rev,
				"drawingsHidden": hidden,
				"hiddenMap":      hiddenMap,
			})
			return
		case http.MethodPut, http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
			var req struct {
				Symbol         string `json:"symbol"`
				Timeframe      string `json:"timeframe"`
				DrawingsHidden bool   `json:"drawingsHidden"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "invalid visibility payload"})
				return
			}
			rev, hiddenMap := hub.setVisibility(auth, req.Symbol, req.Timeframe, req.DrawingsHidden)
			writeJSON(w, http.StatusOK, map[string]any{
				"success":        true,
				"brokerId":       auth.BrokerID,
				"accountLogin":   auth.AccountLogin,
				"revision":       rev,
				"symbol":         normalizeDrawingSymbol(req.Symbol),
				"timeframe":      normalizeDrawingTimeframe(req.Timeframe),
				"drawingsHidden": req.DrawingsHidden,
				"hiddenMap":      hiddenMap,
			})
			return
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "method not allowed"})
			return
		}
	}

	// Collection endpoints: GET / POST / DELETE /api/fix/drawings
	if subPath == "" {
		switch r.Method {
		case http.MethodGet:
			sym := r.URL.Query().Get("symbol")
			tf := r.URL.Query().Get("timeframe")
			rev, list, hidden, hiddenMap := hub.snapshotFor(auth.BrokerID, auth.AccountLogin, sym, tf)
			writeJSON(w, http.StatusOK, map[string]any{
				"success":        true,
				"brokerId":       auth.BrokerID,
				"accountLogin":   auth.AccountLogin,
				"revision":       rev,
				"drawings":       list,
				"drawingsHidden": hidden,
				"hiddenMap":      hiddenMap,
			})
			return
		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, maxDrawingBodyBytes)
			var req struct {
				ID         string          `json:"id"`
				Type       string          `json:"type"`
				Symbol     string          `json:"symbol"`
				Timeframe  string          `json:"timeframe"`
				Properties json.RawMessage `json:"properties"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "invalid drawing payload"})
				return
			}
			saved, rev, uerr := hub.upsertDrawing(auth, req.ID, req.Type, req.Symbol, req.Timeframe, req.Properties)
			if uerr != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": uerr.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"success":   true,
				"drawingId": saved.ID,
				"message":   "Drawing saved",
				"revision":  rev,
				"drawing":   saved,
			})
			return
		case http.MethodDelete:
			sym := r.URL.Query().Get("symbol")
			tf := r.URL.Query().Get("timeframe")
			deleted, rev := hub.clearDrawings(auth, sym, tf)
			writeJSON(w, http.StatusOK, map[string]any{
				"success":      true,
				"deletedCount": deleted,
				"revision":     rev,
			})
			return
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "method not allowed"})
			return
		}
	}

	// Item endpoints: PUT / DELETE /api/fix/drawings/{id}
	rawID := strings.TrimPrefix(subPath, "/")
	if decoded, err := url.PathUnescape(rawID); err == nil && strings.TrimSpace(decoded) != "" {
		rawID = decoded
	}
	switch r.Method {
	case http.MethodPut:
		r.Body = http.MaxBytesReader(w, r.Body, maxDrawingBodyBytes)
		var req struct {
			Type       string          `json:"type"`
			Symbol     string          `json:"symbol"`
			Timeframe  string          `json:"timeframe"`
			Properties json.RawMessage `json:"properties"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "invalid drawing payload"})
			return
		}
		saved, rev, uerr := hub.upsertDrawing(auth, rawID, req.Type, req.Symbol, req.Timeframe, req.Properties)
		if uerr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": uerr.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"success":   true,
			"drawingId": saved.ID,
			"message":   "Drawing updated",
			"revision":  rev,
			"drawing":   saved,
		})
		return
	case http.MethodDelete:
		deleted, rev := hub.deleteDrawing(auth, rawID)
		writeJSON(w, http.StatusOK, map[string]any{
			"success":  true,
			"deleted":  deleted,
			"revision": rev,
		})
		return
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "method not allowed"})
		return
	}
}

func (c *WebTerminalServer) serveDrawingSyncWS(w http.ResponseWriter, r *http.Request) {
	link := c.linkForRequest(r)
	initialToken := extractBearerFromRequest(r)
	var auth drawingAuthContext
	hasAuth := false
	if initialToken != "" {
		resolved, status, err := c.resolveDrawingAuth(r, link, initialToken)
		if err != nil {
			writeJSON(w, status, map[string]any{"success": false, "error": err.Error()})
			return
		}
		auth = resolved
		hasAuth = true
	}

	conn, err := drawingSyncWSUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(maxDrawingBodyBytes)

	if !hasAuth {
		_ = conn.SetReadDeadline(time.Now().Add(drawingWSAuthWait))
		_, raw, rerr := conn.ReadMessage()
		if rerr != nil {
			return
		}
		var authMsg struct {
			Action   string `json:"action"`
			Token    string `json:"token"`
			ClientID string `json:"clientId"`
		}
		if json.Unmarshal(raw, &authMsg) != nil || strings.TrimSpace(authMsg.Token) == "" {
			_ = conn.WriteJSON(map[string]any{"type": "error", "error": "authentication required"})
			return
		}
		resolved, _, aerr := c.resolveDrawingAuth(r, link, authMsg.Token)
		if aerr != nil {
			_ = conn.WriteJSON(map[string]any{"type": "error", "error": aerr.Error()})
			return
		}
		if strings.TrimSpace(authMsg.ClientID) != "" {
			resolved.ClientID = strings.TrimSpace(authMsg.ClientID)
		}
		auth = resolved
	}

	hub := c.ensureDrawingHub()
	sub := newDrawingWSSub(auth.AccountKey, auth.ClientID)
	hub.registerSub(sub)
	defer hub.unregisterSub(sub)

	sendSnapshot := func() {
		rev, list, _, hiddenMap := hub.snapshotFor(auth.BrokerID, auth.AccountLogin, "", "")
		payload, merr := json.Marshal(map[string]any{
			"type":         "drawing_snapshot",
			"brokerId":     auth.BrokerID,
			"accountLogin": auth.AccountLogin,
			"revision":     rev,
			"drawings":     list,
			"hiddenMap":    hiddenMap,
		})
		if merr != nil {
			return
		}
		sub.enqueue(payload)
	}

	// Enqueue immediate full snapshot so newly joined devices hydrate instantaneously.
	sendSnapshot()

	writeWait := hub.effectiveWSWriteWait()

	// Dedicated write pump so broadcasts never contend on socket writes.
	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		defer func() {
			sub.close()
			_ = conn.Close()
		}()
		ticker := time.NewTicker(drawingWSPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-sub.done:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				_ = conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			default:
			}
			select {
			case <-sub.done:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				_ = conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			case msg := <-sub.sendCh:
				select {
				case <-sub.done:
					_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
					_ = conn.WriteMessage(websocket.CloseMessage, []byte{})
					return
				default:
				}
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if werr := conn.WriteMessage(websocket.TextMessage, msg); werr != nil {
					return
				}
			case <-ticker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if perr := conn.WriteMessage(websocket.PingMessage, nil); perr != nil {
					return
				}
			}
		}
	}()

	_ = conn.SetReadDeadline(time.Now().Add(drawingWSPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(drawingWSPongWait))
	})

	for {
		_, raw, rerr := conn.ReadMessage()
		if rerr != nil {
			if !errors.Is(rerr, io.EOF) {
				// Normal close or timeout exits the read loop cleanly.
			}
			break
		}
		_ = conn.SetReadDeadline(time.Now().Add(drawingWSPongWait))
		var msg struct {
			Action string `json:"action"`
		}
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(msg.Action)) {
		case "ping":
			if pongBytes, merr := json.Marshal(map[string]any{"type": "pong", "ts": time.Now().UnixMilli()}); merr == nil {
				sub.enqueue(pongBytes)
			}
		case "sync", "snapshot":
			sendSnapshot()
		}
	}

	sub.close()
	<-writeDone
}
