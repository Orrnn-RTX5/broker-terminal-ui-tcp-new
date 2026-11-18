package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func TestGuestTabDoesNotStopTicksForLoggedInTab(t *testing.T) {
	e := newAcctEnv(t)
	guestConn := e.fb.conn(0)
	a := e.newSub("tab-a", "terminal")
	g := e.newSub("tab-g", "terminal")

	accConn := e.loginTab(t, a, 100, "tok-a", "ACC100")
	// The guest tab "logs out" (login 0, no token): the old code forwarded this onto the shared tunnel.
	e.postSub(t, "tab-g", "terminal", 0, "")
	time.Sleep(100 * time.Millisecond)
	if n := guestConn.subs.Load(); n != 0 {
		t.Fatalf("shared guest tunnel received %d 0x3B frames, want 0", n)
	}
	if accConn == guestConn {
		t.Fatal("account tab must have its own tunnel")
	}

	collect(a, 50*time.Millisecond)
	collect(g, 50*time.Millisecond)
	pushTick(t, accConn, "ACC100")
	pushTick(t, guestConn, "GUEST")
	waitSymbol(t, a, "ACC100")
	waitSymbol(t, g, "GUEST")
	if got := collect(a, 150*time.Millisecond); contains(got, "GUEST") {
		t.Fatalf("logged-in tab got guest frames: %v", got)
	}
	if got := collect(g, 150*time.Millisecond); contains(got, "ACC100") {
		t.Fatalf("guest tab got account frames: %v", got)
	}
}

func TestTwoAccountsGetOnlyTheirOwnTunnelFrames(t *testing.T) {
	e := newAcctEnv(t)
	a := e.newSub("tab-a", "terminal")
	b := e.newSub("tab-b", "terminal")
	a2 := e.newSub("tab-a2", "terminal") // second tab of account 100 shares the tunnel

	c100 := e.loginTab(t, a, 100, "tok-100", "ACC100")
	c200 := e.loginTab(t, b, 200, "tok-200", "ACC200")
	e.postSub(t, "tab-a2", "terminal", 100, "tok-100")
	waitFor(t, "second tab on account 100", func() bool { return a2.src.Load() == e.tun("terminal", 100, "tok-100").hub })
	if c100 == c200 {
		t.Fatal("accounts must not share a tunnel")
	}
	if e.fb.connCount() != 3 {
		t.Fatalf("tunnels = %d, want guest + 2 accounts = 3", e.fb.connCount())
	}
	if c100.lastToken() != "tok-100" || c200.lastToken() != "tok-200" {
		t.Fatal("each tunnel must carry only its own account's 0x3B")
	}

	collect(a, 50*time.Millisecond)
	collect(b, 50*time.Millisecond)
	collect(a2, 50*time.Millisecond)
	pushTick(t, c100, "ONLY100")
	pushTick(t, c200, "ONLY200")
	waitSymbol(t, a, "ONLY100")
	waitSymbol(t, a2, "ONLY100")
	waitSymbol(t, b, "ONLY200")
	if got := collect(a, 150*time.Millisecond); contains(got, "ONLY200") {
		t.Fatalf("account 100 got account 200 frames: %v", got)
	}
	if got := collect(b, 150*time.Millisecond); contains(got, "ONLY100") {
		t.Fatalf("account 200 got account 100 frames: %v", got)
	}
}

func TestLoginAndLogoutOnOpenStreamSwitchSourceWithSnapshot(t *testing.T) {
	e := newAcctEnv(t)
	guestConn := e.fb.conn(0)
	pushTick(t, guestConn, "GUESTSYM")
	waitFor(t, "guest cache", func() bool {
		e.link.binHub.mu.RLock()
		defer e.link.binHub.mu.RUnlock()
		return len(e.link.binHub.latestTicks) == 1
	})

	s := e.newSub("tab", "terminal")
	if s.src.Load() != e.link.binHub {
		t.Fatal("a logged-out tab starts on the guest source")
	}

	e.postSub(t, "tab", "terminal", 100, "tok")
	accConn := e.fb.connFor(t, 100)
	waitFor(t, "switch to account", func() bool {
		pushTick(t, accConn, "ACCSYM")
		return s.src.Load() == e.tun("terminal", 100, "tok").hub
	})
	waitSymbol(t, s, "ACCSYM") // the account hub's snapshot reached the tab at once
	collect(s, 50*time.Millisecond)
	pushTick(t, guestConn, "GUESTSYM2")
	if got := collect(s, 150*time.Millisecond); contains(got, "GUESTSYM2") {
		t.Fatalf("tab on the account source got a guest frame: %v", got)
	}

	e.postSub(t, "tab", "terminal", 0, "")
	if s.src.Load() != e.link.binHub {
		t.Fatal("logged-out tab must return to the guest source")
	}
	got := collect(s, 100*time.Millisecond)
	if !contains(got, "GUESTSYM") || !contains(got, "GUESTSYM2") {
		t.Fatalf("guest snapshot not delivered on logout: %v", got)
	}
	// The session made that tunnel and nothing uses it any more: it is released at once.
	waitFor(t, "unused tunnel released on logout", func() bool { return !liveSession(accConn.sess) })
	if got := collect(s, 100*time.Millisecond); contains(got, "ACCSYM2") {
		t.Fatalf("logged-out tab got an account frame: %v", got)
	}
}

