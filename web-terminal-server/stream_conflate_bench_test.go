package main

import (
	"testing"

	rtx5tcp "rtx5-tcp-protocol"
)

// BenchmarkBroadcastTickFastPath measures the normal case: queue has room, 4 tabs on the hub.
func BenchmarkBroadcastTickFastPath(b *testing.B) {
	hub := newWebBinaryMarketHub()
	subs := make([]*webBinaryStreamSub, 4)
	for i := range subs {
		subs[i] = &webBinaryStreamSub{prioCh: make(chan []byte, 4), ch: make(chan []byte, 64)}
		hub.subs[subs[i]] = struct{}{}
	}
	pkt := wrapWebBinaryFrame(rtx5tcp.FrameBinaryTickBatch, tickPayload("EURUSD", 1))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		hub.broadcastMarketPacket(pkt)
		for _, s := range subs {
			<-s.ch
		}
	}
}
