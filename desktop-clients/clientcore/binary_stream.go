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
		select {
		case s.ch <- pkt:
		default:
		}
	}
}

func (h *clientBinaryMarketHub) clearCache() {
	h.mu.Lock()
	h.latestTicks = make(map[string]rtx5tcp.BinaryTick, 256)
	h.mu.Unlock()
}

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

	ctxDone := r.Context().Done()
	for {
		if wrote, err := drainPrio(); err != nil {
			return
		} else if wrote {
			flusher.Flush()
		}

		select {
		case <-ctxDone:
			return
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
			// Drain any immediately queued packets (always checking prioCh first) before flushing syscall
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

