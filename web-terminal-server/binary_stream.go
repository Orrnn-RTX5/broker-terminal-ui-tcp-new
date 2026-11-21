package main

import (
	"context"
	"encoding/binary"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

type webBinaryStreamSub struct {
	accountLogin atomic.Int64
	clientKey    string
	prioCh       chan []byte
	ch           chan []byte
	closed       atomic.Bool
	// needResync is set (O(1), only on the drop path) when a market frame for this tab was dropped because ch was
	// full. The tab's writer then discards its stale queue and re-sends the source's latest ticks/depth snapshot
	// (what attachSub sends), so a quiet symbol whose newest tick was dropped is not frozen until a page refresh.
	needResync atomic.Bool
	// lastResync (unix nanos) is touched by the tab's writer goroutine only: at most one full snapshot resync
	// per webResyncMinGap, so a persistent overflow cannot turn into a snapshot storm.
	lastResync int64
	// pend conflates 0x21 tick frames while the tab is backed up (nil = no conflation: ticks on a full queue are
	// dropped as before). Set once at creation, never changed.
	pend *tickConflator

	// src is the one market source (guest hub or an account tunnel's hub) this tab takes 0x21/0x22/depth
	// frames from. It only changes under brokerLink.srcMu (see moveSubLocked); the hot path never reads it.
	src atomic.Pointer[webBinaryMarketHub]
	// Under brokerLink.srcMu only. claimLogin is the login the tab asked for; accountLogin (read by 0x3A
	// delivery) is that login only once the claim is proven: the gateway verified the token or the tab's own
	// account tunnel was accepted by :4443. acctKey names the tab's account tunnel (login + token hash).
	claimLogin int64
	acctKey    accountKey
	verified   bool

	// Recent 0x3A payload hashes (length + FNV-1a): the same event can arrive over an account tunnel and over
	// the direct :8190 push loop; a tab must see it once. Backed by an O(1) map + ring buffer under tradeMu.
	tradeMu       sync.Mutex
	tradeSeen     map[uint64]int64
	tradeRing     []tradeDedupeEntry
	tradeRingHead int
}

type tradeDedupeEntry struct {
	sum uint64
	at  int64
}

const (
	tradeDedupeMax    = 4096
	tradeDedupeWindow = 2 * time.Second
)

// isDuplicateTradeEvent records the event hash and reports whether the same event was already delivered to
// this tab within tradeDedupeWindow. Backed by an O(1) map + ring buffer capped at tradeDedupeMax entries
// so high-frequency bursts never overflow dedupe or scan linearly.
func (s *webBinaryStreamSub) isDuplicateTradeEvent(sum uint64, now int64) bool {
	s.tradeMu.Lock()
	defer s.tradeMu.Unlock()
	if at, ok := s.tradeSeen[sum]; ok && now-at < int64(tradeDedupeWindow) {
		return true
	}
	if s.tradeSeen == nil {
		s.tradeSeen = make(map[uint64]int64, 64)
	}
	if len(s.tradeRing) < tradeDedupeMax {
		s.tradeRing = append(s.tradeRing, tradeDedupeEntry{sum: sum, at: now})
	} else {
		old := s.tradeRing[s.tradeRingHead]
		if curAt, exists := s.tradeSeen[old.sum]; exists && curAt == old.at {
			delete(s.tradeSeen, old.sum)
		}
		s.tradeRing[s.tradeRingHead] = tradeDedupeEntry{sum: sum, at: now}
		s.tradeRingHead++
		if s.tradeRingHead >= tradeDedupeMax {
			s.tradeRingHead = 0
		}
	}
	s.tradeSeen[sum] = now
	return false
}

func fnv1a64(b []byte) uint64 {
	// The length goes in first so payloads of different size never share a hash prefix state.
	h := uint64(14695981039346656037)
	for n := uint64(len(b)); n != 0; n >>= 8 {
		h ^= n & 0xff
		h *= 1099511628211
	}
	for _, c := range b {
		h ^= uint64(c)
		h *= 1099511628211
	}
	return h
}

type webBinaryMarketHub struct {
	mu          sync.RWMutex
	latestTicks map[string]rtx5tcp.BinaryTick
	latestDepth map[string]rtx5tcp.BinaryDepth
	subs        map[*webBinaryStreamSub]struct{}
	loginByKey  map[string]int64
	framesRx    atomic.Uint64
	directOnce  sync.Once

	// subs holds the tabs whose market source is THIS hub (guest hub or one account tunnel's hub).
	// Account hubs only (set before the hub is shared, never changed afterwards):
	//   tradeSink: the link's guest hub; 0x3A events from the account tunnel go through it.
	//   onWarm:    called once per (re)dial on the first market frame; moves waiting tabs onto this hub.
	// Guest hub only: tradePeers visits the account hubs a 0x3A event for eventLogin must also reach.
	tradeSink *webBinaryMarketHub
	onAuth    func(firstPayload []byte)
	acctOwner *accountTunnel // the account tunnel this hub belongs to (nil on the guest hub)
	// committed: a market frame arrived after the ping barrier that follows this tunnel's latest 0x3B (so the
	// access server has applied the subscription's gate); tabs only move onto a committed hub. armedAt: unix
	// nanos from which market frames count (the time the barrier pong was back), 0 = barrier not passed. authed: a 0x3A for the
	// subscription arrived, i.e. :4443 accepted the token.
	committed atomic.Bool
	armedAt   atomic.Int64
	authed    atomic.Bool
	// Encoded snapshot cache (under mu), valid while snapVer == ver: shared by every tab moved onto the hub.
	snapPkts [][]byte
	snapVer  uint64
	snapOK   bool
	// ver counts cache changes (under mu); a source switch uses it to detect a cache that moved while it
	// encoded the snapshot outside the lock.
	ver uint64
	// Guest hub only: delivers a 0x3A event to every tab of the link whatever hub it is on (brokerLink).
	tradeFan func(pkt []byte, eventLogin int64, sum uint64, now int64)
}

func newWebBinaryMarketHub() *webBinaryMarketHub {
	return &webBinaryMarketHub{
		latestTicks: make(map[string]rtx5tcp.BinaryTick, 256),
		latestDepth: make(map[string]rtx5tcp.BinaryDepth, 256),
		subs:        make(map[*webBinaryStreamSub]struct{}),
		loginByKey:  make(map[string]int64),
	}
}

func (h *webBinaryMarketHub) clearMarketCache() {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.latestTicks = make(map[string]rtx5tcp.BinaryTick, 256)
	h.latestDepth = make(map[string]rtx5tcp.BinaryDepth, 256)
	h.ver++
	h.mu.Unlock()
}

func (h *webBinaryMarketHub) startDirectGatewayPushLoop() {
	h.directOnce.Do(func() {
		go func() {
			for {
				addr := rtx5tcp.GetDefaultBinaryOrderGatewayAddr()
				_ = rtx5tcp.DialRawGatewayPushStream(addr, func(eventPayload []byte) {
					if len(eventPayload) >= 22 {
						h.framesRx.Add(1)
						h.broadcastTradeEvent(eventPayload)
					}
				})
				time.Sleep(1 * time.Second)
			}
		}()
	})
}

func wrapWebBinaryFrame(frameType uint8, payload []byte) []byte {
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

func (h *webBinaryMarketHub) bindClientAccount(clientKey string, accountLogin int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if accountLogin == 0 {
		delete(h.loginByKey, clientKey)
	} else {
		h.loginByKey[clientKey] = accountLogin
	}
	for s := range h.subs {
		if s.clientKey == clientKey {
			s.accountLogin.Store(accountLogin)
		}
	}
}

func (h *webBinaryMarketHub) handleControlFrame(frameType uint8, payload []byte) {
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
			h.ver++
			h.mu.Unlock()
		}
		h.framesRx.Add(1)
		h.broadcastMarketPacket(wrapWebBinaryFrame(rtx5tcp.FrameBinaryTickBatch, payload))

	case rtx5tcp.FrameBinaryCandleBatch:
		h.framesRx.Add(1)
		h.broadcastMarketPacket(wrapWebBinaryFrame(rtx5tcp.FrameBinaryCandleBatch, payload))

	case rtx5tcp.FrameBinaryDepthBatch, rtx5tcp.FrameLPDepthBatch:
		depths, err := rtx5tcp.DecodeBinaryDepthBatch(payload)
		if err == nil && len(depths) > 0 {
			h.mu.Lock()
			for _, d := range depths {
				h.latestDepth[d.Symbol] = d
			}
			h.ver++
			h.mu.Unlock()
		}
		h.framesRx.Add(1)
		h.broadcastMarketPacket(wrapWebBinaryFrame(rtx5tcp.FrameBinaryDepthBatch, payload))

	case rtx5tcp.FrameBinaryTradeEvent:
		h.framesRx.Add(1)
		if len(payload) >= 10 {
			if h.noteAuthed(int64(binary.LittleEndian.Uint64(payload[2:10])), payload) {
				return
			}
		}
		if h.tradeSink != nil {
			h.tradeSink.broadcastTradeEvent(payload)
		} else {
			h.broadcastTradeEvent(payload)
		}
	}
}

