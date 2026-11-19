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
			var lastMarket, lastEvicted, lastDropped uint64
			for range ticker.C {
				market := webStreamMarketFramesDropped.Load()
				evicted := webStreamTradeFramesEvicted.Load()
				dropped := webStreamTradeFramesDropped.Load()
				if market == lastMarket && evicted == lastEvicted && dropped == lastDropped {
					continue
				}
				log.Printf("[WEB-STREAM-DROP] last %s: market frames dropped=%d, trade events evicted=%d dropped=%d (browser stream queue full) | totals: market=%d evicted=%d dropped=%d",
					webStreamDropReportInterval, market-lastMarket, evicted-lastEvicted, dropped-lastDropped, market, evicted, dropped)
				lastMarket, lastEvicted, lastDropped = market, evicted, dropped
			}
		}()
	})
}