// (a) the latest 0x3B is replayed after a redial, for every role; H2: until the redialled tunnel commits the
// tab sits on the guest source (never on a hub whose pump may still be blocked).
func TestRedialReplaysSubscriptionAndTabWaitsOnGuestUntilCommit(t *testing.T) {
	for _, appKind := range []string{"terminal", "manager", "admin"} {
		t.Run(appKind, func(t *testing.T) {
			e := newAcctEnv(t)
			guestConn := e.fb.conn(0)
			role := roleForAppKind(appKind)
			login := int64(100)
			if appKind != "terminal" {
				login = 0 // wildcard
			}
			s := e.newSub("tab", appKind)
			c1 := e.loginAs(t, s, appKind, login, "tok", "ACC")
			if c1.role != role {
				t.Fatalf("tunnel dialled with role %d, want %d", c1.role, role)
			}
			tn := e.tun(appKind, login, "tok")
			_ = c1.sess.Close() // :4443 drops the tunnel
			waitFor(t, "tunnel marked down", func() bool { return !tn.live() })
			waitFor(t, "tab falls back to the guest source while its tunnel is down", func() bool { return s.src.Load() == e.link.binHub })
			e.link.keepAccountTunnelsWarm() // what backgroundReconnectLoop does every few seconds
			var c2 *fakeConn
			waitFor(t, "re-dialled tunnel replays its 0x3B", func() bool {
				for i := 1; i < e.fb.connCount(); i++ {
					if c := e.fb.conn(i); c != c1 && c.role == role && c.login.Load() == login && c.lastToken() == "tok" {
						c2 = c
						return true
					}
				}
				return false
			})
			// Re-dialled, subscribed, barrier passed - but no frame since: not committed, tab still on guest.
			waitFor(t, "barrier passed", func() bool { return tn.hub.armedAt.Load() != 0 })
			time.Sleep(60 * time.Millisecond)
			if tn.hub.committed.Load() || s.src.Load() != e.link.binHub {
				t.Fatal("tab must stay on the guest source until the re-dialled tunnel commits")
			}
			waitFor(t, "tab back on its tunnel after commit", func() bool {
				pushTick(t, c2, "ACC")
				return s.src.Load() == tn.hub
			})
			if n := guestConn.subs.Load(); n != 0 {
				t.Fatalf("shared guest tunnel received %d 0x3B", n)
			}
		})
	}
}

// H1/H2: frames that arrive before the barrier (the guest snapshot sent on connect) never commit a tunnel and
// are never cached.
func TestGuestSnapshotBeforeThePongDoesNotCommit(t *testing.T) {
	e := newAcctEnv(t)
	snap := "GUESTSNAP"
	e.fb.greet.Store(&snap)
	s := e.newSub("tab", "terminal")
	e.postSub(t, "tab", "terminal", 100, "tok")
	c := e.fb.connFor(t, 100)
	tn := e.tun("terminal", 100, "tok")
	waitFor(t, "barrier passed", func() bool { return tn.hub.armedAt.Load() != 0 })
	time.Sleep(100 * time.Millisecond)
	tn.hub.mu.RLock()
	cached := len(tn.hub.latestTicks)
	tn.hub.mu.RUnlock()
	if tn.hub.committed.Load() || cached != 0 || s.src.Load() != e.link.binHub {
		t.Fatalf("pre-barrier snapshot committed=%v cached=%d onGuest=%v", tn.hub.committed.Load(), cached, s.src.Load() == e.link.binHub)
	}
	waitFor(t, "committed by a frame after the pong", func() bool {
		pushTick(t, c, "REAL")
		return tn.hub.committed.Load()
	})
	tn.hub.mu.RLock()
	_, hasSnap := tn.hub.latestTicks["GUESTSNAP"]
	tn.hub.mu.RUnlock()
	if hasSnap {
		t.Fatal("the pre-barrier snapshot must not be in the account hub's cache")
	}
}

func TestIdleAccountTunnelsAreClosed(t *testing.T) {
	e := newAcctEnv(t)
	bound := e.newSub("bound", "terminal")
	e.loginTab(t, bound, 100, "tok", "ACC100")
	e.postSub(t, "gone", "terminal", 200, "tok2") // no stream bound to 200
	c200 := e.fb.connFor(t, 200)
	e.commit(t, c200, "terminal", 200, "tok2") // committed, so only the idle rule applies

	e.link.pruneAccountTunnels(time.Now())
	if e.tun("terminal", 200, "tok2") == nil {
		t.Fatal("a fresh tunnel must not be pruned")
	}
	later := time.Now().Add(accountTunnelIdleTimeout + time.Minute)
	e.link.pruneAccountTunnels(later)
	if e.tun("terminal", 200, "tok2") != nil {
		t.Fatal("idle tunnel with no tab must be pruned")
	}
	waitFor(t, "idle tunnel closed", func() bool { return !liveSession(c200.sess) })
	if tn := e.tun("terminal", 100, "tok"); tn == nil || !tn.live() {
		t.Fatal("a tunnel with a bound tab must stay")
	}

	e.link.closeAll()
	waitFor(t, "closeAll closes account tunnels", func() bool {
		for i := 0; i < e.fb.connCount(); i++ {
			if liveSession(e.fb.conn(i).sess) {
				return false
			}
		}
		return true
	})
}

func TestTradeEventsPerTabLoginAndNoDuplicates(t *testing.T) {
	e := newAcctEnv(t)
	a := e.newSub("tab-a", "terminal")
	b := e.newSub("tab-b", "terminal")
	c100 := e.loginTab(t, a, 100, "tok-100", "ACC100")
	e.loginTab(t, b, 200, "tok-200", "ACC200")

	ev := tradeEventPayload(100, 7)
	// The same event over the account tunnel (this proves the tab's claim) and then over the direct gateway
	// push loop: the tab must see it once.
	pushEvent(t, c100, ev)
	waitFor(t, "tab bound to its login", func() bool { return a.effLogin() == 100 })
	waitFor(t, "event delivered", func() bool { return len(a.prioCh) == 1 })
	e.link.binHub.broadcastTradeEvent(ev)
	time.Sleep(150 * time.Millisecond)
	if n := len(a.prioCh); n != 1 {
		t.Fatalf("account 100 tab got %d copies of the event, want 1", n)
	}
	if n := len(b.prioCh); n != 0 || b.effLogin() != 0 {
		t.Fatalf("account 200 tab got %d events of another account (eff=%d)", n, b.effLogin())
	}
}

