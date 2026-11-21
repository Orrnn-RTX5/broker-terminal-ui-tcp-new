package clientcore

import (
	"testing"

	rtx5tcp "rtx5-tcp-protocol"
)

// BenchmarkBroadcastTickFastPath measures the normal case: queue has room, 4 streams on the hub.
func BenchmarkBroadcastTickFastPath(b *testing.B) {
	hub := newClientBinaryMarketHub()
	subs := make([]*localBinaryStreamSub, 4)
	for i := range subs {
		subs[i] = &localBinaryStreamSub{prioCh: make(chan []byte, 4), ch: make(chan []byte, 64)}
		hub.subs[subs[i]] = struct{}{}
	}
	pkt := wrapLocalBinaryFrame(rtx5tcp.FrameBinaryTickBatch, localTick("EURUSD", 1))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		hub.broadcastPacket(pkt)
		for _, s := range subs {
			<-s.ch
		}
	}
}
