package main

import (
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// Frames dropped on full browser stream queues (/__rtx5_binary_stream). A slow browser must not delay every other
// one, so a full queue drops a frame; these counters make those drops visible instead of silent. They are only
// touched on the drop path, so a healthy stream pays nothing for them.
var (
	// webStreamMarketFramesDropped: tick/candle/depth frames dropped because a browser's queue (ch, 2048) was full.
	webStreamMarketFramesDropped atomic.Uint64
	// webStreamTradeFramesEvicted: trade events that pushed out the oldest queued one because prioCh (512) was full.
	webStreamTradeFramesEvicted atomic.Uint64
	// webStreamTradeFramesDropped: trade events lost because prioCh was still full after that eviction.
	webStreamTradeFramesDropped atomic.Uint64
	// webStreamTickFramesConflated: 0x21 tick frames that did not fit a backed-up tab's queue and were merged into
	// its per-symbol pending ticks instead (the newest tick per symbol is still delivered). NOT drops.
	webStreamTickFramesConflated atomic.Uint64
)

const webStreamDropReportInterval = 10 * time.Second

var webStreamDropReporterOnce sync.Once

// startWebStreamDropReporter writes one line per interval in which any frame was dropped, with the counts for that
// interval and the totals since start. Nothing is written while nothing is dropped.
func startWebStreamDropReporter() {
	webStreamDropReporterOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(webStreamDropReportInterval)
			defer ticker.Stop()
			var lastMarket, lastEvicted, lastDropped, lastConflated uint64
			for range ticker.C {
				market := webStreamMarketFramesDropped.Load()
				evicted := webStreamTradeFramesEvicted.Load()
				dropped := webStreamTradeFramesDropped.Load()
				conflated := webStreamTickFramesConflated.Load()
				if market == lastMarket && evicted == lastEvicted && dropped == lastDropped && conflated == lastConflated {
					continue
				}
				log.Printf("[WEB-STREAM-DROP] last %s: market frames dropped=%d, trade events evicted=%d dropped=%d (browser stream queue full) | totals: market=%d evicted=%d dropped=%d | tick frames conflated (not lost)=%d total=%d",
					webStreamDropReportInterval, market-lastMarket, evicted-lastEvicted, dropped-lastDropped, market, evicted, dropped, conflated-lastConflated, conflated)
				lastMarket, lastEvicted, lastDropped, lastConflated = market, evicted, dropped, conflated
			}
		}()
	})
}