// 1. A forged token cannot overwrite a real subscription, reach its hub or its 0x3A events.
func TestForgedTokenCannotHijackAnAccount(t *testing.T) {
	e := newAcctEnv(t)
	real := e.newSub("real", "terminal")
	forger := e.newSub("forger", "terminal")
	cReal := e.loginTab(t, real, 100, "tok-real", "ACC100")

	// Forger claims the same login with a junk token (the fake broker, like the post-fix :4443, still sends a
	// guest-scoped feed on that tunnel, so it warms: market frames prove nothing).
	e.postSub(t, "forger", "terminal", 100, "tok-junk")
	cFake := e.fb.connFor(t, 100) // may find either; select the forged one by token below
	_ = cFake
	waitFor(t, "forged tunnel subscribed with its own token", func() bool {
		for i := 1; i < e.fb.connCount(); i++ {
			if c := e.fb.conn(i); c.lastToken() == "tok-junk" {
				cFake = c
				return true
			}
		}
		return false
	})
	if cFake == cReal {
		t.Fatal("forged token must get its own tunnel")
	}
	if cReal.lastToken() != "tok-real" {
		t.Fatalf("real tunnel's subscription was overwritten: %q", cReal.lastToken())
	}
	// (what the real :4443 does for a rejected token is not known here: if the guest feed ever commits it, the
	// tab may sit on that hub, but it still has no bound login and cannot reach the real account's hub)
	e.commit(t, cFake, "terminal", 100, "tok-junk")
	if forger.src.Load() == e.tun("terminal", 100, "tok-real").hub {
		t.Fatal("forged tab reached the real account's hub")
	}

	// The real account's private events never reach the forger, from the tunnel or the direct loop.
	ev := tradeEventPayload(100, 9)
	pushEvent(t, cReal, ev)
	e.link.binHub.broadcastTradeEvent(tradeEventPayload(100, 10))
	waitFor(t, "real tab got its events", func() bool { return len(real.prioCh) >= 1 })
	time.Sleep(100 * time.Millisecond)
	if forger.effLogin() != 0 || len(forger.prioCh) != 0 {
		t.Fatalf("forged claim received private events: eff=%d n=%d", forger.effLogin(), len(forger.prioCh))
	}

	// A later re-dial of the real tunnel still replays the real token.
	tn := e.tun("terminal", 100, "tok-real")
	tn.mu.Lock()
	stored := string(tn.sub[rtx5tcp.BinaryAccountSubHeaderSize:])
	tn.mu.Unlock()
	if stored != "tok-real" {
		t.Fatal("real tunnel's stored subscription changed")
	}
}

// 1 (rotation). A token rotation moves the tab to the new tunnel once it warms; the old one is pruned.
func TestTokenRotationMovesTabAndPrunesOldTunnel(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	e.loginTab(t, s, 100, "tok-1", "OLD")
	oldHub := e.tun("terminal", 100, "tok-1").hub

	e.postSub(t, "tab", "terminal", 100, "tok-2")
	var c2 *fakeConn
	waitFor(t, "rotated tunnel subscribed", func() bool {
		for i := 1; i < e.fb.connCount(); i++ {
			if c := e.fb.conn(i); c.lastToken() == "tok-2" {
				c2 = c
				return true
			}
		}
		return false
	})
	if s.src.Load() != oldHub {
		t.Fatal("until the new tunnel warms the tab stays on the proven old one")
	}
	waitFor(t, "tab moved to the new tunnel", func() bool {
		pushTick(t, c2, "NEW")
		return s.src.Load() == e.tun("terminal", 100, "tok-2").hub
	})
	waitSymbol(t, s, "NEW")

	// L7: the superseded tunnel was released right after the tab's move, without waiting for the prune.
	waitFor(t, "superseded tunnel released", func() bool { return e.tun("terminal", 100, "tok-1") == nil })
	if e.tun("terminal", 100, "tok-2") == nil {
		t.Fatal("the new tunnel must stay")
	}
}

// 1 (non-warm close). A tunnel that never delivers a market frame is closed after the warm timeout.
func TestNonWarmTunnelIsClosed(t *testing.T) {
	e := newAcctEnv(t)
	e.postSub(t, "x", "terminal", 300, "tok-x")
	c := e.fb.connFor(t, 300)
	e.postSub(t, "y", "terminal", 301, "tok-y")
	cy := e.fb.connFor(t, 301)
	e.commit(t, cy, "terminal", 301, "tok-y")

	e.link.pruneAccountTunnels(time.Now().Add(accountTunnelCommitTimeout / 2))
	if e.tun("terminal", 300, "tok-x") == nil {
		t.Fatal("must not close before the warm timeout")
	}
	e.link.pruneAccountTunnels(time.Now().Add(accountTunnelCommitTimeout + time.Second))
	if e.tun("terminal", 300, "tok-x") != nil {
		t.Fatal("a tunnel that never warmed must be closed")
	}
	waitFor(t, "non-warm tunnel closed", func() bool { return !liveSession(c.sess) })
	if e.tun("terminal", 301, "tok-y") == nil || !liveSession(cy.sess) {
		t.Fatal("a warm tunnel must stay")
	}
}

// 1 (cap). At the cap, non-warm tunnels are evicted first; a real (warm) one is refused only when all are warm.
func TestTunnelCapEvictsNonWarmFirst(t *testing.T) {
	prevLink, prevSess := maxAccountTunnelsPerLink, maxAccountTunnelsPerSession
	maxAccountTunnelsPerLink, maxAccountTunnelsPerSession = 3, 2
	t.Cleanup(func() { maxAccountTunnelsPerLink, maxAccountTunnelsPerSession = prevLink, prevSess })
	e := newAcctEnv(t)

	post := func(sess string, login int64) *fakeConn {
		e.postSub(t, sess, "terminal", login, "tok")
		return e.fb.connFor(t, login)
	}
	warm := func(c *fakeConn, login int64) { e.commit(t, c, "terminal", login, "tok") }
	c1 := post("s1", 1)
	c2 := post("s2", 2)
	c3 := post("s3", 3)
	warm(c2, 2)
	warm(c3, 3)
	// Full (3): the new one evicts the only non-warm tunnel (login 1).
	post("s4", 4)
	if e.tun("terminal", 1, "tok") != nil || e.tun("terminal", 4, "tok") == nil {
		t.Fatal("the non-warm tunnel must be evicted for the new one")
	}
	waitFor(t, "evicted tunnel closed", func() bool { return !liveSession(c1.sess) })
	// Warm everything: the next real subscription is refused and the tab stays on the guest feed.
	warm(e.fb.connFor(t, 4), 4) // 2, 3, 4 warm; cap 3
	e.postSub(t, "s5", "terminal", 5, "tok")
	time.Sleep(100 * time.Millisecond)
	if e.tun("terminal", 5, "tok") != nil {
		t.Fatal("with every tunnel warm the new one must be refused")
	}
	if e.tun("terminal", 2, "tok") == nil || e.tun("terminal", 3, "tok") == nil || e.tun("terminal", 4, "tok") == nil {
		t.Fatal("warm tunnels must never be evicted")
	}

	// Per-session limit: one session can hold two tunnels.
	e.link.closeAccountTunnels()
	maxAccountTunnelsPerLink = 256
	e.postSub(t, "greedy", "terminal", 11, "tok")
	g1 := e.fb.connFor(t, 11)
	e.postSub(t, "greedy", "terminal", 12, "tok")
	e.fb.connFor(t, 12)
	// Moving to a new account releases the tunnels nothing uses; with both unused a third still fits.
	e.postSub(t, "greedy", "terminal", 13, "tok")
	e.fb.connFor(t, 13)
	n := 0
	e.link.acctMu.RLock()
	for _, tn := range e.link.acct {
		if tn.creator == "greedy" {
			n++
		}
	}
	e.link.acctMu.RUnlock()
	if n > maxAccountTunnelsPerSession {
		t.Fatalf("session holds %d tunnels, limit %d", n, maxAccountTunnelsPerSession)
	}
	_ = g1
}

