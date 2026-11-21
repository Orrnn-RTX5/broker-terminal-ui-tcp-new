package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

const saTestToken = "test-admin-token"

// newSATestServer: a server whose control-plane check and :9100 dial are hooks (no network at all).
func newSATestServer(t *testing.T) (*WebTerminalServer, *atomic.Int32) {
	t.Helper()
	srv := newPerSessionTestServer(t)
	var verifies atomic.Int32
	srv.saFeed.statusFn = func(_ context.Context, tok string) (int, error) {
		verifies.Add(1)
		if tok == saTestToken {
			return http.StatusOK, nil
		}
		return http.StatusUnauthorized, nil
	}
	srv.saFeed.ensureFn = func() error { return nil }
	return srv, &verifies
}

func eventually(t *testing.T, what string, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func manyTicks(n int, bid float64) []rtx5tcp.BinaryTick {
	out := make([]rtx5tcp.BinaryTick, n)
	for i := range out {
		out[i] = rtx5tcp.BinaryTick{Symbol: fmt.Sprintf("SYM%03d", i), TimestampMs: time.Now().UnixMilli(), Bid: bid, Ask: bid + 1, Sequence: uint64(i + 1)}
	}
	return out
}

func feedTicks(h *webBinaryMarketHub, ticks []rtx5tcp.BinaryTick) {
	for i := 0; i < len(ticks); i += 40 {
		end := min(i+40, len(ticks))
		h.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.EncodeBinaryTickBatch(ticks[i:end]))
	}
}

// readSymbols reads the stream until want distinct symbols were seen (or the deadline passes).
func readSymbols(t *testing.T, body io.Reader, want int, within time.Duration) map[string]bool {
	t.Helper()
	var mu sync.Mutex
	seen := map[string]bool{}
	count := func() int { mu.Lock(); defer mu.Unlock(); return len(seen) }
	done := make(chan struct{})
	go func() {
		defer close(done)
		hdr := make([]byte, 4)
		for count() < want {
			if _, err := io.ReadFull(body, hdr); err != nil {
				return
			}
			payload := make([]byte, binary.LittleEndian.Uint16(hdr[2:4]))
			if _, err := io.ReadFull(body, payload); err != nil {
				return
			}
			if hdr[0] == rtx5tcp.FrameBinaryTickBatch {
				ticks, err := rtx5tcp.DecodeBinaryTickBatch(payload)
				if err == nil {
					mu.Lock()
					for _, tk := range ticks {
						seen[tk.Symbol] = true
					}
					mu.Unlock()
				}
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(within):
	}
	mu.Lock()
	defer mu.Unlock()
	out := make(map[string]bool, len(seen))
	for k := range seen {
		out[k] = true
	}
	return out
}

func openStream(t *testing.T, ts *httptest.Server, app, token string) (*http.Response, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/__rtx5_binary_stream", nil)
	if app != "" {
		req.Header.Set("X-RTX5-Web-App", app)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		cancel()
		t.Fatalf("stream request: %v", err)
	}
	return resp, cancel
}

func tokenReq(tok string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/__rtx5_binary_stream", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	return req
}

// ---- stream behaviour (hooked verification / dial) ---------------------------------------------------------------

func TestSuperAdminTabGetsManySymbolsFromHubAndLiveTicks(t *testing.T) {
	srv, _ := newSATestServer(t)
	feedTicks(srv.superAdminHub(), manyTicks(80, 100)) // cached before the tab connects: arrives as snapshot
	ts := httptest.NewServer(http.HandlerFunc(srv.serveBinaryMarketStream))
	defer ts.Close()

	resp, cancel := openStream(t, ts, "superadmin", saTestToken)
	defer cancel()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if got := readSymbols(t, resp.Body, 80, 5*time.Second); len(got) != 80 {
		t.Fatalf("snapshot symbols = %d, want 80", len(got))
	}
	feedTicks(srv.superAdminHub(), []rtx5tcp.BinaryTick{{Symbol: "LIVEONE", TimestampMs: 1, Bid: 1, Ask: 2, Sequence: 1}})
	if got := readSymbols(t, resp.Body, 1, 5*time.Second); !got["LIVEONE"] {
		t.Fatalf("live hub tick not delivered: %v", got)
	}
}

func TestBrokerTabStillGetsGuestFeedNotSuperAdminHub(t *testing.T) {
	srv, _ := newSATestServer(t)
	feedTicks(srv.superAdminHub(), manyTicks(80, 100))
	link := srv.defaultLink()
	feedTicks(link.binHub, []rtx5tcp.BinaryTick{{Symbol: "BTCUSD", TimestampMs: 1, Bid: 1, Ask: 2, Sequence: 1}})
	ts := httptest.NewServer(http.HandlerFunc(srv.serveBinaryMarketStream))
	defer ts.Close()

	resp, cancel := openStream(t, ts, "terminal", "")
	defer cancel()
	defer resp.Body.Close()
	got := readSymbols(t, resp.Body, 2, 1500*time.Millisecond)
	if !got["BTCUSD"] || len(got) != 1 {
		t.Fatalf("broker tab symbols = %v, want only BTCUSD", got)
	}
}

func TestSuperAdminStreamRejectsUnauthenticated(t *testing.T) {
	srv, _ := newSATestServer(t)
	feedTicks(srv.superAdminHub(), manyTicks(10, 100))
	ts := httptest.NewServer(http.HandlerFunc(srv.serveBinaryMarketStream))
	defer ts.Close()
	for name, tok := range map[string]string{"no token": "", "bad token": "wrong"} {
		resp, cancel := openStream(t, ts, "superadmin", tok)
		resp.Body.Close()
		cancel()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s: status %d, want 401", name, resp.StatusCode)
		}
	}
	resp, err := http.Get(ts.URL + "/__rtx5_binary_stream?__app=superadmin") // client-settable app kind is no credential
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("?__app=superadmin without token: status %d, want 401", resp.StatusCode)
	}
}

