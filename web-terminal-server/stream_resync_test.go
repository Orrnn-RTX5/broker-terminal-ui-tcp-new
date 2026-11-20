package main

import (
	"bytes"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func tickPayload(sym string, bid float64) []byte {
	return rtx5tcp.EncodeBinaryTickBatch([]rtx5tcp.BinaryTick{{Symbol: sym, Bid: bid, Ask: bid + 1, TimestampMs: time.Now().UnixMilli()}})
}

func decodeTicks(t *testing.T, pkts [][]byte) map[string]float64 {
	t.Helper()
	out := map[string]float64{}
	for _, p := range pkts {
		if len(p) < 4 || p[0] != rtx5tcp.FrameBinaryTickBatch {
			continue
		}
		ticks, err := rtx5tcp.DecodeBinaryTickBatch(p[4:])
		if err != nil {
			t.Fatal(err)
		}
		for _, tk := range ticks {
			out[tk.Symbol] = tk.Bid
		}
	}
	return out
}

// (a) overflow -> the stale queue is discarded and the hub's latest ticks are re-sent.
func TestOverflowResyncsLatestTicksAndDiscardsStaleQueue(t *testing.T) {
	hub := newWebBinaryMarketHub()
	sub := &webBinaryStreamSub{prioCh: make(chan []byte, 4), ch: make(chan []byte, 4)}
	hub.subs[sub] = struct{}{}
	sub.src.Store(hub)

	if got := sub.resyncPackets(); got != nil {
		t.Fatal("no resync expected before any drop")
	}
	dropsBefore := webStreamMarketFramesDropped.Load()

	hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, tickPayload("QUIET", 1)) // queued, will be stale
	hub.handleControlFrame(rtx5tcp.FrameBinaryCandleBatch, make([]byte, 72))      // queued, must survive
	for i := 0; i < 2; i++ {
		hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, tickPayload("BUSY", float64(10+i)))
	}
	if sub.needResync.Load() {
		t.Fatal("flag must not be set while nothing was dropped")
	}
	// Queue is full now: the newest QUIET tick (the one that matters) is dropped.
	hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, tickPayload("QUIET", 2))
	hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, tickPayload("BUSY", 99))
	if !sub.needResync.Load() {
		t.Fatal("overflow must set needResync")
	}
	if webStreamMarketFramesDropped.Load()-dropsBefore != 2 {
		t.Fatalf("drop counter must still count the 2 drops, got %d", webStreamMarketFramesDropped.Load()-dropsBefore)
	}

	pkts := sub.resyncPackets()
	if pkts == nil {
		t.Fatal("expected a resync")
	}
	if len(sub.ch) != 0 {
		t.Fatalf("stale packets must be discarded, %d left", len(sub.ch))
	}
	got := decodeTicks(t, pkts)
	if got["QUIET"] != 2 || got["BUSY"] != 99 {
		t.Fatalf("snapshot must carry the latest ticks, got %v", got)
	}
	candles := 0
	for _, p := range pkts {
		if p[0] == rtx5tcp.FrameBinaryCandleBatch {
			candles++
		}
	}
	if candles != 1 {
		t.Fatalf("queued candle frame must be kept, got %d", candles)
	}
	if sub.needResync.Load() || sub.resyncPackets() != nil {
		t.Fatal("flag must be cleared after the resync")
	}
	// Live frames after the resync flow normally.
	hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, tickPayload("QUIET", 3))
	if len(sub.ch) != 1 {
		t.Fatal("live frame after resync must queue")
	}
}

// (b) a failed ping closes the account tunnel and the existing redial path brings a new one up.
func TestFailedPingClosesAccountTunnelAndItRedials(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab-ping", "")
	c := e.loginTab(t, s, 4242, "tok", "ACC")
	e.commit(t, c, "terminal", 4242, "tok")
	tn := e.tun("terminal", 4242, "tok")
	old := tn.cur.Load()

	prev := keepAlivePing
	t.Cleanup(func() { keepAlivePing = prev })
	keepAlivePing = func(*rtx5tcp.MuxSession, time.Duration) (float64, error) { return 0, errPingLost }
	e.link.keepAccountTunnelsWarm()
	waitFor(t, "tunnel closed by failed ping", func() bool { return !liveSession(old) })
	waitFor(t, "tunnel marked down", func() bool { return tn.cur.Load() == nil })

	keepAlivePing = prev
	conns := e.fb.connCount()
	waitFor(t, "redial", func() bool {
		e.link.keepAccountTunnelsWarm()
		return e.fb.connCount() > conns && tn.live()
	})
	if tn.cur.Load() == old {
		t.Fatal("expected a new session")
	}
}

func TestPingOrCloseKeepsHealthySessionAndIgnoresQuietMarket(t *testing.T) {
	e := newAcctEnv(t)
	sess, err := e.link.getOrDialSession()
	if err != nil {
		t.Fatal(err)
	}
	// No market frame at all (quiet market) with a working ping: stays open.
	if _, err := pingOrClose(sess, time.Second); err != nil {
		t.Fatal(err)
	}
	if !liveSession(sess) {
		t.Fatal("healthy session must stay open")
	}
	prev := keepAlivePing
	t.Cleanup(func() { keepAlivePing = prev })
	keepAlivePing = func(*rtx5tcp.MuxSession, time.Duration) (float64, error) { return 0, errPingLost }
	if _, err := pingOrClose(sess, time.Second); err == nil {
		t.Fatal("want error")
	}
	if liveSession(sess) {
		t.Fatal("failed ping must close the session")
	}
}

type pingErr string

func (p pingErr) Error() string { return string(p) }