// 5. A retired link cannot make new account tunnels.
func TestRetiredLinkMakesNoAccountTunnels(t *testing.T) {
	e := newAcctEnv(t)
	e.link.retire()
	e.postSub(t, "late", "terminal", 100, "tok")
	time.Sleep(100 * time.Millisecond)
	e.link.acctMu.RLock()
	n := len(e.link.acct)
	e.link.acctMu.RUnlock()
	if n != 0 {
		t.Fatalf("retired link holds %d account tunnels", n)
	}
}

// 3. No 0x3A event is lost while a tab moves between sources.
func TestNoTradeEventLostAcrossSourceMoves(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	e.loginTab(t, s, 100, "tok", "ACC")
	key := makeAccountKey(rtx5tcp.RoleTraderTerminalClient, 100, "tok")
	e.link.bindClientAccount("tab", 100, key, true, nil, "") // proven by the gateway: bound whatever the source
	accHub := e.tun("terminal", 100, "tok").hub

	const events = 400
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			e.link.srcMu.Lock()
			e.link.moveSubLocked(s, e.link.binHub)
			e.link.moveSubLocked(s, accHub)
			e.link.srcMu.Unlock()
		}
	}()
	for i := 0; i < events; i++ {
		p := tradeEventPayload(100, 1)
		p[20], p[21] = byte(i), byte(i>>8) // distinct events
		e.link.binHub.broadcastTradeEvent(p)
	}
	close(stop)
	wg.Wait()
	if n := len(s.prioCh); n != events {
		t.Fatalf("tab received %d of %d events across source moves", n, events)
	}
}

// 4. Queued candle frames survive a source switch.
func TestSourceSwitchKeepsQueuedCandles(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	candle := wrapWebBinaryFrame(rtx5tcp.FrameBinaryCandleBatch, []byte{1, 2, 3, 4})
	s.ch <- candle
	s.ch <- wrapWebBinaryFrame(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.EncodeBinaryTickBatch([]rtx5tcp.BinaryTick{{Symbol: "OLD"}}))
	e.loginTab(t, s, 100, "tok", "ACC")
	var gotCandle bool
	for done := false; !done; {
		select {
		case pkt := <-s.ch:
			if len(pkt) > 0 && pkt[0] == rtx5tcp.FrameBinaryCandleBatch {
				gotCandle = true
			}
			if contains(tickSymbols(pkt), "OLD") {
				t.Fatal("a stale tick of the old source survived the switch")
			}
		default:
			done = true
		}
	}
	if !gotCandle {
		t.Fatal("queued candle frame was dropped by the source switch")
	}
}

// (b) a manager/admin subscription (or its logout) never touches the shared guest tunnel; (a) it gets its own
// role tunnel; (d) wildcard -1 is granted only after proof, never on the app kind alone.
func TestManagerAdminTabsGetOwnTunnelsAndWildcardNeedsProof(t *testing.T) {
	for _, appKind := range []string{"manager", "admin"} {
		t.Run(appKind, func(t *testing.T) {
			e := newAcctEnv(t)
			guestConn := e.fb.conn(0)
			g := e.newSub("guest", "terminal")
			m := e.newSub("mgr", appKind)
			role := roleForAppKind(appKind)

			cm := e.loginAs(t, m, appKind, 0, "mgr-token", "MGR")
			if cm.role != role || cm == guestConn {
				t.Fatalf("privileged tab tunnel role=%d (want %d), shared=%v", cm.role, role, cm == guestConn)
			}
			if guestConn.subs.Load() != 0 {
				t.Fatal("a privileged 0x3B reached the shared guest tunnel")
			}
			// (d) an app kind claim alone grants nothing: the gateway did not verify and no event arrived.
			if m.effLogin() != 0 {
				t.Fatalf("wildcard granted on app kind alone: eff=%d", m.effLogin())
			}
			e.link.binHub.broadcastTradeEvent(tradeEventPayload(555, 1))
			time.Sleep(50 * time.Millisecond)
			if len(m.prioCh) != 0 {
				t.Fatal("unproven wildcard received a private event")
			}
			// Proven by an event on its own tunnel: wildcard bound, and that very event is delivered.
			pushEvent(t, cm, tradeEventPayload(555, 2))
			waitFor(t, "wildcard bound after proof", func() bool { return m.effLogin() == -1 })
			waitFor(t, "event delivered", func() bool { return len(m.prioCh) == 1 })

			// (b) logout / a guest tab's frames: the shared feed and its subscription are untouched.
			e.postSub(t, "mgr", appKind, 0, "")
			if guestConn.subs.Load() != 0 {
				t.Fatal("privileged logout reached the shared guest tunnel")
			}
			collect(g, 30*time.Millisecond)
			pushTick(t, guestConn, "GUEST")
			waitSymbol(t, g, "GUEST")
		})
	}
}