// noteAuthed proves the tunnel's subscription on its first matching 0x3A: the access server only pushes events
// to a tunnel whose token it accepted (a rejected token can still receive the guest market feed, so market
// frames prove nothing). When triggered, onAuth runs asynchronously (off MuxSession.ServeLoop) and delivers
// firstPayload once reconcileTunnel has bound the tab's effective login. Returns true when onAuth took
// ownership of delivering payload.
func (h *webBinaryMarketHub) noteAuthed(eventLogin int64, payload []byte) bool {
	if h.onAuth == nil || h.authed.Load() {
		return false
	}
	if o := h.acctOwner; o != nil && o.login != 0 && eventLogin != o.login {
		return false
	}
	if h.authed.CompareAndSwap(false, true) {
		cp := append([]byte(nil), payload...)
		h.onAuth(cp)
		return true
	}
	return false
}

// broadcastMarketPacket sends pkt to every tab whose market source is this hub. Sends are non-blocking channel
// writes made under the read lock (no copy of the subscriber set); the write lock is only taken to move a tab
// between sources, which is how a moved tab is guaranteed to receive nothing more from its old source.
func (h *webBinaryMarketHub) broadcastMarketPacket(pkt []byte) {
	if len(pkt) == 0 {
		return
	}
	isTick := pkt[0] == rtx5tcp.FrameBinaryTickBatch && len(pkt) >= 4
	h.mu.RLock()
	for s := range h.subs {
		if s.closed.Load() {
			continue
		}
		// Backed-up tab (some tick is pending): every tick goes to the per-symbol pending map until the writer
		// has drained it, so a symbol's ticks can never overtake its older pending one. One atomic load otherwise.
		if isTick && s.pend != nil && s.pend.has.Load() {
			s.conflateTick(h, pkt)
			continue
		}
		select {
		case s.ch <- pkt:
		default:
			if isTick && s.pend != nil {
				s.conflateTick(h, pkt)
				continue
			}
			webStreamMarketFramesDropped.Add(1)
			s.needResync.Store(true)
		}
	}
	h.mu.RUnlock()
}