func TestVerifyFaultIs503NotCachedAs401(t *testing.T) {
	srv, _ := newSATestServer(t)
	var calls atomic.Int32
	var fail atomic.Bool
	fail.Store(true)
	srv.saFeed.statusFn = func(context.Context, string) (int, error) {
		calls.Add(1)
		if fail.Load() {
			return 0, errors.New("hub down")
		}
		return http.StatusOK, nil
	}
	ts := httptest.NewServer(http.HandlerFunc(srv.serveBinaryMarketStream))
	defer ts.Close()
	resp, cancel := openStream(t, ts, "superadmin", saTestToken)
	resp.Body.Close()
	cancel()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("fault: status %d, want 503", resp.StatusCode)
	}
	fail.Store(false) // the hub is back: the very next request must be verified again and succeed
	resp, cancel = openStream(t, ts, "superadmin", saTestToken)
	defer cancel()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("after recovery: status %d calls %d, want 200 and 2 (fault not cached)", resp.StatusCode, calls.Load())
	}

	srv2, _ := newSATestServer(t)
	srv2.saFeed.ensureFn = func() error { return errors.New("hub down") }
	ts2 := httptest.NewServer(http.HandlerFunc(srv2.serveBinaryMarketStream))
	defer ts2.Close()
	resp2, cancel2 := openStream(t, ts2, "superadmin", saTestToken)
	resp2.Body.Close()
	cancel2()
	if resp2.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("hub down: status %d, want 503", resp2.StatusCode)
	}
}

func TestClassifyAuthStatus(t *testing.T) {
	cases := []struct {
		status int
		err    error
		want   saVerdict
	}{
		{200, nil, saValid}, {401, nil, saInvalid}, {403, nil, saInvalid},
		{500, nil, saUnavailable}, {502, nil, saUnavailable}, {503, nil, saUnavailable}, {504, nil, saUnavailable},
		{429, nil, saUnavailable}, {404, nil, saUnavailable}, {0, nil, saUnavailable},
		{200, context.DeadlineExceeded, saUnavailable},
	}
	for _, c := range cases {
		if got := classifyAuthStatus(c.status, c.err); got != c.want {
			t.Fatalf("classify(%d,%v)=%d want %d", c.status, c.err, got, c.want)
		}
	}
}

