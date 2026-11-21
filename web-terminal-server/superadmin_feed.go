package main

import (
	"context"
	"crypto/sha256"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

// Super Admin live market feed.
//
// A Super Admin page served by this web suite must show the Super Admin hub's (:9100) full symbol list, not the
// broker guest feed. The :9100 mux session feeds its own webBinaryMarketHub (superAdminHub), and a
// /__rtx5_binary_stream tab of app kind "superadmin" attaches to that hub. Because that stream is unfiltered it is
// served only to a caller holding a valid Super Admin bearer token (checked against the control plane).
//
// Session lifecycle: every :9100 dial starts a new "epoch" (cache cleared). When the session ends, its epoch is
// cancelled and every attached tab is closed, so a tab never keeps showing the last prices as if live; the browser
// reconnects and gets the new session's snapshot. One shared, ref-counted redialer keeps the session up while any
// tab is open.
//
// Broker terminals never touch any of this: their stream path is the unchanged brokerLink.attachSub.

const (
	saTokenOKTTL             = 30 * time.Second
	saTokenBadTTL            = 3 * time.Second
	saTokenCacheMax          = 256
	saTokenVerifyWaitDefault = 6 * time.Second
	saVerifyMaxConc          = 8                       // concurrent control-plane verifications; the rest get 503
	saAuthCheckPath          = "/api/v1/admin/auth/me" // control plane: 200 only for a valid admin token
	saStreamRedialGap        = 5 * time.Second
	saStreamDialWait         = 10 * time.Second
)

// saTokenVerifyWait bounds one control-plane verification (a var so tests can shorten it).
var saTokenVerifyWait = saTokenVerifyWaitDefault

// saVerdict is the outcome of checking a token. saUnavailable (hub down, timeout, 5xx, 429, overload) is never
// cached and is answered with 503, so a transient fault is not mistaken for a bad token.
type saVerdict int

const (
	saUnavailable saVerdict = iota
	saInvalid
	saValid
)

type saTokenEntry struct {
	ok      bool
	expires time.Time
}

type saFlight struct {
	done chan struct{}
	v    saVerdict
}

// superAdminFeed holds the Super Admin hub, its session epoch, the redialer and the token verification state.
type superAdminFeed struct {
	hubOnce sync.Once
	hub     *webBinaryMarketHub

	epMu     sync.Mutex
	epCtx    context.Context
	epCancel context.CancelFunc
	cur      *rtx5tcp.MuxSession // the session that feeds hub

	rdMu       sync.Mutex
	rdTabs     int
	rdStop     context.CancelFunc
	rdGap      time.Duration // 0 = saStreamRedialGap
	rdStarts   atomic.Int32  // redialer goroutines started (tests)
	rdRunning  atomic.Int32  // redialer goroutines alive (tests)
	rdEnsureOK atomic.Int32  // redial attempts (tests)

	tokMu    sync.Mutex
	tokCache map[[32]byte]saTokenEntry // keyed by SHA-256 of the token: the token itself is never stored
	flights  map[[32]byte]*saFlight
	sem      chan struct{}

	// statusFn overrides the control-plane request (tests only): the HTTP status of GET saAuthCheckPath.
	statusFn func(ctx context.Context, token string) (int, error)
	// ensureFn overrides the :9100 dial of the stream handler and redialer (tests only).
	ensureFn func() error
}

func (c *WebTerminalServer) superAdminHub() *webBinaryMarketHub {
	c.saFeed.hubOnce.Do(func() { c.saFeed.hub = newWebBinaryMarketHub() })
	return c.saFeed.hub
}

// superAdminControlFrame is the :9100 session's control handler (runs on the mux read loop).
func (c *WebTerminalServer) superAdminControlFrame(_ *rtx5tcp.MuxSession, frameType uint8, _ uint32, _ uint8, payload []byte) {
	c.superAdminHub().handleControlFrame(frameType, payload)
}

// ---- session epoch --------------------------------------------------------------------------------------------

// beginSession starts a new epoch for session s: the hub cache is cleared and the previous epoch (if any) ends.
func (f *superAdminFeed) beginSession(h *webBinaryMarketHub, s *rtx5tcp.MuxSession) {
	h.clearMarketCache()
	f.epMu.Lock()
	if f.epCancel != nil {
		f.epCancel()
	}
	f.epCtx, f.epCancel = context.WithCancel(context.Background())
	f.cur = s
	f.epMu.Unlock()
}

// endSession ends the epoch when s (the current feeding session) is gone: attached tabs are closed.
func (f *superAdminFeed) endSession(s *rtx5tcp.MuxSession) {
	f.epMu.Lock()
	if f.cur == s && f.epCancel != nil {
		f.epCancel()
	}
	f.epMu.Unlock()
}

func (f *superAdminFeed) isFeedSession(s *rtx5tcp.MuxSession) bool {
	f.epMu.Lock()
	ok := f.cur == s
	f.epMu.Unlock()
	return ok
}

func (f *superAdminFeed) epoch() context.Context {
	f.epMu.Lock()
	if f.epCtx == nil {
		f.epCtx, f.epCancel = context.WithCancel(context.Background())
	}
	ctx := f.epCtx
	f.epMu.Unlock()
	return ctx
}

// superAdminTabContext returns a context that ends with the request or with the current session epoch.
func (c *WebTerminalServer) superAdminTabContext(parent context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(c.saFeed.epoch(), cancel)
	return ctx, func() { stop(); cancel() }
}

// ---- hub attach -----------------------------------------------------------------------------------------------

// attachDirect registers a tab on this hub and returns its latest snapshot (same contract as brokerLink.attachSub).
func (h *webBinaryMarketHub) attachDirect(s *webBinaryStreamSub) ([]rtx5tcp.BinaryTick, []rtx5tcp.BinaryDepth) {
	h.mu.Lock()
	sn := h.copySnapshotLocked()
	h.subs[s] = struct{}{}
	s.src.Store(h)
	h.mu.Unlock()
	return sn.ticks, sn.depths
}

func (h *webBinaryMarketHub) detachDirect(s *webBinaryStreamSub) {
	s.closed.Store(true)
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

// ---- :9100 session upkeep -------------------------------------------------------------------------------------

// ensureSuperAdminSession makes sure the feeding :9100 session is up (dialling it when needed).
func (c *WebTerminalServer) ensureSuperAdminSession(ctx context.Context) error {
	if c.saFeed.ensureFn != nil {
		return c.saFeed.ensureFn()
	}
	_, err := c.getOrDialSuperAdminSession(ctx, true)
	return err
}

// acquireSuperAdminRedialer registers one open Super Admin tab with the shared redialer (started by the first
// tab, stopped by the last) and returns the release func (safe to call more than once).
func (c *WebTerminalServer) acquireSuperAdminRedialer() func() {
	f := &c.saFeed
	f.rdMu.Lock()
	f.rdTabs++
	if f.rdTabs == 1 {
		ctx, cancel := context.WithCancel(context.Background())
		f.rdStop = cancel
		f.rdStarts.Add(1)
		f.rdRunning.Add(1)
		go c.superAdminRedialLoop(ctx)
	}
	f.rdMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			f.rdMu.Lock()
			f.rdTabs--
			if f.rdTabs == 0 && f.rdStop != nil {
				f.rdStop()
				f.rdStop = nil
			}
			f.rdMu.Unlock()
		})
	}
}

