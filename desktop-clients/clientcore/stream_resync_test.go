package clientcore

import (
	"net"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func localTick(sym string, bid float64) []byte {
	return rtx5tcp.EncodeBinaryTickBatch([]rtx5tcp.BinaryTick{{Symbol: sym, Bid: bid, Ask: bid + 1, TimestampMs: time.Now().UnixMilli()}})
}

func TestLocalStreamOverflowResyncsLatestTicks(t *testing.T) {
	hub := newClientBinaryMarketHub()
	sub := &localBinaryStreamSub{prioCh: make(chan []byte, 4), ch: make(chan []byte, 3)}
	hub.subs[sub] = struct{}{}

	if hub.resyncPackets(sub) != nil {
		t.Fatal("no resync expected before a drop")
	}
	hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, localTick("QUIET", 1)) // stale in queue
	hub.handleControlFrame(rtx5tcp.FrameBinaryCandleBatch, make([]byte, 72))    // kept
	hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, localTick("BUSY", 5))
	if sub.needResync.Load() {
		t.Fatal("flag set without a drop")
	}
	hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, localTick("QUIET", 2)) // newest, dropped
	if !sub.needResync.Load() {
		t.Fatal("overflow must set needResync")
	}
	pkts := hub.resyncPackets(sub)
	if pkts == nil || len(sub.ch) != 0 {
		t.Fatalf("expected resync with an emptied queue, pkts=%v left=%d", pkts != nil, len(sub.ch))
	}
	got := map[string]float64{}
	candles := 0
	for _, p := range pkts {
		switch p[0] {
		case rtx5tcp.FrameBinaryTickBatch:
			ticks, err := rtx5tcp.DecodeBinaryTickBatch(p[4:])
			if err != nil {
				t.Fatal(err)
			}
			for _, tk := range ticks {
				got[tk.Symbol] = tk.Bid
			}
		case rtx5tcp.FrameBinaryCandleBatch:
			candles++
		}
	}
	if got["QUIET"] != 2 || got["BUSY"] != 5 || candles != 1 {
		t.Fatalf("snapshot wrong: ticks=%v candles=%d", got, candles)
	}
	if sub.needResync.Load() || hub.resyncPackets(sub) != nil {
		t.Fatal("flag must clear")
	}
}

type pingLost string

func (p pingLost) Error() string { return string(p) }

// A failed keep-alive ping closes the session (so getOrDialSession redials); a good ping or a silent market does not.
func TestFailedKeepAlivePingClosesSession(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		raw, err := ln.Accept()
		if err != nil {
			return
		}
		tc, err := rtx5tcp.AcceptTunnel(raw, 5*time.Second)
		if err != nil {
			return
		}
		_ = rtx5tcp.NewMuxSession(tc, true, nil, nil).ServeLoop()
	}()
	tc, err := rtx5tcp.DialTunnel(ln.Addr().String(), rtx5tcp.RoleTraderTerminalClient, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	sess := rtx5tcp.NewMuxSession(tc, false, nil, nil)
	go func() { _ = sess.ServeLoop() }()
	defer sess.Close()

	if _, err := pingOrCloseSession(sess, time.Second); err != nil {
		t.Fatalf("healthy ping: %v", err)
	}
	select {
	case <-sess.Done():
		t.Fatal("healthy session must stay open")
	default:
	}
	prev := keepAlivePing
	defer func() { keepAlivePing = prev }()
	keepAlivePing = func(*rtx5tcp.MuxSession, time.Duration) (float64, error) { return 0, pingLost("pong timeout") }
	if _, err := pingOrCloseSession(sess, time.Second); err == nil {
		t.Fatal("want error")
	}
	select {
	case <-sess.Done():
	default:
		t.Fatal("failed ping must close the session")
	}
}

