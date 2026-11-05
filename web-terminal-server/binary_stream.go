package main

import (
	"encoding/binary"
	"net/http"
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
}

type webBinaryMarketHub struct {
	mu          sync.RWMutex
	latestTicks map[string]rtx5tcp.BinaryTick
	subs        map[*webBinaryStreamSub]struct{}
	loginByKey  map[string]int64
	framesRx    atomic.Uint64
	directOnce  sync.Once
}

func newWebBinaryMarketHub() *webBinaryMarketHub {
	return &webBinaryMarketHub{
		latestTicks: make(map[string]rtx5tcp.BinaryTick, 256),
		subs:        make(map[*webBinaryStreamSub]struct{}),
		loginByKey:  make(map[string]int64),
	}
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
			h.mu.Unlock()
		}
		h.framesRx.Add(1)
		h.broadcastMarketPacket(wrapWebBinaryFrame(rtx5tcp.FrameBinaryTickBatch, payload))

	case rtx5tcp.FrameBinaryCandleBatch:
		h.framesRx.Add(1)
		h.broadcastMarketPacket(wrapWebBinaryFrame(rtx5tcp.FrameBinaryCandleBatch, payload))

	case rtx5tcp.FrameBinaryTradeEvent:
		h.framesRx.Add(1)
		h.broadcastTradeEvent(payload)
	}
}

func (h *webBinaryMarketHub) broadcastMarketPacket(pkt []byte) {
	if len(pkt) == 0 {
		return
	}
	h.mu.RLock()
	if len(h.subs) == 0 {
		h.mu.RUnlock()
		return
	}
	subs := make([]*webBinaryStreamSub, 0, len(h.subs))
	for s := range h.subs {
		subs = append(subs, s)
	}
	h.mu.RUnlock()

	for _, s := range subs {
		if s.closed.Load() {
			continue
		}
		select {
		case s.ch <- pkt:
		default:
		}
	}
}

// broadcastTradeEvent isolates 0x3A private account/position events strictly by each browser tab's bound AccountLogin (bytes[2:10]),
// while delivering all 0x3A events to verified Manager/Admin wildcard subscribers (boundLogin == -1).
func (h *webBinaryMarketHub) broadcastTradeEvent(payload []byte) {
	if len(payload) < 10 {
		return
	}
	eventLogin := int64(binary.LittleEndian.Uint64(payload[2:10]))
	pkt := wrapWebBinaryFrame(rtx5tcp.FrameBinaryTradeEvent, payload)
	if len(pkt) == 0 {
		return
	}

	h.mu.RLock()
	if len(h.subs) == 0 {
		h.mu.RUnlock()
		return
	}
	subs := make([]*webBinaryStreamSub, 0, len(h.subs))
	for s := range h.subs {
		subs = append(subs, s)
	}
	h.mu.RUnlock()

	for _, s := range subs {
		if s.closed.Load() {
			continue
		}
		boundLogin := s.accountLogin.Load()
		if boundLogin == 0 {
			continue
		}
		if boundLogin > 0 && eventLogin > 0 && boundLogin != eventLogin {
			continue
		}
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
	}
}

func (s *WebTerminalServer) serveBinaryMarketStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok || s.binHub == nil {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	_, _ = s.getOrDialSession()
	clientKey := s.resolveClientSessionKey(w, r)
	appKind := resolveWebAppKind(r)

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

	s.binHub.mu.Lock()
	if boundLogin, exists := s.binHub.loginByKey[clientKey]; exists {
		sub.accountLogin.Store(boundLogin)
	} else if (appKind == "manager" || appKind == "admin") && s.getSessionOrderToken(clientKey) != "" {
		sub.accountLogin.Store(-1)
		s.binHub.loginByKey[clientKey] = -1
	}
	s.binHub.subs[sub] = struct{}{}
	snaps := make([]rtx5tcp.BinaryTick, 0, len(s.binHub.latestTicks))
	for _, bt := range s.binHub.latestTicks {
		snaps = append(snaps, bt)
	}
	s.binHub.mu.Unlock()

	defer func() {
		sub.closed.Store(true)
		s.binHub.mu.Lock()
		delete(s.binHub.subs, sub)
		s.binHub.mu.Unlock()
	}()

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