// (c) the manager REST tunnel feeds no hub and never clears the guest cache.
func TestManagerRESTTunnelDoesNotFeedOrClearGuestHub(t *testing.T) {
	e := newAcctEnv(t)
	guestConn := e.fb.conn(0)
	pushTick(t, guestConn, "GUESTSYM")
	waitFor(t, "guest cache", func() bool {
		e.link.binHub.mu.RLock()
		defer e.link.binHub.mu.RUnlock()
		return len(e.link.binHub.latestTicks) == 1
	})
	if _, err := e.link.getOrDialManagerSession(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "manager REST tunnel accepted", func() bool { return e.fb.connCount() == 2 })
	mgrConn := e.fb.conn(1)
	if mgrConn.role != rtx5tcp.RoleBrokerManagerClient {
		t.Fatalf("role = %d", mgrConn.role)
	}
	pushTick(t, mgrConn, "FROMMGR")
	time.Sleep(150 * time.Millisecond)
	e.link.binHub.mu.RLock()
	_, hasGuest := e.link.binHub.latestTicks["GUESTSYM"]
	_, hasMgr := e.link.binHub.latestTicks["FROMMGR"]
	e.link.binHub.mu.RUnlock()
	if !hasGuest {
		t.Fatal("dialling the manager tunnel cleared the guest cache")
	}
	if hasMgr {
		t.Fatal("the manager REST tunnel fed the guest hub")
	}
}

// H1: a forged token never commits (no frame passes the barrier) and is closed after the commit timeout.
func TestForgedTunnelNeverCommitsAndIsClosed(t *testing.T) {
	e := newAcctEnv(t)
	forger := e.newSub("forger", "terminal")
	e.postSub(t, "forger", "terminal", 100, "junk")
	c := e.fb.connFor(t, 100)
	tn := e.tun("terminal", 100, "junk")
	waitFor(t, "barrier passed", func() bool { return tn.hub.armedAt.Load() != 0 })
	time.Sleep(60 * time.Millisecond) // a blocked pump sends nothing
	if tn.hub.committed.Load() || forger.src.Load() != e.link.binHub || forger.effLogin() != 0 {
		t.Fatal("a tunnel that delivers nothing after the barrier must not commit or bind")
	}
	e.link.pruneAccountTunnels(time.Now().Add(accountTunnelCommitTimeout + time.Second))
	if e.tun("terminal", 100, "junk") != nil {
		t.Fatal("an uncommitted tunnel must be closed after the commit timeout")
	}
	waitFor(t, "forged tunnel closed", func() bool { return !liveSession(c.sess) })
}

// H1: a cap full of uncommitted forged tunnels does not block a real login.
func TestCapFullOfUncommittedForgedTunnelsDoesNotBlockRealLogin(t *testing.T) {
	prevLink := maxAccountTunnelsPerLink
	maxAccountTunnelsPerLink = 3
	t.Cleanup(func() { maxAccountTunnelsPerLink = prevLink })
	e := newAcctEnv(t)
	for i, ip := range []string{"198.51.100.1:1", "198.51.100.2:1", "198.51.100.3:1"} {
		e.ip = ip
		e.postSub(t, "forger"+string(rune('a'+i)), "terminal", int64(100+i), "junk")
		e.fb.connFor(t, int64(100+i))
	}
	e.ip = "203.0.113.9:1"
	realTab := e.newSub("real", "terminal")
	e.loginTab(t, realTab, 500, "tok-real", "REAL")
	if e.tun("terminal", 500, "tok-real") == nil || realTab.src.Load() != e.tun("terminal", 500, "tok-real").hub {
		t.Fatal("the real login must get a committed tunnel although the cap was full of forged ones")
	}
}

// H1: per-client-address limit on uncommitted tunnels.
func TestUncommittedTunnelsPerIPAreLimited(t *testing.T) {
	prevCap := maxUncommittedTunnelsPerIP
	maxUncommittedTunnelsPerIP = 4
	t.Cleanup(func() { maxUncommittedTunnelsPerIP = prevCap })
	e := newAcctEnv(t)
	for i := 0; i < maxUncommittedTunnelsPerIP+3; i++ {
		e.postSub(t, "s"+string(rune('a'+i)), "terminal", int64(100+i), "junk")
	}
	time.Sleep(150 * time.Millisecond)
	n := 0
	e.link.acctMu.RLock()
	for _, tn := range e.link.acct {
		if tn.creatorIP == "192.0.2.1" && !tn.hub.committed.Load() {
			n++
		}
	}
	e.link.acctMu.RUnlock()
	if n > maxUncommittedTunnelsPerIP {
		t.Fatalf("%d uncommitted tunnels from one address, limit %d", n, maxUncommittedTunnelsPerIP)
	}
}

// M3: a tab whose claim is set but whose tunnel was closed gets it back without a new POST (with backoff).
func TestClosedTunnelOfClaimedTabIsRecreated(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	c1 := e.loginTab(t, s, 100, "tok", "ACC")
	tn := e.tun("terminal", 100, "tok")
	// The tunnel is closed under the tab (pruned / evicted).
	e.link.acctMu.Lock()
	delete(e.link.acct, tn.key)
	e.link.acctMu.Unlock()
	e.link.dropTunnels([]*accountTunnel{tn})
	waitFor(t, "old tunnel closed", func() bool { return !liveSession(c1.sess) })
	if s.src.Load() != e.link.binHub {
		t.Fatal("tab must be on the guest source")
	}

	now := time.Now()
	e.link.recreateClaimedTunnels(now) // first sighting: the backoff starts
	if e.tun("terminal", 100, "tok") != nil {
		t.Fatal("must not recreate before the first backoff")
	}
	e.link.recreateClaimedTunnels(now.Add(accountRetryMin + time.Second))
	tn2 := e.tun("terminal", 100, "tok")
	if tn2 == nil {
		t.Fatal("the tunnel of a claimed tab must be recreated without a new POST")
	}
	var c2 *fakeConn
	waitFor(t, "recreated tunnel subscribed", func() bool {
		for i := 1; i < e.fb.connCount(); i++ {
			if c := e.fb.conn(i); c != c1 && c.login.Load() == 100 && c.lastToken() == "tok" {
				c2 = c
				return true
			}
		}
		return false
	})
	waitFor(t, "tab back on its tunnel", func() bool {
		pushTick(t, c2, "ACC")
		return s.src.Load() == tn2.hub
	})
}

