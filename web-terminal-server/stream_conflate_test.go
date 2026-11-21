package main

import (
	"fmt"
	"runtime"
	"sync"
	"testing"

	rtx5tcp "rtx5-tcp-protocol"
)

func seqTickFrame(sym string, seq uint64) []byte {
	return wrapWebBinaryFrame(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.EncodeBinaryTickBatch([]rtx5tcp.BinaryTick{{Symbol: sym, Bid: float64(seq), Ask: float64(seq) + 1, Sequence: seq}}))
}

// tickSink records, per symbol, the ticks a client would receive, and fails on any older-after-newer delivery.
type tickSink struct {
	t     *testing.T
	last  map[string]uint64
	count int
}

func newTickSink(t *testing.T) *tickSink { return &tickSink{t: t, last: map[string]uint64{}} }

func (k *tickSink) write(p []byte) error {
	if len(p) < 4 || p[0] != rtx5tcp.FrameBinaryTickBatch {
		return nil
	}
	ticks, err := rtx5tcp.DecodeBinaryTickBatch(p[4:])
	if err != nil {
		k.t.Errorf("bad frame: %v", err)
		return nil
	}
	for _, tk := range ticks {
		if prev, ok := k.last[tk.Symbol]; ok && tk.Sequence <= prev {
			k.t.Errorf("%s: tick %d delivered after %d", tk.Symbol, tk.Sequence, prev)
		}
		k.last[tk.Symbol] = tk.Sequence
		k.count++
	}
	return nil
}

func newConflatingSub(chCap int) (*webBinaryMarketHub, *webBinaryStreamSub) {
	hub := newWebBinaryMarketHub()
	sub := &webBinaryStreamSub{prioCh: make(chan []byte, 4), ch: make(chan []byte, chCap), pend: newTickConflator()}
	hub.subs[sub] = struct{}{}
	sub.src.Store(hub)
	return hub, sub
}