// The order session closes only after 2 consecutive failed pings; a success resets the count.
func TestOrderPingStrikesClosesOnlyAfterConsecutiveFailures(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		raw, err := ln.Accept()
		if err != nil {
			return
		}
		tc, err := rtx5tcp.AcceptTunnel(raw, 5*time.Second)
		if err != nil {
			return
		}
		_ = rtx5tcp.NewMuxSession(tc, true, nil, nil).ServeLoop()
	}()
	tc, err := rtx5tcp.DialTunnel(ln.Addr().String(), rtx5tcp.RoleTraderTerminalClient, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	sess := rtx5tcp.NewMuxSession(tc, false, nil, nil)
	go func() { _ = sess.ServeLoop() }()
	defer sess.Close()
	open := func() bool {
		select {
		case <-sess.Done():
			return false
		default:
			return true
		}
	}
	prev := keepAlivePing
	defer func() { keepAlivePing = prev }()
	fail := func(*rtx5tcp.MuxSession, time.Duration) (float64, error) { return 0, pingLost("pong timeout") }
	var p pingStrikes

	keepAlivePing = fail
	if _, err := p.ping(sess, time.Second, orderPingFailLimit); err == nil {
		t.Fatal("want error")
	}
	if !open() {
		t.Fatal("one failed ping must not close the order session")
	}
	keepAlivePing = prev
	if _, err := p.ping(sess, time.Second, orderPingFailLimit); err != nil {
		t.Fatal(err)
	}
	keepAlivePing = fail
	_, _ = p.ping(sess, time.Second, orderPingFailLimit)
	if !open() {
		t.Fatal("a success in between must reset the failure count")
	}
	_, _ = p.ping(sess, time.Second, orderPingFailLimit)
	if open() {
		t.Fatal("two consecutive failed pings must close the order session")
	}
}

// At most one snapshot resync per second per stream; the flag stays set until the next allowed turn.
func TestLocalResyncIsRateLimited(t *testing.T) {
	hub := newClientBinaryMarketHub()
	sub := &localBinaryStreamSub{prioCh: make(chan []byte, 4), ch: make(chan []byte, 4)}
	hub.subs[sub] = struct{}{}
	sub.needResync.Store(true)
	if hub.resyncPackets(sub) == nil {
		t.Fatal("first resync must run")
	}
	sub.needResync.Store(true)
	if hub.resyncPackets(sub) != nil || !sub.needResync.Load() {
		t.Fatal("a second resync within 1 s must be deferred with the flag kept")
	}
	sub.lastResync -= int64(2 * time.Second)
	if hub.resyncPackets(sub) == nil || sub.needResync.Load() {
		t.Fatal("the deferred resync must run once the gap has passed")
	}
}

func TestActiveMuxPingStrikesMatchesOrderMux(t *testing.T) {
	if activePingFailLimit != 2 {
		t.Fatalf("activePingFailLimit = %d, want 2", activePingFailLimit)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		raw, err := ln.Accept()
		if err != nil {
			return
		}
		tc, err := rtx5tcp.AcceptTunnel(raw, 5*time.Second)
		if err != nil {
			return
		}
		_ = rtx5tcp.NewMuxSession(tc, true, nil, nil).ServeLoop()
	}()
	tc, err := rtx5tcp.DialTunnel(ln.Addr().String(), rtx5tcp.RoleTraderTerminalClient, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	sess := rtx5tcp.NewMuxSession(tc, false, nil, nil)
	go func() { _ = sess.ServeLoop() }()
	defer sess.Close()
	open := func() bool {
		select {
		case <-sess.Done():
			return false
		default:
			return true
		}
	}
	prev := keepAlivePing
	defer func() { keepAlivePing = prev }()
	keepAlivePing = func(*rtx5tcp.MuxSession, time.Duration) (float64, error) { return 0, pingLost("pong timeout") }
	dc := &DesktopClient{}

	if _, err := dc.activeStrikes.ping(sess, time.Second, activePingFailLimit); err == nil {
		t.Fatal("want error on first strike")
	}
	if !open() {
		t.Fatal("activeMux must survive 1 failed ping")
	}
	if _, err := dc.activeStrikes.ping(sess, time.Second, activePingFailLimit); err == nil {
		t.Fatal("want error on second strike")
	}
	if open() {
		t.Fatal("activeMux must close after 2 consecutive failed pings")
	}
}