// conflateTick stores the ticks of a 0x21 frame as the latest pending tick of their symbols (slow path only).
// Ticks that cannot be kept (malformed frame, pending map full) are the only ones counted as dropped.
func (s *webBinaryStreamSub) conflateTick(h *webBinaryMarketHub, pkt []byte) {
	if lost := s.pend.put(pkt[4:], h); lost > 0 {
		webStreamMarketFramesDropped.Add(uint64(lost))
		s.needResync.Store(true)
	}
	webStreamTickFramesConflated.Add(1)
}

// maxPendingTickSymbols bounds a tab's pending map (a source carries a few hundred symbols); a new symbol beyond it
// is dropped and counted like any other lost frame.
const maxPendingTickSymbols = 4096

type pendingTick struct {
	rec [rtx5tcp.BinaryTickRecordSize]byte
	src *webBinaryMarketHub // the hub the tick came from: a tab that moved to another source discards the old one's
}

// tickConflator holds, per symbol, the newest 0x21 tick a backed-up tab has not been sent yet. Producers (hub
// broadcast) only touch it on the slow path; the writer drains it. has is true while the map is non-empty.
type tickConflator struct {
	has atomic.Bool
	sig chan struct{} // cap 1: wakes the writer when the map goes from empty to non-empty
	mu  sync.Mutex
	m   map[[rtx5tcp.BinarySymbolMaxBytes]byte]pendingTick
}

