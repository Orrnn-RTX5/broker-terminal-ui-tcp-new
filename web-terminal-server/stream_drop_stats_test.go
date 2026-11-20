package main

import (
	"encoding/binary"
	"testing"
)

func TestWebStreamDropsAreCounted(t *testing.T) {
	hub := newWebBinaryMarketHub()
	sub := &webBinaryStreamSub{clientKey: "k", ch: make(chan []byte, 1), prioCh: make(chan []byte, 1)}
	sub.accountLogin.Store(-1) // wildcard: receives every trade event
	hub.subs[sub] = struct{}{}

	market := webStreamMarketFramesDropped.Load()
	hub.broadcastMarketPacket([]byte{0x21, 0, 0, 0})
	hub.broadcastMarketPacket([]byte{0x21, 0, 0, 0}) // queue full: dropped
	if got := webStreamMarketFramesDropped.Load() - market; got != 1 {
		t.Fatalf("market drops counted = %d, want 1", got)
	}

	event := func(marker byte) []byte {
		p := make([]byte, 22)
		binary.LittleEndian.PutUint64(p[2:10], 200074)
		p[21] = marker
		return p
	}
	evicted := webStreamTradeFramesEvicted.Load()
	hub.broadcastTradeEvent(event(1))
	hub.broadcastTradeEvent(event(2)) // full: the oldest is evicted
	if got := webStreamTradeFramesEvicted.Load() - evicted; got != 1 {
		t.Fatalf("trade evictions counted = %d, want 1", got)
	}
	if pkt := <-sub.prioCh; pkt[len(pkt)-1] != 2 {
		t.Fatal("the newest trade event must be kept")
	}
}