// M4: a burst of more than 8 events is deduplicated.
func TestTradeDedupeHandlesABurst(t *testing.T) {
	hub := newWebBinaryMarketHub()
	s := &webBinaryStreamSub{clientKey: "k", ch: make(chan []byte, 1), prioCh: make(chan []byte, 512)}
	s.accountLogin.Store(-1)
	hub.subs[s] = struct{}{}
	const burst = 40
	for round := 0; round < 2; round++ {
		for i := 0; i < burst; i++ {
			hub.broadcastTradeEvent(tradeEventPayload(100, byte(i)))
		}
	}
	if n := len(s.prioCh); n != burst {
		t.Fatalf("tab got %d events, want %d (every event once)", n, burst)
	}
}

// M6: a session's subscription is forgotten after its streams are gone for the TTL.
func TestBindingsAreForgottenAfterTheLastStreamIsGone(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	e.postSub(t, "tab", "terminal", 100, "tok")
	e.link.pruneBindings(time.Now().Add(time.Hour))
	e.link.srcMu.RLock()
	n := len(e.link.bindings)
	e.link.srcMu.RUnlock()
	if n != 1 {
		t.Fatal("a binding with a live stream must stay")
	}
	e.link.detachSub(s)
	e.link.pruneBindings(time.Now().Add(sessionBindingIdleTTL + time.Minute))
	e.link.srcMu.RLock()
	n = len(e.link.bindings)
	e.link.srcMu.RUnlock()
	if n != 0 {
		t.Fatalf("binding kept after the last stream closed: %d", n)
	}
}

// M1: a lost barrier pong after a redial leaves the tunnel unarmed; the keep-warm loop re-sends the 0x3B with a
// fresh barrier and the tunnel then commits.
func TestLostBarrierPongAfterRedialIsRearmedAndCommits(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	c1 := e.loginTab(t, s, 100, "tok", "ACC")
	tn := e.tun("terminal", 100, "tok")

	orig := barrierPing
	var calls atomic.Int32
	barrierPing = func(sess *rtx5tcp.MuxSession) error {
		if calls.Add(1) == 1 {
			return errors.New("pong lost")
		}
		return orig(sess)
	}
	t.Cleanup(func() { barrierPing = orig })

	_ = c1.sess.Close()
	waitFor(t, "tab on guest after the drop", func() bool { return s.src.Load() == e.link.binHub })
	e.link.keepAccountTunnelsWarm() // redial; its barrier ping is "lost"
	waitFor(t, "barrier attempted", func() bool { return calls.Load() >= 1 })
	time.Sleep(80 * time.Millisecond)
	if tn.hub.armedAt.Load() != 0 || tn.hub.committed.Load() || s.src.Load() != e.link.binHub {
		t.Fatal("after a lost pong the tunnel must stay unarmed, uncommitted, with the tab on guest")
	}

	var c2 *fakeConn
	waitFor(t, "redialled conn", func() bool {
		for i := 1; i < e.fb.connCount(); i++ {
			if c := e.fb.conn(i); c != c1 && c.lastToken() == "tok" && liveSession(c.sess) {
				c2 = c
				return true
			}
		}
		return false
	})
	tn.lastBarrier.Store(time.Now().Add(-2 * time.Minute).UnixNano())
	e.link.keepAccountTunnelsWarm() // re-arm: 0x3B again + a fresh barrier
	waitFor(t, "re-armed", func() bool { return tn.hub.armedAt.Load() != 0 })
	if c2.subs.Load() < 2 {
		t.Fatalf("the 0x3B was not re-sent (%d received)", c2.subs.Load())
	}
	waitFor(t, "committed after the re-arm", func() bool {
		pushTick(t, c2, "ACC")
		return s.src.Load() == tn.hub
	})
}

// M2: a snapshot arriving right after the pong (no guard time) commits the tunnel.
func TestSnapshotRightAfterThePongCommits(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	e.postSub(t, "tab", "terminal", 100, "tok")
	c := e.fb.connFor(t, 100)
	tn := e.tun("terminal", 100, "tok")
	for tn.hub.armedAt.Load() == 0 {
		time.Sleep(50 * time.Microsecond)
	}
	pushTick(t, c, "SNAPSHOT") // exactly one frame, immediately after the barrier
	waitFor(t, "committed by that single frame", func() bool { return tn.hub.committed.Load() })
	waitFor(t, "tab moved with the snapshot", func() bool { return s.src.Load() == tn.hub })
	waitSymbol(t, s, "SNAPSHOT")
}

// M3: the per-address cap comes from the environment (default 32).
func TestPerIPCapIsConfigurable(t *testing.T) {
	if defaultMaxUncommittedTunnelsPerIP != 32 {
		t.Fatalf("default cap = %d, want 32", defaultMaxUncommittedTunnelsPerIP)
	}
	prevCap, prevNets := maxUncommittedTunnelsPerIP, trustedProxyNets
	t.Cleanup(func() { maxUncommittedTunnelsPerIP, trustedProxyNets = prevCap, prevNets })
	t.Setenv("RTX5_WEB_MAX_UNCOMMITTED_TUNNELS_PER_IP", "2")
	t.Setenv("RTX5_WEB_TRUSTED_PROXY_CIDRS", "")
	configureAccountTunnelLimits()
	if maxUncommittedTunnelsPerIP != 2 || len(trustedProxyNets) != 0 {
		t.Fatalf("cap=%d trusted=%d after configuring", maxUncommittedTunnelsPerIP, len(trustedProxyNets))
	}
	e := newAcctEnv(t)
	for i := 0; i < 5; i++ {
		e.postSub(t, "s"+string(rune('a'+i)), "terminal", int64(100+i), "junk")
	}
	time.Sleep(150 * time.Millisecond)
	n := 0
	e.link.acctMu.RLock()
	for _, tn := range e.link.acct {
		if tn.creatorIP == "192.0.2.1" && !tn.hub.committed.Load() {
			n++
		}
	}
	e.link.acctMu.RUnlock()
	if n > 2 {
		t.Fatalf("%d uncommitted tunnels from one address with a cap of 2", n)
	}
}