func TestVerifyTimeoutIsUnavailableAndNotCached(t *testing.T) {
	old := saTokenVerifyWait
	saTokenVerifyWait = 150 * time.Millisecond
	defer func() { saTokenVerifyWait = old }()
	srv, _ := newSATestServer(t)
	var calls atomic.Int32
	srv.saFeed.statusFn = func(ctx context.Context, _ string) (int, error) {
		calls.Add(1)
		<-ctx.Done()
		return 0, ctx.Err()
	}
	for i := 0; i < 2; i++ {
		if v := srv.superAdminVerdict(tokenReq("slow")); v != saUnavailable {
			t.Fatalf("timeout verdict = %d, want unavailable", v)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2 (a timeout must not be cached)", calls.Load())
	}
}

func TestInvalidIsCachedBrieflyValidLonger(t *testing.T) {
	srv, verifies := newSATestServer(t)
	for i := 0; i < 5; i++ {
		if srv.superAdminVerdict(tokenReq(saTestToken)) != saValid {
			t.Fatal("valid token rejected")
		}
		if srv.superAdminVerdict(tokenReq("nope")) != saInvalid {
			t.Fatal("bad token accepted")
		}
	}
	if n := verifies.Load(); n != 2 {
		t.Fatalf("verifier ran %d times, want 2 (one per token, cached)", n)
	}
}

func TestSingleflightSharesOneVerification(t *testing.T) {
	srv, _ := newSATestServer(t)
	var calls atomic.Int32
	release := make(chan struct{})
	srv.saFeed.statusFn = func(context.Context, string) (int, error) {
		calls.Add(1)
		<-release
		return http.StatusOK, nil
	}
	const n = 30
	res := make(chan saVerdict, n)
	for i := 0; i < n; i++ {
		go func() { res <- srv.superAdminVerdict(tokenReq("same")) }()
	}
	eventually(t, "leader to start", 3*time.Second, func() bool { return calls.Load() == 1 })
	time.Sleep(100 * time.Millisecond) // followers have joined the flight
	close(release)
	for i := 0; i < n; i++ {
		if v := <-res; v != saValid {
			t.Fatalf("verdict %d, want valid", v)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("control plane hit %d times, want 1", calls.Load())
	}
}

func TestVerificationConcurrencyIsCapped(t *testing.T) {
	srv, _ := newSATestServer(t)
	release := make(chan struct{})
	var started atomic.Int32
	srv.saFeed.statusFn = func(context.Context, string) (int, error) {
		started.Add(1)
		<-release
		return http.StatusOK, nil
	}
	res := make(chan saVerdict, saVerifyMaxConc+5)
	for i := 0; i < saVerifyMaxConc+5; i++ {
		tok := fmt.Sprintf("tok-%d", i)
		go func() { res <- srv.superAdminVerdict(tokenReq(tok)) }()
	}
	// the 5 over the cap answer unavailable at once, without waiting for the control plane
	for i := 0; i < 5; i++ {
		select {
		case v := <-res:
			if v != saUnavailable {
				t.Fatalf("over-cap verdict %d, want unavailable", v)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("over-cap verification blocked instead of failing fast")
		}
	}
	if started.Load() > saVerifyMaxConc {
		t.Fatalf("%d concurrent verifications, cap %d", started.Load(), saVerifyMaxConc)
	}
	close(release)
	for i := 0; i < saVerifyMaxConc; i++ {
		if v := <-res; v != saValid {
			t.Fatalf("capped verification verdict %d, want valid", v)
		}
	}
}

func TestCacheEvictionKeepsValidEntries(t *testing.T) {
	var f superAdminFeed
	key := func(i int) [32]byte { var k [32]byte; binary.LittleEndian.PutUint32(k[:], uint32(i)); return k }
	now := time.Now()
	// 100 valid, 100 invalid, 56 expired = full
	for i := 0; i < 100; i++ {
		f.tokCache = nilSafe(f.tokCache)
		f.tokCache[key(i)] = saTokenEntry{ok: true, expires: now.Add(time.Minute)}
	}
	for i := 100; i < 200; i++ {
		f.tokCache[key(i)] = saTokenEntry{ok: false, expires: now.Add(time.Minute)}
	}
	for i := 200; i < saTokenCacheMax; i++ {
		f.tokCache[key(i)] = saTokenEntry{ok: true, expires: now.Add(-time.Second)}
	}
	f.cachePutLocked(key(1000), saTokenEntry{ok: true, expires: now.Add(time.Minute)})
	valid := 0
	for k, e := range f.tokCache {
		if e.ok && now.Before(e.expires) {
			valid++
		}
		_ = k
	}
	if valid != 101 {
		t.Fatalf("valid entries = %d, want 101 (all kept + the new one)", valid)
	}
	if len(f.tokCache) > saTokenCacheMax {
		t.Fatalf("cache grew past cap: %d", len(f.tokCache))
	}

	// a cache full of valid entries is never flushed: the new entry is just not cached
	var g superAdminFeed
	g.tokCache = map[[32]byte]saTokenEntry{}
	for i := 0; i < saTokenCacheMax; i++ {
		g.tokCache[key(i)] = saTokenEntry{ok: true, expires: now.Add(time.Minute)}
	}
	g.cachePutLocked(key(5000), saTokenEntry{ok: false, expires: now.Add(time.Minute)})
	if len(g.tokCache) != saTokenCacheMax {
		t.Fatalf("full valid cache changed size: %d", len(g.tokCache))
	}
	if _, ok := g.tokCache[key(5000)]; ok {
		t.Fatal("entry cached into a full all-valid cache")
	}
}

func nilSafe(m map[[32]byte]saTokenEntry) map[[32]byte]saTokenEntry {
	if m == nil {
		return map[[32]byte]saTokenEntry{}
	}
	return m
}

// ---- shared redialer -----------------------------------------------------------------------------------------------

func TestSharedRedialerStartsWithFirstTabStopsAfterLast(t *testing.T) {
	srv, _ := newSATestServer(t)
	srv.saFeed.rdGap = 20 * time.Millisecond
	base := runtime.NumGoroutine()
	rel1 := srv.acquireSuperAdminRedialer()
	rel2 := srv.acquireSuperAdminRedialer()
	rel3 := srv.acquireSuperAdminRedialer()
	if srv.saFeed.rdStarts.Load() != 1 || srv.saFeed.rdRunning.Load() != 1 {
		t.Fatalf("starts=%d running=%d, want one shared redialer", srv.saFeed.rdStarts.Load(), srv.saFeed.rdRunning.Load())
	}
	eventually(t, "redial attempts", 2*time.Second, func() bool { return srv.saFeed.rdEnsureOK.Load() >= 2 })
	rel1()
	rel1() // release is idempotent
	rel2()
	if srv.saFeed.rdRunning.Load() != 1 {
		t.Fatal("redialer stopped while a tab is still open")
	}
	rel3()
	eventually(t, "redialer to stop", 2*time.Second, func() bool { return srv.saFeed.rdRunning.Load() == 0 })
	n := srv.saFeed.rdEnsureOK.Load()
	time.Sleep(100 * time.Millisecond)
	if srv.saFeed.rdEnsureOK.Load() != n {
		t.Fatal("redialer still dialling after the last tab closed")
	}
	rel := srv.acquireSuperAdminRedialer() // restarts for the next first tab
	if srv.saFeed.rdStarts.Load() != 2 {
		t.Fatalf("starts=%d, want 2", srv.saFeed.rdStarts.Load())
	}
	rel()
	eventually(t, "goroutines back to base", 3*time.Second, func() bool { return runtime.NumGoroutine() <= base+1 })
}

func TestSuperAdminStreamLeaksNoGoroutines(t *testing.T) {
	srv, _ := newSATestServer(t)
	feedTicks(srv.superAdminHub(), manyTicks(20, 100))
	ts := httptest.NewServer(http.HandlerFunc(srv.serveBinaryMarketStream))
	defer ts.Close()
	resp, cancel := openStream(t, ts, "superadmin", saTestToken) // warm up
	readSymbols(t, resp.Body, 20, 3*time.Second)
	resp.Body.Close()
	cancel()
	time.Sleep(300 * time.Millisecond)
	base := runtime.NumGoroutine()
	for i := 0; i < 10; i++ {
		resp, cancel := openStream(t, ts, "superadmin", saTestToken)
		readSymbols(t, resp.Body, 20, 3*time.Second)
		resp.Body.Close()
		cancel()
	}
	eventually(t, "no leaked tabs/goroutines", 5*time.Second, func() bool {
		hub := srv.superAdminHub()
		hub.mu.RLock()
		subs := len(hub.subs)
		hub.mu.RUnlock()
		return subs == 0 && srv.saFeed.rdRunning.Load() == 0 && runtime.NumGoroutine() <= base+2
	})
}

// ---- real session path: mock :9100 hub + stub control plane --------------------------------------------------------

type saMockHub struct {
	ln       net.Listener
	cp       *httptest.Server
	cpHits   atomic.Int32
	cpStatus sync.Map // token -> int (default 200 for saTestToken, else 401)
	mu       sync.Mutex
	sessions []*rtx5tcp.MuxSession
}

func startSAMockHub(t *testing.T) *saMockHub {
	t.Helper()
	h := &saMockHub{}
	h.cp = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != saAuthCheckPath {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		h.cpHits.Add(1)
		tok := bearerToken(r)
		code := http.StatusUnauthorized
		if tok == saTestToken {
			code = http.StatusOK
		}
		if v, ok := h.cpStatus.Load(tok); ok {
			code = v.(int)
		}
		w.WriteHeader(code)
	}))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h.ln = ln
	go func() {
		for {
			raw, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				tc, err := rtx5tcp.AcceptTunnel(conn, 2*time.Second)
				if err != nil {
					return
				}
				sess := rtx5tcp.NewMuxSession(tc, true, func(svc, _ string) (string, string, error) {
					if svc == "control-plane" {
						return h.cp.URL, h.cp.URL, nil
					}
					return "", "", http.ErrNotSupported
				}, nil)
				h.mu.Lock()
				h.sessions = append(h.sessions, sess)
				h.mu.Unlock()
				_ = sess.ServeLoop()
			}(raw)
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		h.cp.Close()
		h.mu.Lock()
		for _, s := range h.sessions {
			_ = s.Close()
		}
		h.mu.Unlock()
	})
	return h
}

