package main

import (
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
	// the direct :8190 push loop; a tab must see it once. Touched only on the (rare) trade-event path.
	tradeMu   sync.Mutex
	tradeSeen map[uint64]int64
}

const (
	tradeDedupeMax    = 64
	tradeDedupeWindow = 2 * time.Second
)

// isDuplicateTradeEvent records the event hash and reports whether the same event was already delivered to
// this tab within tradeDedupeWindow. At most tradeDedupeMax hashes are kept (expired ones go first, then the
// oldest), so a burst of well over a handful of events is still deduplicated.
func (s *webBinaryStreamSub) isDuplicateTradeEvent(sum uint64, now int64) bool {
	s.tradeMu.Lock()
	defer s.tradeMu.Unlock()
	if at, ok := s.tradeSeen[sum]; ok && now-at < int64(tradeDedupeWindow) {
		return true
	}
	if s.tradeSeen == nil {
		s.tradeSeen = make(map[uint64]int64, tradeDedupeMax)
	}
	if len(s.tradeSeen) >= tradeDedupeMax {
		for k, at := range s.tradeSeen {
			if now-at >= int64(tradeDedupeWindow) {
				delete(s.tradeSeen, k)
			}
		}
		if len(s.tradeSeen) >= tradeDedupeMax {
			var oldestK uint64
			oldest := now + 1
			for k, at := range s.tradeSeen {
				if at < oldest {
					oldestK, oldest = k, at
				}
			}
			delete(s.tradeSeen, oldestK)
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
	onAuth    func()
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
			h.noteAuthed(int64(binary.LittleEndian.Uint64(payload[2:10])))
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
// frames prove nothing). It runs before the event is delivered, so the tab's claimed login is bound in time to
// receive that very event. A login tunnel only counts an event of its own login; a wildcard tunnel any event.
func (h *webBinaryMarketHub) noteAuthed(eventLogin int64) {
	if h.onAuth == nil || h.authed.Load() {
		return
	}
	if o := h.acctOwner; o != nil && o.login != 0 && eventLogin != o.login {
		return
	}
	if h.authed.CompareAndSwap(false, true) {
		h.onAuth()
	}
}

// broadcastMarketPacket sends pkt to every tab whose market source is this hub. Sends are non-blocking channel
// writes made under the read lock (no copy of the subscriber set); the write lock is only taken to move a tab
// between sources, which is how a moved tab is guaranteed to receive nothing more from its old source.
func (h *webBinaryMarketHub) broadcastMarketPacket(pkt []byte) {
	if len(pkt) == 0 {
		return
	}
	h.mu.RLock()
	for s := range h.subs {
		if s.closed.Load() {
			continue
		}
		select {
		case s.ch <- pkt:
		default:
			webStreamMarketFramesDropped.Add(1)
			s.needResync.Store(true)
		}
	}
	h.mu.RUnlock()
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
)

func (s *WebTerminalServer) serveBinaryMarketStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	clientKey := s.resolveClientSessionKey(w, r)
	// Prices come from this page's own broker (per-session broker targets).
	link := s.linkForSession(clientKey)
	if link == nil || link.binHub == nil {
		http.Error(w, errNoBrokerTarget.Error(), http.StatusServiceUnavailable)
		return
	}
	_, _ = link.getOrDialSession()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	sub := &webBinaryStreamSub{
		clientKey: clientKey,
		prioCh:    make(chan []byte, 512),
		ch:        make(chan []byte, 2048),
	}

	// Registers the tab on its market source (guest hub, or its account tunnel's hub when that is up) and
	// returns that source's snapshot.
	snaps, depthSnaps := link.attachSub(sub)
	defer link.detachSub(sub)

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

	drainPrio := func() (wrote bool, err error) {
		for {
			select {
			case pkt := <-sub.prioCh:
				if _, werr := w.Write(pkt); werr != nil {
					return wrote, werr
				}
				wrote = true
			default:
				return wrote, nil
			}
		}
	}

	rc := http.NewResponseController(w)
	var deadlineSet time.Time
	var resyncTimer *time.Timer
	var resyncC <-chan time.Time
	defer func() {
		if resyncTimer != nil {
			resyncTimer.Stop()
		}
	}()
	ctxDone := r.Context().Done()
	for {
		// The 45 s write deadline is refreshed here, once per loop turn; on an idle stream it relies on the 10 s
		// keep-alive ticker below waking the loop (45 s >> 10 s + 5 s refresh gap).
		if now := time.Now(); now.Sub(deadlineSet) >= webStreamWriteDeadlineRefresh {
			deadlineSet = now
			_ = rc.SetWriteDeadline(now.Add(webStreamWriteDeadline)) // unsupported writers just ignore it
		}
		if sub.needResync.Load() {
			if pkts := sub.resyncPackets(); pkts != nil {
				for _, pkt := range pkts {
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
		if wrote, err := drainPrio(); err != nil {
			return
		} else if wrote {
			flusher.Flush()
		}

		select {
		case <-ctxDone:
			return
		case <-resyncC:
			resyncC = nil
		case pkt := <-sub.prioCh:
			if _, err := w.Write(pkt); err != nil {
				return
			}
			if _, err := drainPrio(); err != nil {
				return
			}
			flusher.Flush()
		case pkt := <-sub.ch:
			if _, err := drainPrio(); err != nil {
				return
			}
			if _, err := w.Write(pkt); err != nil {
				return
			}
			for i := 0; i < 31; i++ {
				if _, err := drainPrio(); err != nil {
					return
				}
				select {
				case nextPkt := <-sub.prioCh:
					if _, err := w.Write(nextPkt); err != nil {
						return
					}
				case nextPkt := <-sub.ch:
					if _, err := w.Write(nextPkt); err != nil {
						return
					}
				default:
					goto flushNow
				}
			}
		flushNow:
			if _, err := drainPrio(); err != nil {
				return
			}
			flusher.Flush()
		case <-keepAlive.C:
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