// M3: X-Forwarded-For / X-Real-IP are believed only from a configured trusted proxy.
func TestForwardedForIsHonouredOnlyFromTrustedProxies(t *testing.T) {
	prev := trustedProxyNets
	t.Cleanup(func() { trustedProxyNets = prev })
	trustedProxyNets, _ = parseTrustedProxyCIDRs("10.0.0.0/8, 192.0.2.7")
	mk := func(peer, xff, real string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/x", nil)
		r.RemoteAddr = peer
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		if real != "" {
			r.Header.Set("X-Real-IP", real)
		}
		return r
	}
	cases := []struct {
		name string
		r    *http.Request
		want string
	}{
		{"trusted proxy, client in XFF", mk("10.1.1.1:5", "203.0.113.7", ""), "203.0.113.7"},
		{"chain: right-most untrusted entry", mk("10.1.1.1:5", "198.51.100.9, 203.0.113.7, 10.2.2.2", ""), "203.0.113.7"},
		{"single-IP entry trusted", mk("192.0.2.7:5", "203.0.113.8", ""), "203.0.113.8"},
		{"trusted proxy, only X-Real-IP", mk("10.1.1.1:5", "", "203.0.113.9"), "203.0.113.9"},
		{"untrusted peer: XFF ignored", mk("198.51.100.20:5", "203.0.113.7", "203.0.113.9"), "198.51.100.20"},
		{"trusted peer, garbage XFF: peer", mk("10.1.1.1:5", "not-an-ip", ""), "10.1.1.1"},
	}
	for _, c := range cases {
		if got := remoteIP(c.r); got != c.want {
			t.Errorf("%s: remoteIP = %q, want %q", c.name, got, c.want)
		}
	}
	trustedProxyNets = nil // default: never trusted
	if got := remoteIP(mk("10.1.1.1:5", "203.0.113.7", "")); got != "10.1.1.1" {
		t.Errorf("with no trusted proxies remoteIP = %q, want the peer", got)
	}
}

// L1: the re-creation backoff grows 10 s -> 20 s -> 40 s -> 60 s (cap) while the tunnel never commits.
func TestRecreateBackoffGrows(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	e.loginTab(t, s, 100, "tok", "ACC")
	key := makeAccountKey(rtx5tcp.RoleTraderTerminalClient, 100, "tok")
	drop := func() {
		tn := e.link.lookupAcct(key)
		if tn == nil {
			return
		}
		e.link.acctMu.Lock()
		delete(e.link.acct, key)
		e.link.acctMu.Unlock()
		e.link.dropTunnels([]*accountTunnel{tn})
	}
	delay := func() time.Duration {
		e.link.srcMu.RLock()
		defer e.link.srcMu.RUnlock()
		return e.link.retry[key].delay
	}
	drop()
	now := time.Now()
	e.link.recreateClaimedTunnels(now) // first sighting
	at := now
	for i, want := range []time.Duration{20 * time.Second, 40 * time.Second, 60 * time.Second, 60 * time.Second} {
		wait := map[int]time.Duration{0: 10 * time.Second, 1: 20 * time.Second, 2: 40 * time.Second, 3: 60 * time.Second}[i]
		e.link.recreateClaimedTunnels(at.Add(wait - time.Second))
		if e.link.lookupAcct(key) != nil {
			t.Fatalf("attempt %d: recreated before its backoff of %v", i, wait)
		}
		at = at.Add(wait + time.Second)
		e.link.recreateClaimedTunnels(at)
		if e.link.lookupAcct(key) == nil {
			t.Fatalf("attempt %d: not recreated after %v", i, wait)
		}
		if got := delay(); got != want {
			t.Fatalf("attempt %d: next delay %v, want %v", i, got, want)
		}
		drop() // the recreated tunnel never commits and is closed again
	}
}

// L5: retiring a link moves the tabs that sat on its account hubs onto the guest source.
func TestRetiringALinkMovesItsTabs(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	c := e.loginTab(t, s, 100, "tok", "ACC")
	if s.src.Load() == e.link.binHub {
		t.Fatal("setup: tab should be on its account hub")
	}
	e.link.retire()
	waitFor(t, "tab moved to the guest source", func() bool { return s.src.Load() == e.link.binHub })
	waitFor(t, "account tunnel closed", func() bool { return !liveSession(c.sess) })
	e.link.acctMu.RLock()
	n := len(e.link.acct)
	e.link.acctMu.RUnlock()
	if n != 0 {
		t.Fatalf("%d account tunnels left on a retired link", n)
	}
}

// 1: consecutive re-arms that do not commit back off 3 -> 6 -> 12 -> 30 -> 60 s (cap); a commit resets it.
func TestRearmBacksOffAndResetsOnCommit(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	e.postSub(t, "tab", "terminal", 100, "tok")
	c := e.fb.connFor(t, 100)
	tn := e.tun("terminal", 100, "tok")
	waitFor(t, "barrier passed", func() bool { return tn.hub.armedAt.Load() != 0 })

	// age: how long ago the last barrier attempt was. Due only once age reaches the current delay.
	rearm := func(age time.Duration) {
		tn.lastBarrier.Store(time.Now().Add(-age).UnixNano())
		e.link.keepAccountTunnelsWarm()
	}
	for i, delay := range []time.Duration{3 * time.Second, 6 * time.Second, 12 * time.Second, 30 * time.Second, 60 * time.Second, 60 * time.Second} {
		before := c.subs.Load()
		rearm(delay - time.Second) // not yet due
		time.Sleep(60 * time.Millisecond)
		if c.subs.Load() != before {
			t.Fatalf("step %d: re-armed %v early (delay %v)", i, delay-time.Second, delay)
		}
		rearm(delay + time.Second) // due
		waitFor(t, "0x3B re-sent", func() bool { return c.subs.Load() == before+1 })
		waitFor(t, "barrier passed again", func() bool { return tn.hub.armedAt.Load() != 0 })
		if got := tn.rearms.Load(); int(got) != i+1 {
			t.Fatalf("step %d: consecutive re-arms = %d, want %d", i, got, i+1)
		}
	}
	// A commit resets the backoff.
	waitFor(t, "committed", func() bool {
		pushTick(t, c, "ACC")
		return s.src.Load() == tn.hub
	})
	if tn.rearms.Load() != 0 {
		t.Fatalf("commit must reset the re-arm backoff, got %d", tn.rearms.Load())
	}
}