func (h *saMockHub) session(i int) *rtx5tcp.MuxSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	if i < len(h.sessions) {
		return h.sessions[i]
	}
	return nil
}

func (h *saMockHub) pushTicks(t *testing.T, i int, ticks []rtx5tcp.BinaryTick) {
	t.Helper()
	eventually(t, "mock hub session", 3*time.Second, func() bool { return h.session(i) != nil })
	for k := 0; k < len(ticks); k += 40 {
		end := min(k+40, len(ticks))
		if err := h.session(i).SendControl(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.FlagNone, rtx5tcp.EncodeBinaryTickBatch(ticks[k:end])); err != nil {
			t.Fatalf("push: %v", err)
		}
	}
}

// newSARealServer uses the real dial and the real control-plane check against the mock hub (loopback only).
func newSARealServer(h *saMockHub) *WebTerminalServer {
	return &WebTerminalServer{superAdminTCP: h.ln.Addr().String(), sessionTokens: make(map[string]string)}
}

func TestRealVerifyPathStatuses(t *testing.T) {
	h := startSAMockHub(t)
	srv := newSARealServer(h)
	h.cpStatus.Store("t403", 403)
	h.cpStatus.Store("t500", 500)
	h.cpStatus.Store("t429", 429)

	want := map[string]saVerdict{saTestToken: saValid, "bad": saInvalid, "t403": saInvalid, "t500": saUnavailable, "t429": saUnavailable}
	for tok, w := range want {
		if got := srv.superAdminVerdict(tokenReq(tok)); got != w {
			t.Fatalf("token %q verdict %d, want %d", tok, got, w)
		}
	}
	// 200/401/403 are cached, 5xx/429 are not
	hits := h.cpHits.Load()
	for tok := range want {
		srv.superAdminVerdict(tokenReq(tok))
	}
	if extra := h.cpHits.Load() - hits; extra != 2 {
		t.Fatalf("second round hit the control plane %d times, want 2 (only t500 and t429 re-checked)", extra)
	}
}