func newTickConflator() *tickConflator {
	return &tickConflator{sig: make(chan struct{}, 1), m: make(map[[rtx5tcp.BinarySymbolMaxBytes]byte]pendingTick, 64)}
}

// put stores every record of a 0x21 payload ([count u16][count x 48 B]) as its symbol's latest tick, overwriting
// an older one, without decoding or allocating. It returns the number of ticks that could not be kept.
func (c *tickConflator) put(payload []byte, src *webBinaryMarketHub) (lost int) {
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
		pt, ok := c.m[key]
		if !ok && len(c.m) >= maxPendingTickSymbols {
			lost++
			continue
		}
		copy(pt.rec[:], rec)
		pt.src = src
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

// take appends the pending records (of src; all when src is nil) to dst and empties the map.
func (c *tickConflator) take(dst []byte, src *webBinaryMarketHub) []byte {
	c.mu.Lock()
	for _, v := range c.m {
		if src == nil || v.src == src {
			dst = append(dst, v.rec[:]...)
		}
	}
	clear(c.m)
	c.has.Store(false)
	c.mu.Unlock()
	return dst
}

// discard empties the map (tab closed, or a resync snapshot that supersedes the pending ticks).
func (c *tickConflator) discard() {
	if c == nil {
		return
	}
	c.mu.Lock()
	clear(c.m)
	c.has.Store(false)
	c.mu.Unlock()
}

const webConflateInterval = 16 * time.Millisecond

// conflateScratch holds the writer's reusable buffers for flushConflated.
type conflateScratch struct {
	recs  []byte
	frame []byte
}

// flushConflated is the writer's drain of a backed-up tab. It first writes the market frames already queued in
// ch (a snapshot of its length: they are older than every pending tick, because a symbol only becomes pending
// once ch is full and then stays pending), calling between every 32 packets, and then the pending ticks as
// 0x21 frames of up to 64 ticks. Writing the queue first and the pending map second is what keeps each symbol's
// ticks in order.
func (s *webBinaryStreamSub) flushConflated(sc *conflateScratch, write func([]byte) error, between func() error) error {
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
	sc.recs = s.pend.take(sc.recs[:0], s.src.Load())
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

// broadcastTradeEvent isolates 0x3A private account/position events strictly by each browser tab's bound AccountLogin (bytes[2:10]),
// while delivering all 0x3A events to verified Manager/Admin wildcard subscribers (boundLogin == -1).
// Called on the link's guest hub; with a link it delivers to every tab of the link under srcMu.RLock, so a tab
// gets the event whichever source it is on and a source switch can never make it miss one. A tab never gets the same event twice within
// tradeDedupeWindow (an event can come over its account tunnel and the direct gateway push loop).
func (h *webBinaryMarketHub) broadcastTradeEvent(payload []byte) {
	if len(payload) < 10 {
		return
	}
	eventLogin := int64(binary.LittleEndian.Uint64(payload[2:10]))
	pkt := wrapWebBinaryFrame(rtx5tcp.FrameBinaryTradeEvent, payload)
	if len(pkt) == 0 {
		return
	}
	sum := fnv1a64(payload)
	now := time.Now().UnixNano()
	if h.tradeFan != nil {
		h.tradeFan(pkt, eventLogin, sum, now)
		return
	}
	h.deliverTradeEvent(pkt, eventLogin, sum, now)
}

// deliverTradeEvent sends the event to the tabs of this hub (a hub without a link, e.g. in tests).
func (h *webBinaryMarketHub) deliverTradeEvent(pkt []byte, eventLogin int64, sum uint64, now int64) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		s.deliverTradeEvent(pkt, eventLogin, sum, now)
	}
}

