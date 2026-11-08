package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

func TestWebTerminalServerCachesAndServesBinaryDepthSnapshot(t *testing.T) {
	nowMs := time.Now().UnixMilli()
	payload := rtx5tcp.EncodeBinaryDepthBatch([]rtx5tcp.BinaryDepth{
		{
			Symbol:      "EURUSD",
			TimestampMs: nowMs,
			Sequence:    77,
			Bids: []rtx5tcp.BinaryDepthLevel{
				{Price: 1.0850, Volume: 100000},
				{Price: 1.0849, Volume: 200000},
				{Price: 1.0848, Volume: 300000},
			},
			Asks: []rtx5tcp.BinaryDepthLevel{
				{Price: 1.0852, Volume: 150000},
				{Price: 1.0853, Volume: 250000},
				{Price: 1.0854, Volume: 350000},
			},
		},
	})

	srv := &WebTerminalServer{
		binHub: newWebBinaryMarketHub(),
	}
	srv.binHub.handleControlFrame(rtx5tcp.FrameBinaryDepthBatch, payload)

	req := httptest.NewRequest(http.MethodGet, "/api/v2/depth/EURUSD?limit=2", nil)
	rec := httptest.NewRecorder()
	if !srv.tryServeCachedDepthSnapshot(rec, req) {
		t.Fatalf("expected tryServeCachedDepthSnapshot to return true for cached EURUSD depth")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp struct {
		Symbol    string              `json:"symbol"`
		Timestamp int64               `json:"timestamp"`
		Spread    *string             `json:"spread"`
		Bids      []webDepthLevelJSON `json:"bids"`
		Asks      []webDepthLevelJSON `json:"asks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Symbol != "EURUSD" || len(resp.Bids) != 2 || len(resp.Asks) != 2 {
		t.Fatalf("unexpected depth response: %+v", resp)
	}
	if resp.Bids[0].Price != "1.085" || resp.Bids[0].Size != "100000" {
		t.Fatalf("unexpected bid[0]: %+v", resp.Bids[0])
	}
	if resp.Bids[1].Price != "1.0849" || resp.Bids[1].Size != "200000" {
		t.Fatalf("unexpected bid[1]: %+v", resp.Bids[1])
	}
	if resp.Asks[0].Price != "1.0852" || resp.Asks[0].Size != "150000" {
		t.Fatalf("unexpected ask[0]: %+v", resp.Asks[0])
	}
	if resp.Asks[1].Price != "1.0853" || resp.Asks[1].Size != "250000" {
		t.Fatalf("unexpected ask[1]: %+v", resp.Asks[1])
	}
	if resp.Spread == nil || *resp.Spread != "0.0002" {
		t.Fatalf("expected spread 0.0002, got %v", resp.Spread)
	}
}