// 1: a tunnel that stays uncommitted for more than 5 minutes with no authenticating 0x3A is closed.
func TestTunnelUncommittedForFiveMinutesIsClosed(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	c := e.loginTab(t, s, 100, "tok", "ACC") // it committed before
	tn := e.tun("terminal", 100, "tok")
	_ = c.sess.Close()
	waitFor(t, "down", func() bool { return !tn.live() && !tn.hub.committed.Load() })
	waitFor(t, "uncommitted since set", func() bool { return tn.uncommittedSince.Load() != 0 })

	e.link.pruneAccountTunnels(time.Now().Add(accountTunnelStuckTimeout - time.Minute))
	if e.tun("terminal", 100, "tok") == nil {
		t.Fatal("must not close before the stuck timeout")
	}
	e.link.pruneAccountTunnels(time.Now().Add(accountTunnelStuckTimeout + time.Minute))
	if e.tun("terminal", 100, "tok") != nil {
		t.Fatal("a tunnel uncommitted for more than 5 minutes must be closed")
	}
}

// 1 (exemption): an authenticated tunnel is not closed by the stuck rule.
func TestAuthenticatedUncommittedTunnelIsNotClosedAsStuck(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	e.postSub(t, "tab", "terminal", 100, "tok")
	c := e.fb.connFor(t, 100)
	tn := e.tun("terminal", 100, "tok")
	pushEvent(t, c, tradeEventPayload(100, 1)) // proves the token
	waitFor(t, "authed", func() bool { return tn.hub.authed.Load() })
	_ = s
	tn.everCommitted.Store(true) // past the 10 s rule
	e.link.pruneAccountTunnels(time.Now().Add(accountTunnelStuckTimeout + time.Minute))
	if e.tun("terminal", 100, "tok") == nil {
		t.Fatal("a tunnel with an authenticating 0x3A must not be closed as stuck")
	}
}

// 2: a re-arm that was queued while the tunnel committed must not uncommit it.
func TestResendAfterCommitDoesNotUncommit(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab", "terminal")
	c := e.loginTab(t, s, 100, "tok", "ACC")
	tn := e.tun("terminal", 100, "tok")
	before := c.subs.Load()
	tn.resend()
	time.Sleep(80 * time.Millisecond)
	if !tn.hub.committed.Load() || s.src.Load() != tn.hub {
		t.Fatal("resend uncommitted a committed tunnel")
	}
	if c.subs.Load() != before {
		t.Fatal("resend wrote a 0x3B on a committed tunnel")
	}
}

// 4: a fresh dial's own 0x3B is not followed by a duplicate re-arm.
func TestFreshDialGetsNoDuplicateRearm(t *testing.T) {
	e := newAcctEnv(t)
	e.postSub(t, "tab", "terminal", 100, "tok")
	c := e.fb.connFor(t, 100)
	tn := e.tun("terminal", 100, "tok")
	waitFor(t, "barrier passed", func() bool { return tn.hub.armedAt.Load() != 0 })
	e.link.keepAccountTunnelsWarm()
	e.link.keepAccountTunnelsWarm()
	time.Sleep(80 * time.Millisecond)
	if n := c.subs.Load(); n != 1 {
		t.Fatalf("0x3B received %d times on a fresh tunnel, want 1", n)
	}
}

// 3: multi-line X-Forwarded-For, ports, IPv4-mapped IPv6 and IPv6 /64 keys.
func TestRemoteIPParsingAndNormalisation(t *testing.T) {
	prev := trustedProxyNets
	t.Cleanup(func() { trustedProxyNets = prev })
	trustedProxyNets, _ = parseTrustedProxyCIDRs("10.0.0.0/8, 2001:db8:ffff::/48")
	mk := func(peer string, xff []string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/x", nil)
		r.RemoteAddr = peer
		for _, l := range xff {
			r.Header.Add("X-Forwarded-For", l)
		}
		return r
	}
	cases := []struct {
		name string
		r    *http.Request
		want string
	}{
		{"several header lines, last line first", mk("10.1.1.1:5", []string{"198.51.100.1", "203.0.113.7, 10.2.2.2"}), "203.0.113.7"},
		{"client in an earlier line when the last is a proxy", mk("10.1.1.1:5", []string{"203.0.113.7", "10.3.3.3"}), "203.0.113.7"},
		{"port stripped", mk("10.1.1.1:5", []string{"203.0.113.7:5678"}), "203.0.113.7"},
		{"bracketed IPv6 with port", mk("10.1.1.1:5", []string{"[2001:db8:1:2:3:4:5:6]:80"}), "2001:db8:1:2::/64"},
		{"IPv4-mapped IPv6 is IPv4", mk("10.1.1.1:5", []string{"::ffff:203.0.113.7"}), "203.0.113.7"},
		{"IPv6 client keyed by /64", mk("10.1.1.1:5", []string{"2001:db8:1:2:aaaa:bbbb:cccc:dddd"}), "2001:db8:1:2::/64"},
		{"two hosts of one /64 share a key", mk("10.1.1.1:5", []string{"2001:db8:1:2:1::1"}), "2001:db8:1:2::/64"},
		{"untrusted IPv6 peer keyed by /64, port and brackets stripped", mk("[2001:db8:9:9:1:2:3:4]:443", nil), "2001:db8:9:9::/64"},
		{"untrusted IPv4-mapped peer", mk("[::ffff:198.51.100.20]:443", nil), "198.51.100.20"},
	}
	for _, c := range cases {
		if got := remoteIP(c.r); got != c.want {
			t.Errorf("%s: remoteIP = %q, want %q", c.name, got, c.want)
		}
	}
	if _, invalid := parseTrustedProxyCIDRs("10.0.0.0/8, bogus, 192.0.2.300"); len(invalid) != 2 {
		t.Errorf("invalid entries = %v, want 2", invalid)
	}
}