// deliverTradeEvent applies the tab's login filter and dedupe, then queues the event on its priority channel.
func (s *webBinaryStreamSub) deliverTradeEvent(pkt []byte, eventLogin int64, sum uint64, now int64) {
	if s.closed.Load() {
		return
	}
	boundLogin := s.accountLogin.Load()
	if boundLogin == 0 {
		return
	}
	if boundLogin > 0 && eventLogin > 0 && boundLogin != eventLogin {
		return
	}
	if s.isDuplicateTradeEvent(sum, now) {
		return
	}
	select {
	case s.prioCh <- pkt:
	default:
		webStreamTradeFramesEvicted.Add(1)
		select {
		case <-s.prioCh:
		default:
		}
		select {
		case s.prioCh <- pkt:
		default:
			webStreamTradeFramesDropped.Add(1)
		}
	}
}

// resyncPackets is the writer's answer to an overflow of this tab's queue (needResync). It discards the stale
// queued market packets (queued 0x22 candle frames are kept: the hub caches no candles) and returns the source's
// latest ticks/depth snapshot, followed by the kept candles, for the writer to send. Order matters: the queue is
// emptied first and the snapshot taken after, so every packet queued afterwards is at least as new as the
// snapshot's cache state (the hub updates its cache before it fans a packet out) and the tab converges on the
// latest state. It returns nil when no resync is pending (one atomic swap on the writer's loop).
func (s *webBinaryStreamSub) resyncPackets() [][]byte {
	if !s.needResync.Load() {
		return nil
	}
	if now := time.Now().UnixNano(); now-s.lastResync < int64(webResyncMinGap) {
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
	// Discard the pending ticks BEFORE taking the snapshot: every discarded tick is already in the hub cache the
	// snapshot reads, and a tick pended after this point is sent after the snapshot (at worst a harmless repeat).
	// Discarding after the snapshot could drop a tick that reached the cache too late for it.
	s.pend.discard()
	var out [][]byte
	if h := s.src.Load(); h != nil {
		snap, _ := h.snapshotPackets()
		if s.src.Load() != h {
			// moveSubLocked switched the source meanwhile: never send the old hub's snapshot. The new hub's
			// snapshot was queued by the move; resync again from the new source on the next allowed turn.
			s.needResync.Store(true)
			s.lastResync = 0
		} else {
			out = make([][]byte, 0, len(snap)+len(keep))
			out = append(out, snap...) // the cached snapshot slice is shared: never append to it in place
		}
	}
	out = append(out, keep...)
	if out == nil {
		out = [][]byte{}
	}
	return out
}

// webStreamWriteDeadline bounds one stalled write to a tab: a tab whose socket accepts nothing for this long is
// dropped (the browser reconnects) instead of pinning its handler forever. A slow tab that keeps draining is
// never cut: the deadline is pushed forward while the writer is active.
const (
	webStreamWriteDeadline        = 45 * time.Second
	webStreamWriteDeadlineRefresh = 5 * time.Second
	webResyncMinGap               = time.Second
	webStreamMaxPrioBurst         = 24
	webStreamMaxMarketBurst       = 32
)

func (s *WebTerminalServer) serveBinaryMarketStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	clientKey := s.resolveClientSessionKey(w, r)
	isSA := resolveWebAppKind(r) == "superadmin"
	tabCtx := r.Context()
	var link *brokerLink
	if isSA {
		// Super Admin tab: unfiltered :9100 hub feed, only for a valid Super Admin token (never trust the app
		// kind alone: it is client-settable).
		switch s.superAdminVerdict(r) {
		case saValid:
		case saInvalid:
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		default: // could not verify (hub down, timeout, overload): try again, never cached as "invalid"
			w.Header().Set("Retry-After", "2")
			http.Error(w, "cannot verify session", http.StatusServiceUnavailable)
			return
		}
		dctx, dcancel := context.WithTimeout(r.Context(), saStreamDialWait)
		err := s.ensureSuperAdminSession(dctx)
		dcancel()
		if err != nil {
			w.Header().Set("Retry-After", "2")
			http.Error(w, "superadmin hub unreachable", http.StatusServiceUnavailable)
			return
		}
	} else {
		// Prices come from this page's own broker (per-session broker targets).
		link = s.linkForSession(clientKey)
		if link == nil || link.binHub == nil {
			http.Error(w, errNoBrokerTarget.Error(), http.StatusServiceUnavailable)
			return
		}
		_, _ = link.getOrDialSession()
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	sub := &webBinaryStreamSub{
		clientKey: clientKey,
		prioCh:    make(chan []byte, 512),
		ch:        make(chan []byte, 2048),
		pend:      newTickConflator(),
	}

	// Registers the tab on its market source (guest hub, or its account tunnel's hub when that is up; the Super
	// Admin hub for a Super Admin tab) and returns that source's snapshot.
	var snaps []rtx5tcp.BinaryTick
	var depthSnaps []rtx5tcp.BinaryDepth
	if isSA {
		saHub := s.superAdminHub()
		snaps, depthSnaps = saHub.attachDirect(sub)
		defer sub.pend.discard()
		defer saHub.detachDirect(sub)
		// The tab ends with its request or with the :9100 session (so it never shows stale prices as live); one
		// shared redialer keeps the session up while any Super Admin tab is open.
		var stopTab func()
		tabCtx, stopTab = s.superAdminTabContext(r.Context())
		defer stopTab()
		defer s.acquireSuperAdminRedialer()()
	} else {
		snaps, depthSnaps = link.attachSub(sub)
		defer sub.pend.discard() // runs after detachSub: frees the pending map when the tab closes
		defer link.detachSub(sub)
	}

	bytesSent := 0
	const chunk = 64
	for start := 0; start < len(snaps); start += chunk {
		end := start + chunk
		if end > len(snaps) {
			end = len(snaps)
		}
		pkt := wrapWebBinaryFrame(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.EncodeBinaryTickBatch(snaps[start:end]))
		if len(pkt) > 0 {
			n, err := w.Write(pkt)
			if err != nil {
				return
			}
			bytesSent += n
		}
	}
	const depthChunk = 32
	for start := 0; start < len(depthSnaps); start += depthChunk {
		end := start + depthChunk
		if end > len(depthSnaps) {
			end = len(depthSnaps)
		}
		pkt := wrapWebBinaryFrame(rtx5tcp.FrameBinaryDepthBatch, rtx5tcp.EncodeBinaryDepthBatch(depthSnaps[start:end]))
		if len(pkt) > 0 {
			n, err := w.Write(pkt)
			if err != nil {
				return
			}
			bytesSent += n
		}
	}
	if bytesSent < 1024 {
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
		if now := time.Now(); now.Sub(deadlineSet) >= webStreamWriteDeadlineRefresh {
			deadlineSet = now
			_ = rc.SetWriteDeadline(now.Add(webStreamWriteDeadline)) // unsupported writers just ignore it
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
	// once per webConflateInterval (timer-armed when it is not due yet).
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
		_, err := drainPrio(webStreamMaxPrioBurst)
		return err
	}
	ctxDone := tabCtx.Done()
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
			if pkts := sub.resyncPackets(); pkts != nil {
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
					resyncTimer = time.NewTimer(webResyncMinGap)
				} else {
					resyncTimer.Reset(webResyncMinGap)
				}
				resyncC = resyncTimer.C
			}
		}
		if sub.pend != nil && sub.pend.has.Load() {
			if wait := webConflateInterval - time.Since(lastFlush); wait <= 0 {
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
		if wrote, err := drainPrio(webStreamMaxPrioBurst); err != nil {
			return
		} else if wrote {
			// Bound prio bursts before servicing sub.ch so 0x3A floods never starve 0x21 ticks,
			// and coalesce the entire batch into a single flusher.Flush().
			if _, err := drainMarket(webStreamMaxMarketBurst); err != nil {
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
			if _, err := drainPrio(webStreamMaxPrioBurst - 1); err != nil {
				return
			}
			if _, err := drainMarket(webStreamMaxMarketBurst); err != nil {
				return
			}
			flusher.Flush()
		case pkt := <-sub.ch:
			refreshDeadline()
			if _, err := w.Write(pkt); err != nil {
				return
			}
			if _, err := drainMarket(webStreamMaxMarketBurst - 1); err != nil {
				return
			}
			if _, err := drainPrio(webStreamMaxPrioBurst); err != nil {
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

type webDepthLevelJSON struct {
	Price string `json:"price"`
	Size  string `json:"size"`
}

func (c *WebTerminalServer) tryServeCachedDepthSnapshot(w http.ResponseWriter, r *http.Request) bool {
	if c == nil || r == nil {
		return false
	}
	link := c.linkForRequest(r)
	if link == nil || link.binHub == nil {
		return false
	}
	normP := strings.TrimPrefix(r.URL.Path, "/ext-api")
	symbol := strings.ToUpper(strings.TrimSpace(strings.TrimPrefix(normP, "/api/v2/depth/")))
	if symbol == "" {
		return false
	}
	link.binHub.mu.RLock()
	bd, ok := link.binHub.latestDepth[symbol]
	link.binHub.mu.RUnlock()
	if !ok || (len(bd.Bids) == 0 && len(bd.Asks) == 0) {
		return false
	}
	if bd.TimestampMs > 0 && time.Since(time.UnixMilli(bd.TimestampMs)) > 5*time.Second {
		return false
	}

	rawLevels := strings.TrimSpace(r.URL.Query().Get("levels"))
	if rawLevels == "" {
		rawLevels = strings.TrimSpace(r.URL.Query().Get("limit"))
	}
	levels, err := strconv.Atoi(rawLevels)
	if err != nil {
		levels = 5
	}
	if levels < 1 {
		levels = 1
	}
	if levels > 100 {
		levels = 100
	}

	convertSide := func(in []rtx5tcp.BinaryDepthLevel) []webDepthLevelJSON {
		n := len(in)
		if n > levels {
			n = levels
		}
		out := make([]webDepthLevelJSON, 0, n)
		for i := 0; i < n; i++ {
			if in[i].Price > 0 && in[i].Volume > 0 {
				out = append(out, webDepthLevelJSON{
					Price: strconv.FormatFloat(in[i].Price, 'f', -1, 64),
					Size:  strconv.FormatFloat(in[i].Volume, 'f', -1, 64),
				})
			}
		}
		return out
	}

	bids := convertSide(bd.Bids)
	asks := convertSide(bd.Asks)
	if len(bids) == 0 && len(asks) == 0 {
		return false
	}

	var spreadPtr *string
	if len(bids) > 0 && len(asks) > 0 {
		bRat, okB := new(big.Rat).SetString(bids[0].Price)
		aRat, okA := new(big.Rat).SetString(asks[0].Price)
		if !okB || !okA || aRat.Cmp(bRat) < 0 {
			return false
		}
		places := 0
		if i := strings.IndexByte(bids[0].Price, '.'); i >= 0 {
			places = len(bids[0].Price) - i - 1
		}
		if i := strings.IndexByte(asks[0].Price, '.'); i >= 0 {
			if d := len(asks[0].Price) - i - 1; d > places {
				places = d
			}
		}
		sp := new(big.Rat).Sub(aRat, bRat).FloatString(places)
		if strings.Contains(sp, ".") {
			sp = strings.TrimSuffix(strings.TrimRight(sp, "0"), ".")
		}
		spreadPtr = &sp
	}

	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"symbol":    bd.Symbol,
		"bids":      bids,
		"asks":      asks,
		"spread":    spreadPtr,
		"timestamp": bd.TimestampMs,
	})
	return true
}