func TestRealSessionFeedsTabsAndEndsThemOnSessionLoss(t *testing.T) {
	h := startSAMockHub(t)
	srv := newSARealServer(h)
	srv.saFeed.rdGap = 50 * time.Millisecond
	ts := httptest.NewServer(http.HandlerFunc(srv.serveBinaryMarketStream))
	defer ts.Close()

	resp, cancel := openStream(t, ts, "superadmin", saTestToken)
	defer cancel()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	h.pushTicks(t, 0, manyTicks(80, 100))
	if got := readSymbols(t, resp.Body, 80, 5*time.Second); len(got) != 80 {
		t.Fatalf("hub ticks over the real session: %d symbols, want 80", len(got))
	}

	// the hub drops the session: the tab is closed (never left showing stale prices as live)
	_ = h.session(0).Close()
	closed := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, resp.Body); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("tab still open after the :9100 session ended")
	}

	// a reconnecting tab gets a fresh session; the old cache is gone (stale symbols are not replayed)
	resp2, cancel2 := openStream(t, ts, "superadmin", saTestToken)
	defer cancel2()
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("reconnect status %d", resp2.StatusCode)
	}
	hub := srv.superAdminHub()
	hub.mu.RLock()
	n := len(hub.latestTicks)
	hub.mu.RUnlock()
	if n != 0 {
		t.Fatalf("hub cache after redial = %d, want 0", n)
	}
	h.pushTicks(t, 1, []rtx5tcp.BinaryTick{{Symbol: "FRESH", TimestampMs: 1, Bid: 1, Ask: 2, Sequence: 1}})
	got := readSymbols(t, resp2.Body, 1, 5*time.Second)
	if !got["FRESH"] || len(got) != 1 {
		t.Fatalf("after redial tab symbols = %v, want only FRESH", got)
	}
}