func (c *WebTerminalServer) superAdminRedialLoop(ctx context.Context) {
	f := &c.saFeed
	defer f.rdRunning.Add(-1)
	gap := f.rdGap
	if gap <= 0 {
		gap = saStreamRedialGap
	}
	t := time.NewTicker(gap)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f.rdEnsureOK.Add(1)
			dctx, cancel := context.WithTimeout(ctx, saStreamDialWait)
			_ = c.ensureSuperAdminSession(dctx)
			cancel()
		}
	}
}

// ---- token verification ---------------------------------------------------------------------------------------

// bearerToken returns the token of an "Authorization: Bearer <token>" header, or "".
func bearerToken(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

// superAdminVerdict checks the request's Super Admin token. No token is saInvalid; a fault while checking is
// saUnavailable (fail closed, but answered 503 and never cached). The token is never logged or stored.
func (c *WebTerminalServer) superAdminVerdict(r *http.Request) saVerdict {
	tok := bearerToken(r)
	if tok == "" || len(tok) > 4096 {
		return saInvalid
	}
	key := sha256.Sum256([]byte(tok))
	f := &c.saFeed

	f.tokMu.Lock()
	now := time.Now()
	if e, ok := f.tokCache[key]; ok && now.Before(e.expires) {
		f.tokMu.Unlock()
		if e.ok {
			return saValid
		}
		return saInvalid
	}
	if fl := f.flights[key]; fl != nil { // identical verification already running: share its answer
		f.tokMu.Unlock()
		select {
		case <-fl.done:
			return fl.v
		case <-r.Context().Done():
			return saUnavailable
		}
	}
	if f.sem == nil {
		f.sem = make(chan struct{}, saVerifyMaxConc)
	}
	select {
	case f.sem <- struct{}{}:
	default:
		f.tokMu.Unlock()
		return saUnavailable // too many different verifications in flight
	}
	fl := &saFlight{done: make(chan struct{})}
	if f.flights == nil {
		f.flights = make(map[[32]byte]*saFlight)
	}
	f.flights[key] = fl
	f.tokMu.Unlock()

	// The check does not depend on the leader's request: followers share its result.
	ctx, cancel := context.WithTimeout(context.Background(), saTokenVerifyWait)
	var status int
	var err error
	if f.statusFn != nil {
		status, err = f.statusFn(ctx, tok)
	} else {
		status, err = c.superAdminAuthStatus(ctx, tok)
	}
	cancel()
	v := classifyAuthStatus(status, err)

	f.tokMu.Lock()
	switch v {
	case saValid:
		f.cachePutLocked(key, saTokenEntry{ok: true, expires: time.Now().Add(saTokenOKTTL)})
	case saInvalid:
		f.cachePutLocked(key, saTokenEntry{ok: false, expires: time.Now().Add(saTokenBadTTL)})
	}
	delete(f.flights, key)
	f.tokMu.Unlock()
	fl.v = v
	close(fl.done)
	<-f.sem
	return v
}

// classifyAuthStatus: the control plane answering 200 is valid, 401/403 invalid; anything else (no answer,
// timeout, 5xx, 429, 404 ...) means the token could not be verified.
func classifyAuthStatus(status int, err error) saVerdict {
	if err != nil {
		return saUnavailable
	}
	switch status {
	case http.StatusOK:
		return saValid
	case http.StatusUnauthorized, http.StatusForbidden:
		return saInvalid
	}
	return saUnavailable
}

// cachePutLocked stores e (f.tokMu held). When full it evicts expired entries, then invalid ones; valid entries
// are never flushed wholesale: if still full the new entry is simply not cached.
func (f *superAdminFeed) cachePutLocked(key [32]byte, e saTokenEntry) {
	if f.tokCache == nil {
		f.tokCache = make(map[[32]byte]saTokenEntry)
	}
	if _, exists := f.tokCache[key]; !exists && len(f.tokCache) >= saTokenCacheMax {
		now := time.Now()
		for k, v := range f.tokCache {
			if !now.Before(v.expires) {
				delete(f.tokCache, k)
			}
		}
		if len(f.tokCache) >= saTokenCacheMax {
			for k, v := range f.tokCache {
				if !v.ok {
					delete(f.tokCache, k)
				}
			}
		}
		if len(f.tokCache) >= saTokenCacheMax {
			return
		}
	}
	f.tokCache[key] = e
}

// statusRecorder captures only the status code of a proxied response (the body is discarded).
type statusRecorder struct {
	hdr    http.Header
	status int
}

func (s *statusRecorder) Header() http.Header { return s.hdr }
func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
}
func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return len(b), nil
}
func (s *statusRecorder) Flush() {}

// superAdminAuthStatus asks the control plane (over the :9100 session) for the status of the token's admin
// session. The dial and the request both end with ctx.
func (c *WebTerminalServer) superAdminAuthStatus(ctx context.Context, token string) (int, error) {
	sess, err := c.getOrDialSuperAdminSession(ctx, true)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, saAuthCheckPath, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	rec := &statusRecorder{hdr: make(http.Header)}
	sess.ProxyHTTP(rec, req, "control-plane") // returns when ctx ends (it aborts the RPC)
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return rec.status, nil
}