func TestSlowConsumerConflatesTicksWithoutDrops(t *testing.T) {
	hub, sub := newConflatingSub(8)
	drops := webStreamMarketFramesDropped.Load()
	conflated := webStreamTickFramesConflated.Load()
	const symbols, total = 20, 10000
	latest := map[string]uint64{}
	sink := newTickSink(t)
	for i := 1; i <= total; i++ {
		sym := fmt.Sprintf("SYM%02d", i%symbols)
		latest[sym] = uint64(i)
		hub.broadcastMarketPacket(seqTickFrame(sym, uint64(i)))
		if i%2500 == 0 { // the client wakes up now and then
			if err := sub.flushConflated(&conflateScratch{}, sink.write, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	if got := webStreamMarketFramesDropped.Load() - drops; got != 0 {
		t.Fatalf("market drops = %d, want 0", got)
	}
	if sub.needResync.Load() {
		t.Fatal("conflated ticks must not request a resync")
	}
	if webStreamTickFramesConflated.Load() == conflated {
		t.Fatal("expected conflated frames to be counted")
	}
	if err := sub.flushConflated(&conflateScratch{}, sink.write, nil); err != nil {
		t.Fatal(err)
	}
	for sym, want := range latest {
		if sink.last[sym] != want {
			t.Fatalf("%s: latest delivered %d, want %d", sym, sink.last[sym], want)
		}
	}
	if len(sub.ch) != 0 || sub.pend.has.Load() || len(sub.pend.m) != 0 {
		t.Fatal("queue and pending map must be empty after the drain")
	}
	if sink.count >= total {
		t.Fatalf("expected conflation to reduce deliveries, got %d", sink.count)
	}
}

func TestSlowConsumerConcurrentOrderIsMonotonic(t *testing.T) {
	hub, sub := newConflatingSub(8)
	drops := webStreamMarketFramesDropped.Load()
	const symbols, total = 20, 20000
	sink := newTickSink(t)
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // the writer: flush when something is pending, and also read ch directly like the select loop
		defer wg.Done()
		var sc conflateScratch
		for {
			select {
			case <-done:
				return
			default:
			}
			if sub.pend.has.Load() {
				_ = sub.flushConflated(&sc, sink.write, nil)
			} else {
				select {
				case p := <-sub.ch:
					_ = sink.write(p)
				default:
					runtime.Gosched()
				}
			}
		}
	}()
	latest := make([]uint64, symbols)
	for i := 1; i <= total; i++ {
		latest[i%symbols] = uint64(i)
		hub.broadcastMarketPacket(seqTickFrame(fmt.Sprintf("SYM%02d", i%symbols), uint64(i)))
	}
	close(done)
	wg.Wait()
	_ = sub.flushConflated(&conflateScratch{}, sink.write, nil)
	for len(sub.ch) > 0 { // anything left in ch
		_ = sink.write(<-sub.ch)
	}
	for i := 0; i < symbols; i++ {
		if got := sink.last[fmt.Sprintf("SYM%02d", i)]; got != latest[i] {
			t.Fatalf("SYM%02d: latest delivered %d, want %d", i, got, latest[i])
		}
	}
	if got := webStreamMarketFramesDropped.Load() - drops; got != 0 {
		t.Fatalf("market drops = %d, want 0", got)
	}
}

func TestFastConsumerDeliversEveryTickInOrder(t *testing.T) {
	hub, sub := newConflatingSub(2048)
	conflated := webStreamTickFramesConflated.Load()
	drops := webStreamMarketFramesDropped.Load()
	for i := 1; i <= 1000; i++ {
		hub.broadcastMarketPacket(seqTickFrame("EURUSD", uint64(i)))
		if sub.pend.has.Load() {
			t.Fatal("nothing may go pending while the queue has room")
		}
	}
	sink := newTickSink(t)
	for len(sub.ch) > 0 {
		_ = sink.write(<-sub.ch)
	}
	if sink.count != 1000 || sink.last["EURUSD"] != 1000 {
		t.Fatalf("delivered %d ticks, last %d", sink.count, sink.last["EURUSD"])
	}
	if webStreamTickFramesConflated.Load() != conflated || webStreamMarketFramesDropped.Load() != drops {
		t.Fatal("fast path must not conflate or drop")
	}
}

func TestNonTickFrameOnFullQueueIsStillDroppedWithResync(t *testing.T) {
	hub, sub := newConflatingSub(1)
	hub.broadcastMarketPacket(seqTickFrame("A", 1)) // fills ch
	drops := webStreamMarketFramesDropped.Load()
	hub.broadcastMarketPacket(wrapWebBinaryFrame(rtx5tcp.FrameBinaryCandleBatch, make([]byte, 72)))
	if webStreamMarketFramesDropped.Load()-drops != 1 || !sub.needResync.Load() {
		t.Fatal("a non-tick frame on a full queue must be dropped and request a resync")
	}
	if sub.pend.has.Load() {
		t.Fatal("non-tick frames are never conflated")
	}
}

func TestResyncSupersedesPendingTicks(t *testing.T) {
	hub, sub := newConflatingSub(1)
	hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.EncodeBinaryTickBatch([]rtx5tcp.BinaryTick{{Symbol: "A", Bid: 1, Sequence: 1}}))
	hub.handleControlFrame(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.EncodeBinaryTickBatch([]rtx5tcp.BinaryTick{{Symbol: "A", Bid: 2, Sequence: 2}})) // pending
	if !sub.pend.has.Load() {
		t.Fatal("tick should be pending")
	}
	sub.needResync.Store(true)
	pkts := sub.resyncPackets()
	if pkts == nil || sub.pend.has.Load() || len(sub.pend.m) != 0 {
		t.Fatal("resync must clear the pending ticks")
	}
	if got := decodeTicks(t, pkts)["A"]; got != 2 {
		t.Fatalf("snapshot must carry the latest tick, got %v", got)
	}
}

func TestPendingTicksFromOldSourceAreDiscarded(t *testing.T) {
	hub, sub := newConflatingSub(1)
	other := newWebBinaryMarketHub()
	hub.broadcastMarketPacket(seqTickFrame("A", 1))
	hub.broadcastMarketPacket(seqTickFrame("A", 2)) // pending, tagged with hub
	sub.src.Store(other)                            // tab moved to another source
	sink := newTickSink(t)
	_ = sub.flushConflated(&conflateScratch{}, sink.write, nil)
	if sink.last["A"] != 1 {
		t.Fatalf("pending tick of the old source must not be delivered, got %v", sink.last)
	}
}

func TestPendingMapIsBounded(t *testing.T) {
	c := newTickConflator()
	ticks := make([]rtx5tcp.BinaryTick, 0, 5000)
	for i := 0; i < 5000; i++ {
		ticks = append(ticks, rtx5tcp.BinaryTick{Symbol: fmt.Sprintf("X%04d", i), Sequence: 1})
	}
	lost := c.put(rtx5tcp.EncodeBinaryTickBatch(ticks), nil)
	if len(c.m) != maxPendingTickSymbols || lost != 5000-maxPendingTickSymbols {
		t.Fatalf("map=%d lost=%d", len(c.m), lost)
	}
	c.discard()
	if len(c.m) != 0 || c.has.Load() {
		t.Fatal("discard must empty the map")
	}
}