func TestLogoDialedSessionIsReplacedByFeedSession(t *testing.T) {
	h := startSAMockHub(t)
	srv := newSARealServer(h)
	// a session dialled by the logo path has no control handler and is not the feeding session
	plain, err := srv.getOrDialSuperAdminSession(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if srv.saFeed.isFeedSession(plain) != true {
		t.Fatal("session dialled by the feed path must be the feeding session")
	}
	_ = plain.Close()
	eventually(t, "session to end", 3*time.Second, func() bool {
		select {
		case <-plain.Done():
			return true
		default:
			return false
		}
	})

	tc, err := rtx5tcp.DialTunnel(h.ln.Addr().String(), rtx5tcp.RoleSuperAdminClient, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	foreign := rtx5tcp.NewMuxSession(tc, false, nil, nil)
	go func() { _ = foreign.ServeLoop() }()
	srv.mu.Lock()
	srv.superAdminMux = foreign
	srv.mu.Unlock()

	if s, _ := srv.getOrDialSuperAdminSession(context.Background(), false); s != foreign {
		t.Fatal("RPC callers must keep reusing the live foreign session")
	}
	fed, err := srv.getOrDialSuperAdminSession(context.Background(), true)
	if err != nil || fed == foreign || !srv.saFeed.isFeedSession(fed) {
		t.Fatalf("feed caller must replace the foreign session (err=%v)", err)
	}
	eventually(t, "foreign session closed", 3*time.Second, func() bool {
		select {
		case <-foreign.Done():
			return true
		default:
			return false
		}
	})
}

func TestDialHonoursCancelledContext(t *testing.T) {
	srv := &WebTerminalServer{superAdminTCP: "127.0.0.2:1"}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if _, err := srv.getOrDialSuperAdminSession(ctx, true); err == nil {
		t.Fatal("dial with a cancelled context must fail")
	}
	if time.Since(start) > time.Second {
		t.Fatal("cancelled dial was not immediate")
	}
	// a held dial lock must not block a cancellable caller beyond its context
	srv.saDialMu.Lock()
	defer srv.saDialMu.Unlock()
	ctx2, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2()
	start = time.Now()
	if _, err := srv.getOrDialSuperAdminSession(ctx2, true); err == nil || time.Since(start) > time.Second {
		t.Fatalf("lock wait ignored ctx (err=%v, took %v)", err, time.Since(start))
	}
}