const errPingLost = pingErr("ping timeout")

// (c) an identical 0x3B is skipped, unless the committed tunnel has been silent for accountSubRenewQuiet.
func TestIdenticalSubIsRenewedOnlyAfterQuietPeriod(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab-renew", "")
	c := e.loginTab(t, s, 777, "tok", "ACC")
	e.commit(t, c, "terminal", 777, "tok")
	tn := e.tun("terminal", 777, "tok")
	base := c.subs.Load()

	// Fresh market traffic: the identical re-POST is de-duplicated.
	e.postSub(t, "tab-renew", "terminal", 777, "tok")
	time.Sleep(150 * time.Millisecond)
	if c.subs.Load() != base {
		t.Fatalf("identical 0x3B on an active tunnel must be skipped, subs %d -> %d", base, c.subs.Load())
	}

	// Quiet for longer than the renew window: it is written again, without uncommitting the tunnel.
	prev := accountSubRenewQuiet
	t.Cleanup(func() { accountSubRenewQuiet = prev })
	accountSubRenewQuiet = 50 * time.Millisecond
	time.Sleep(80 * time.Millisecond)
	e.postSub(t, "tab-renew", "terminal", 777, "tok")
	waitFor(t, "renewed 0x3B", func() bool { return c.subs.Load() == base+1 })
	if !tn.hub.committed.Load() || s.src.Load() != tn.hub {
		t.Fatal("renewal must not uncommit the tunnel or move the tab")
	}
	// Right after the renewal another identical re-POST is skipped again.
	accountSubRenewQuiet = time.Minute
	e.postSub(t, "tab-renew", "terminal", 777, "tok")
	time.Sleep(100 * time.Millisecond)
	if c.subs.Load() != base+1 {
		t.Fatal("de-dup must resume after a renewal")
	}
}

// (A) renewSub never writes a payload that sendLatest has not sent yet (a tab just posted a new one).
func TestRenewSubNeverWritesChangedPayload(t *testing.T) {
	e := newAcctEnv(t)
	s := e.newSub("tab-renew-race", "")
	c := e.loginTab(t, s, 778, "tok", "ACC")
	e.commit(t, c, "terminal", 778, "tok")
	tn := e.tun("terminal", 778, "tok")
	base := c.subs.Load()

	tn.mu.Lock()
	orig := tn.sub
	tn.sub = append(append([]byte(nil), orig...), 0x7F) // setAccountSub stored a new payload; sendLatest not run yet
	tn.mu.Unlock()
	sent := tn.sentPayload
	for i := 0; i < 4; i++ {
		go tn.renewSub()
	}
	tn.renewSub()
	time.Sleep(150 * time.Millisecond)
	if c.subs.Load() != base {
		t.Fatalf("renewSub wrote a changed 0x3B: subs %d -> %d", base, c.subs.Load())
	}
	tn.sendMu.Lock()
	same := bytes.Equal(tn.sentPayload, sent)
	tn.sendMu.Unlock()
	if !same || !tn.hub.committed.Load() {
		t.Fatal("renewSub must leave sentPayload alone and not uncommit")
	}

	// The unchanged payload (what was sent on this session) is still renewed.
	tn.mu.Lock()
	tn.sub = orig
	tn.mu.Unlock()
	tn.renewSub()
	waitFor(t, "renewal of the sent payload", func() bool { return c.subs.Load() == base+1 })
}

// (B) order / manager / admin sessions close only after 2 consecutive ping failures; a success resets the count.
func TestPingStrikesClosesOnlyAfterConsecutiveFailures(t *testing.T) {
	e := newAcctEnv(t)
	sess, err := e.link.getOrDialSession()
	if err != nil {
		t.Fatal(err)
	}
	prev := keepAlivePing
	t.Cleanup(func() { keepAlivePing = prev })
	fail := func(*rtx5tcp.MuxSession, time.Duration) (float64, error) { return 0, errPingLost }
	var p pingStrikes

	keepAlivePing = fail
	if _, err := p.ping(sess, time.Second, sessionPingFailLimit); err == nil {
		t.Fatal("want error")
	}
	if !liveSession(sess) {
		t.Fatal("one failed ping must not close the session")
	}
	keepAlivePing = prev
	if _, err := p.ping(sess, time.Second, sessionPingFailLimit); err != nil {
		t.Fatal(err)
	}
	keepAlivePing = fail
	_, _ = p.ping(sess, time.Second, sessionPingFailLimit)
	if !liveSession(sess) {
		t.Fatal("a success in between must reset the failure count")
	}
	_, _ = p.ping(sess, time.Second, sessionPingFailLimit)
	if liveSession(sess) {
		t.Fatal("two consecutive failed pings must close the session")
	}
}

// (D) at most one snapshot resync per second per tab; the flag stays set until the next allowed turn.
func TestResyncIsRateLimitedPerTab(t *testing.T) {
	hub := newWebBinaryMarketHub()
	sub := &webBinaryStreamSub{prioCh: make(chan []byte, 4), ch: make(chan []byte, 4)}
	hub.subs[sub] = struct{}{}
	sub.src.Store(hub)

	sub.needResync.Store(true)
	if sub.resyncPackets() == nil {
		t.Fatal("first resync must run")
	}
	sub.needResync.Store(true)
	if sub.resyncPackets() != nil || !sub.needResync.Load() {
		t.Fatal("a second resync within 1 s must be deferred with the flag kept")
	}
	sub.lastResync -= int64(2 * time.Second)
	if sub.resyncPackets() == nil || sub.needResync.Load() {
		t.Fatal("the deferred resync must run once the gap has passed")
	}
}