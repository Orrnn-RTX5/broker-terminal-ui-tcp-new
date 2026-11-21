package clientcore

import (
	"encoding/binary"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

type localBinaryStreamSub struct {
	prioCh chan []byte
	ch     chan []byte
	closed atomic.Bool
	// needResync is set (O(1), only on the drop path) when a market frame for this stream was dropped because ch
	// was full. The writer then discards its stale queue and re-sends the hub's latest tick snapshot.
	needResync atomic.Bool
	// lastResync (unix nanos) is touched by the stream's writer goroutine only: at most one full snapshot resync
	// per localResyncMinGap.
	lastResync int64
	// pend conflates 0x21 tick frames while the stream is backed up (nil = no conflation: ticks on a full queue
	// are dropped as before). Set once at creation, never changed.
	pend *tickConflator
}

// maxPendingTickSymbols bounds a stream's pending map (a source carries a few hundred symbols); a new symbol
// beyond it is lost (resync covers it).
const maxPendingTickSymbols = 4096

// localTickFramesConflated counts 0x21 tick frames merged into the per-symbol pending ticks of a backed-up stream
// instead of being dropped (the newest tick per symbol is still delivered).
var localTickFramesConflated atomic.Uint64

type pendingTick [rtx5tcp.BinaryTickRecordSize]byte

// tickConflator holds, per symbol, the newest 0x21 tick a backed-up stream has not been sent yet. The hub
// broadcast only touches it on the slow path; the writer drains it. has is true while the map is non-empty.
type tickConflator struct {
	has atomic.Bool
	sig chan struct{} // cap 1: wakes the writer when the map goes from empty to non-empty
	mu  sync.Mutex
	m   map[[rtx5tcp.BinarySymbolMaxBytes]byte]pendingTick
}

func newTickConflator() *tickConflator {
	return &tickConflator{sig: make(chan struct{}, 1), m: make(map[[rtx5tcp.BinarySymbolMaxBytes]byte]pendingTick, 64)}
}

// put stores every record of a 0x21 payload ([count u16][count x 48 B]) as its symbol latest tick, overwriting
// an older one, without decoding or allocating. It returns the number of ticks that could not be kept.
func (c *tickConflator) put(payload []byte) (lost int) {
	const rs = rtx5tcp.BinaryTickRecordSize
	if len(payload) < 2 {
		return 1
	}
	n := int(binary.LittleEndian.Uint16(payload[:2]))
	if len(payload) < 2+n*rs {
		return 1
	}
	c.mu.Lock()
	for i := 0; i < n; i++ {
		rec := payload[2+i*rs : 2+(i+1)*rs]
		var key [rtx5tcp.BinarySymbolMaxBytes]byte
		copy(key[:], rec)
		if _, ok := c.m[key]; !ok && len(c.m) >= maxPendingTickSymbols {
			lost++
			continue
		}
		var pt pendingTick
		copy(pt[:], rec)
		c.m[key] = pt
	}
	wake := len(c.m) > 0 && !c.has.Load()
	if wake {
		c.has.Store(true)
	}
	c.mu.Unlock()
	if wake {
		select {
		case c.sig <- struct{}{}:
		default:
		}
	}
	return lost
}

// take appends the pending records to dst and empties the map.
func (c *tickConflator) take(dst []byte) []byte {
	c.mu.Lock()
	for _, v := range c.m {
		dst = append(dst, v[:]...)
	}
	clear(c.m)
	c.has.Store(false)
	c.mu.Unlock()
	return dst
}

// discard empties the map (stream closed, or a resync snapshot that supersedes the pending ticks).
func (c *tickConflator) discard() {
	if c == nil {
		return
	}
	c.mu.Lock()
	clear(c.m)
	c.has.Store(false)
	c.mu.Unlock()
}

const localConflateInterval = 16 * time.Millisecond

// conflateScratch holds the writer reusable buffers for flushConflated.
type conflateScratch struct {
	recs  []byte
	frame []byte
}

// flushConflated is the writer drain of a backed-up stream. It first writes the market frames already queued in
// ch (a snapshot of its length: they are older than every pending tick, because a symbol only becomes pending
// once ch is full and then stays pending), calling between every 32 packets, and then the pending ticks as
// 0x21 frames of up to 64 ticks. Writing the queue first and the pending map second is what keeps each symbol
// ticks in order.
func (s *localBinaryStreamSub) flushConflated(sc *conflateScratch, write func([]byte) error, between func() error) error {
	for n := len(s.ch); n > 0; n-- {
		select {
		case pkt := <-s.ch:
			if err := write(pkt); err != nil {
				return err
			}
		default:
			n = 0
		}
		if between != nil && n%32 == 0 {
			if err := between(); err != nil {
				return err
			}
		}
	}
	const rs = rtx5tcp.BinaryTickRecordSize
	sc.recs = s.pend.take(sc.recs[:0])
	for recs := sc.recs; len(recs) > 0; {
		k := len(recs) / rs
		if k > 64 {
			k = 64
		}
		f := sc.frame[:0]
		f = append(f, rtx5tcp.FrameBinaryTickBatch, 0, 0, 0, 0, 0)
		binary.LittleEndian.PutUint16(f[2:4], uint16(2+k*rs))
		binary.LittleEndian.PutUint16(f[4:6], uint16(k))
		f = append(f, recs[:k*rs]...)
		sc.frame = f
		if err := write(f); err != nil {
			return err
		}
		recs = recs[k*rs:]
	}
	return nil
}

type clientBinaryMarketHub struct {
	mu          sync.RWMutex
	latestTicks map[string]rtx5tcp.BinaryTick
	subs        map[*localBinaryStreamSub]struct{}
	framesRx    atomic.Uint64
}

func newClientBinaryMarketHub() *clientBinaryMarketHub {
	return &clientBinaryMarketHub{
		latestTicks: make(map[string]rtx5tcp.BinaryTick, 256),
		subs:        make(map[*localBinaryStreamSub]struct{}),
	}
}

func wrapLocalBinaryFrame(frameType uint8, payload []byte) []byte {
	n := len(payload)
	if n > 65535 {
		return nil
	}
	pkt := make([]byte, 4+n)
	pkt[0] = frameType
	pkt[1] = 0
	binary.LittleEndian.PutUint16(pkt[2:4], uint16(n))
	copy(pkt[4:], payload)
	return pkt
}

func (h *clientBinaryMarketHub) handleControlFrame(frameType uint8, payload []byte) {
	if len(payload) == 0 {
		return
	}
	switch frameType {
	case rtx5tcp.FrameBinaryTickBatch:
		ticks, err := rtx5tcp.DecodeBinaryTickBatch(payload)
		if err == nil && len(ticks) > 0 {
			h.mu.Lock()
			for _, t := range ticks {
				h.latestTicks[t.Symbol] = t
			}
			h.mu.Unlock()
		}
		h.framesRx.Add(1)
		h.broadcastPacket(wrapLocalBinaryFrame(rtx5tcp.FrameBinaryTickBatch, payload))

	case rtx5tcp.FrameBinaryCandleBatch:
		h.framesRx.Add(1)
		h.broadcastPacket(wrapLocalBinaryFrame(rtx5tcp.FrameBinaryCandleBatch, payload))

	case rtx5tcp.FrameBinaryTradeEvent:
		h.framesRx.Add(1)
		h.broadcastPacket(wrapLocalBinaryFrame(rtx5tcp.FrameBinaryTradeEvent, payload))
	}
}

func (h *clientBinaryMarketHub) broadcastPacket(pkt []byte) {
	if len(pkt) == 0 {
		return
	}
	frameType := pkt[0]
	isTick := frameType == rtx5tcp.FrameBinaryTickBatch && len(pkt) >= 4
	h.mu.RLock()
	if len(h.subs) == 0 {
		h.mu.RUnlock()
		return
	}
	subs := make([]*localBinaryStreamSub, 0, len(h.subs))
	for s := range h.subs {
		subs = append(subs, s)
	}
	h.mu.RUnlock()

	for _, s := range subs {
		if s.closed.Load() {
			continue
		}
		if frameType == rtx5tcp.FrameBinaryTradeEvent && s.prioCh != nil {
			select {
			case s.prioCh <- pkt:
			default:
				select {
				case <-s.prioCh:
				default:
				}
				select {
				case s.prioCh <- pkt:
				default:
				}
			}
			continue
		}
		// Backed-up stream (some tick is pending): every tick goes to the per-symbol pending map until the writer
		// has drained it, so a symbol's ticks can never overtake its older pending one. One atomic load otherwise.
		if isTick && s.pend != nil && s.pend.has.Load() {
			s.conflateTick(pkt)
			continue
		}
		select {
		case s.ch <- pkt:
		default:
			if isTick && s.pend != nil {
				s.conflateTick(pkt)
				continue
			}
			s.needResync.Store(true)
		}
	}
}

// conflateTick stores the ticks of a 0x21 frame as the latest pending tick of their symbols (slow path only).
// Ticks that cannot be kept (malformed frame, pending map full) request a resync.
func (s *localBinaryStreamSub) conflateTick(pkt []byte) {
	if lost := s.pend.put(pkt[4:]); lost > 0 {
		s.needResync.Store(true)
	}
	localTickFramesConflated.Add(1)
}

func (h *clientBinaryMarketHub) clearCache() {
	h.mu.Lock()
	h.latestTicks = make(map[string]rtx5tcp.BinaryTick, 256)
	h.mu.Unlock()
}

// resyncPackets answers an overflow of the stream's queue (needResync): it discards the stale queued packets
// (queued 0x22 candle frames are kept, the hub caches none) and returns the hub's latest tick snapshot followed by
// the kept candles. The queue is emptied first and the snapshot taken after, so whatever is queued afterwards is
// at least as new as the snapshot (the hub caches a tick before it fans it out). nil when nothing is pending.
func (h *clientBinaryMarketHub) resyncPackets(s *localBinaryStreamSub) [][]byte {
	if !s.needResync.Load() {
		return nil
	}
	if time.Now().UnixNano()-s.lastResync < int64(localResyncMinGap) {
		return nil // too soon: needResync stays set, the writer retries on its resync timer
	}
	s.lastResync = time.Now().UnixNano()
	s.needResync.Store(false)
	var keep [][]byte
	for n := len(s.ch); n > 0; n-- {
		select {
		case pkt := <-s.ch:
			if len(pkt) > 0 && pkt[0] == rtx5tcp.FrameBinaryCandleBatch {
				keep = append(keep, pkt)
			}
		default:
			n = 0
		}
	}
	// Discard the pending ticks BEFORE taking the snapshot: every discarded tick is already in latestTicks, and a
	// tick pended after this point is sent after the snapshot (at worst a harmless repeat). Discarding after the
	// snapshot could drop a tick that reached latestTicks too late for it.
	s.pend.discard()
	h.mu.RLock()
	snaps := make([]rtx5tcp.BinaryTick, 0, len(h.latestTicks))
	for _, bt := range h.latestTicks {
		snaps = append(snaps, bt)
	}
	h.mu.RUnlock()
	out := make([][]byte, 0, len(snaps)/64+1+len(keep))
	const chunk = 64
	for start := 0; start < len(snaps); start += chunk {
		end := min(start+chunk, len(snaps))
		if pkt := wrapLocalBinaryFrame(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.EncodeBinaryTickBatch(snaps[start:end])); len(pkt) > 0 {
			out = append(out, pkt)
		}
	}
	return append(out, keep...)
}

// A stalled write to the local webview stream is cut after this long without progress; the deadline is pushed
// forward while the writer is active, so a slow but draining reader is never disconnected.
const (
	localStreamWriteDeadline        = 45 * time.Second
	localStreamWriteDeadlineRefresh = 5 * time.Second
	localResyncMinGap               = time.Second
	localStreamMaxPrioBurst         = 24
	localStreamMaxMarketBurst       = 32
)

func (c *DesktopClient) handleServerControlFrame(_ *rtx5tcp.MuxSession, frameType uint8, _ uint32, _ uint8, payload []byte) {
	if c.binHub != nil {
		c.binHub.handleControlFrame(frameType, payload)
	}
}

// serveLocalBinaryMarketStream streams raw fixed-width 48-byte BinaryTicks (0x21) and 64-byte BinaryCandles (0x22)
// directly into WebView2 / Chromium ReadableStreamDefaultReader<Uint8Array> with ZERO WebSockets and ZERO JSON.
func (c *DesktopClient) serveLocalBinaryMarketStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok || c.binHub == nil {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// Ensure Binary TCP tunnel to :4443 is dialed
	_, _ = c.getOrDialSession()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	sub := &localBinaryStreamSub{
		prioCh: make(chan []byte, 512),
		ch:     make(chan []byte, 2048),
		pend:   newTickConflator(),
	}

	c.binHub.mu.Lock()
	c.binHub.subs[sub] = struct{}{}
	snaps := make([]rtx5tcp.BinaryTick, 0, len(c.binHub.latestTicks))
	for _, bt := range c.binHub.latestTicks {
		snaps = append(snaps, bt)
	}
	c.binHub.mu.Unlock()

	defer func() {
		sub.closed.Store(true)
		sub.pend.discard()
		c.binHub.mu.Lock()
		delete(c.binHub.subs, sub)
		c.binHub.mu.Unlock()
	}()

	// Write immediate binary preamble + full cached 198-symbol snapshot so fetch() resolves on microsecond 1!
	bytesSent := 0
	const chunk = 64
	for start := 0; start < len(snaps); start += chunk {
		end := start + chunk
		if end > len(snaps) {
			end = len(snaps)
		}
		pkt := wrapLocalBinaryFrame(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.EncodeBinaryTickBatch(snaps[start:end]))
		if len(pkt) > 0 {
			n, err := w.Write(pkt)
			if err != nil {
				return
			}
			bytesSent += n
		}
	}
	if bytesSent < 1024 {
		// Pad initial flush past browser 1KB stream threshold with a 0x00 no-op binary frame
		pad := make([]byte, 1028)
		pad[0] = 0x00
		pad[1] = 0x00
		binary.LittleEndian.PutUint16(pad[2:4], 1024)
		if _, err := w.Write(pad); err != nil {
			return
		}
	}
	flusher.Flush()

	keepAlive := time.NewTicker(10 * time.Second)
	defer keepAlive.Stop()
	noopPing := []byte{rtx5tcp.FramePing, 0x00, 0x00, 0x00}

	rc := http.NewResponseController(w)
	var deadlineSet time.Time
	refreshDeadline := func() {
		if now := time.Now(); now.Sub(deadlineSet) >= localStreamWriteDeadlineRefresh {
			deadlineSet = now
			_ = rc.SetWriteDeadline(now.Add(localStreamWriteDeadline)) // unsupported writers just ignore it
		}
	}

	drainPrio := func(limit int) (wrote bool, err error) {
		for i := 0; i < limit; i++ {
			select {
			case pkt := <-sub.prioCh:
				refreshDeadline()
				if _, werr := w.Write(pkt); werr != nil {
					return wrote, werr
				}
				wrote = true
			default:
				return wrote, nil
			}
		}
		return wrote, nil
	}

	drainMarket := func(limit int) (wrote bool, err error) {
		for i := 0; i < limit; i++ {
			select {
			case pkt := <-sub.ch:
				refreshDeadline()
				if _, werr := w.Write(pkt); werr != nil {
					return wrote, werr
				}
				wrote = true
			default:
				return wrote, nil
			}
		}
		return wrote, nil
	}

	var resyncTimer *time.Timer
	var resyncC <-chan time.Time
	defer func() {
		if resyncTimer != nil {
			resyncTimer.Stop()
		}
	}()
	// Conflated-tick writer state: pendSig wakes the loop when the first tick goes pending; the flush runs at most
	// once per localConflateInterval (timer-armed when it is not due yet).
	var pendTimer *time.Timer
	var pendC <-chan time.Time
	var pendSig <-chan struct{}
	if sub.pend != nil {
		pendSig = sub.pend.sig
	}
	defer func() {
		if pendTimer != nil {
			pendTimer.Stop()
		}
	}()
	var lastFlush time.Time
	var scratch conflateScratch
	writeRaw := func(pkt []byte) error {
		refreshDeadline()
		_, err := w.Write(pkt)
		return err
	}
	betweenPrio := func() error {
		_, err := drainPrio(localStreamMaxPrioBurst)
		return err
	}
	ctxDone := r.Context().Done()
	for {
		select {
		case <-ctxDone:
			return
		default:
		}
		// The 45 s write deadline is refreshed here, once per loop turn (and inside drainPrio/drainMarket);
		// on an idle stream it relies on the 10 s keep-alive ticker waking the loop.
		refreshDeadline()
		if sub.needResync.Load() {
			if pkts := c.binHub.resyncPackets(sub); pkts != nil {
				for _, pkt := range pkts {
					refreshDeadline()
					if _, err := w.Write(pkt); err != nil {
						return
					}
				}
				flusher.Flush()
			}
			if resyncC == nil && sub.needResync.Load() { // rate-limited: retry once the gap has passed
				if resyncTimer == nil {
					resyncTimer = time.NewTimer(localResyncMinGap)
				} else {
					resyncTimer.Reset(localResyncMinGap)
				}
				resyncC = resyncTimer.C
			}
		}
		if sub.pend != nil && sub.pend.has.Load() {
			if wait := localConflateInterval - time.Since(lastFlush); wait <= 0 {
				if err := sub.flushConflated(&scratch, writeRaw, betweenPrio); err != nil {
					return
				}
				lastFlush = time.Now()
				flusher.Flush()
			} else if pendC == nil {
				if pendTimer == nil {
					pendTimer = time.NewTimer(wait)
				} else {
					pendTimer.Reset(wait)
				}
				pendC = pendTimer.C
			}
		}
		if wrote, err := drainPrio(localStreamMaxPrioBurst); err != nil {
			return
		} else if wrote {
			// Bound prio bursts before servicing sub.ch so 0x3A floods never starve 0x21 ticks,
			// and coalesce the entire batch into a single flusher.Flush().
			if _, err := drainMarket(localStreamMaxMarketBurst); err != nil {
				return
			}
			flusher.Flush()
			continue
		}

		select {
		case <-ctxDone:
			return
		case <-resyncC:
			resyncC = nil
		case <-pendSig:
		case <-pendC:
			pendC = nil
		case pkt := <-sub.prioCh:
			refreshDeadline()
			if _, err := w.Write(pkt); err != nil {
				return
			}
			if _, err := drainPrio(localStreamMaxPrioBurst - 1); err != nil {
				return
			}
			if _, err := drainMarket(localStreamMaxMarketBurst); err != nil {
				return
			}
			flusher.Flush()
		case pkt := <-sub.ch:
			refreshDeadline()
			if _, err := w.Write(pkt); err != nil {
				return
			}
			if _, err := drainMarket(localStreamMaxMarketBurst - 1); err != nil {
				return
			}
			if _, err := drainPrio(localStreamMaxPrioBurst); err != nil {
				return
			}
			flusher.Flush()
		case <-keepAlive.C:
			refreshDeadline()
			if _, err := w.Write(noopPing); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

