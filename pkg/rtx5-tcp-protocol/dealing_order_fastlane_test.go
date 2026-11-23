package rtx5tcp

import (
	"encoding/binary"
	"errors"
	"math"
	"testing"
)

func TestDealingActionsValidate(t *testing.T) {
	if BinaryOrderActionRequoteAccept != 9 || BinaryOrderActionRequoteDecline != 10 || BinaryOrderActionDealingSync != 11 {
		t.Fatalf("unexpected dealing action codes: %d, %d, %d",
			BinaryOrderActionRequoteAccept, BinaryOrderActionRequoteDecline, BinaryOrderActionDealingSync)
	}

	t.Run("action 9 RequoteAccept valid and invalid", func(t *testing.T) {
		base := BinaryOrderFastReq{
			Action:        BinaryOrderActionRequoteAccept,
			Side:          BinaryOrderSideBuy,
			Flags:         BinaryOrderFlagHasExtras,
			AccountLogin:  200074,
			Ticket:        0,
			Volume:        0.50,
			Price:         1.08525,
			Expiration:    0,
			Symbol:        PackBinarySymbol("EURUSD"),
			ClientOrderID: PackBinaryClientOrderID("cid-req-accept"),
		}
		for _, side := range []uint8{BinaryOrderSideNone, BinaryOrderSideBuy, BinaryOrderSideSell} {
			req := base
			req.Side = side
			if err := req.Validate(); err != nil {
				t.Fatalf("Action 9 with side=%d expected valid, got %v", side, err)
			}
		}

		invalid := []struct {
			name string
			mut  func(*BinaryOrderFastReq)
		}{
			{"missing login", func(r *BinaryOrderFastReq) { r.AccountLogin = 0 }},
			{"negative login", func(r *BinaryOrderFastReq) { r.AccountLogin = -5 }},
			{"non-zero ticket", func(r *BinaryOrderFastReq) { r.Ticket = 123 }},
			{"non-zero expiration", func(r *BinaryOrderFastReq) { r.Expiration = 1700000000 }},
			{"invalid side", func(r *BinaryOrderFastReq) { r.Side = 3 }},
			{"missing HasExtras flag", func(r *BinaryOrderFastReq) { r.Flags &^= BinaryOrderFlagHasExtras }},
			{"zero price", func(r *BinaryOrderFastReq) { r.Price = 0 }},
			{"negative price", func(r *BinaryOrderFastReq) { r.Price = -1.0 }},
			{"NaN price", func(r *BinaryOrderFastReq) { r.Price = math.NaN() }},
		}
		for _, tc := range invalid {
			req := base
			tc.mut(&req)
			if err := req.Validate(); !errors.Is(err, ErrInvalidBinaryOrderReq) {
				t.Fatalf("Action 9 (%s): got %v, want ErrInvalidBinaryOrderReq", tc.name, err)
			}
		}
	})

	t.Run("action 10 RequoteDecline valid and invalid", func(t *testing.T) {
		base := BinaryOrderFastReq{
			Action:        BinaryOrderActionRequoteDecline,
			Side:          BinaryOrderSideSell,
			Flags:         BinaryOrderFlagHasExtras,
			AccountLogin:  200074,
			Ticket:        0,
			Volume:        0.50,
			Price:         0,
			Expiration:    0,
			Symbol:        PackBinarySymbol("EURUSD"),
			ClientOrderID: PackBinaryClientOrderID("cid-req-decline"),
		}
		for _, side := range []uint8{BinaryOrderSideNone, BinaryOrderSideBuy, BinaryOrderSideSell} {
			req := base
			req.Side = side
			if err := req.Validate(); err != nil {
				t.Fatalf("Action 10 with side=%d expected valid, got %v", side, err)
			}
		}

		invalid := []struct {
			name string
			mut  func(*BinaryOrderFastReq)
		}{
			{"missing login", func(r *BinaryOrderFastReq) { r.AccountLogin = 0 }},
			{"non-zero ticket", func(r *BinaryOrderFastReq) { r.Ticket = 42 }},
			{"non-zero expiration", func(r *BinaryOrderFastReq) { r.Expiration = 1700000000 }},
			{"invalid side", func(r *BinaryOrderFastReq) { r.Side = 4 }},
			{"missing HasExtras flag", func(r *BinaryOrderFastReq) { r.Flags &^= BinaryOrderFlagHasExtras }},
			{"non-zero price", func(r *BinaryOrderFastReq) { r.Price = 1.085 }},
			{"negative price", func(r *BinaryOrderFastReq) { r.Price = -0.5 }},
		}
		for _, tc := range invalid {
			req := base
			tc.mut(&req)
			if err := req.Validate(); !errors.Is(err, ErrInvalidBinaryOrderReq) {
				t.Fatalf("Action 10 (%s): got %v, want ErrInvalidBinaryOrderReq", tc.name, err)
			}
		}
	})

	t.Run("action 11 DealingSync login-only valid and invalid", func(t *testing.T) {
		base := BinaryOrderFastReq{
			Action:       BinaryOrderActionDealingSync,
			AccountLogin: 200074,
		}
		if err := base.Validate(); err != nil {
			t.Fatalf("Action 11 login-only expected valid, got %v", err)
		}
		withExtras := base
		withExtras.Flags = BinaryOrderFlagHasExtras
		withExtras.ClientOrderID = PackBinaryClientOrderID("sync-probe-1")
		if err := withExtras.Validate(); err != nil {
			t.Fatalf("Action 11 with extras flag expected valid, got %v", err)
		}

		invalid := []struct {
			name string
			mut  func(*BinaryOrderFastReq)
		}{
			{"missing login", func(r *BinaryOrderFastReq) { r.AccountLogin = 0 }},
			{"negative login", func(r *BinaryOrderFastReq) { r.AccountLogin = -1 }},
			{"non-zero ticket", func(r *BinaryOrderFastReq) { r.Ticket = 10 }},
			{"non-zero expiration", func(r *BinaryOrderFastReq) { r.Expiration = 100 }},
			{"non-zero side", func(r *BinaryOrderFastReq) { r.Side = BinaryOrderSideBuy }},
			{"non-zero volume", func(r *BinaryOrderFastReq) { r.Volume = 0.01 }},
			{"non-zero price", func(r *BinaryOrderFastReq) { r.Price = 1.1 }},
			{"non-zero stop limit", func(r *BinaryOrderFastReq) { r.StopLimitPrice = 1.1 }},
			{"non-zero SL", func(r *BinaryOrderFastReq) { r.SL = 1.0 }},
			{"non-zero TP", func(r *BinaryOrderFastReq) { r.TP = 1.2 }},
			{"non-empty symbol", func(r *BinaryOrderFastReq) { r.Symbol = PackBinarySymbol("EURUSD") }},
		}
		for _, tc := range invalid {
			req := base
			tc.mut(&req)
			if err := req.Validate(); !errors.Is(err, ErrInvalidBinaryOrderReq) {
				t.Fatalf("Action 11 (%s): got %v, want ErrInvalidBinaryOrderReq", tc.name, err)
			}
		}
	})
}

func TestDealingBinaryOrderActions1To8Unchanged(t *testing.T) {
	validCases := []struct {
		name string
		req  BinaryOrderFastReq
	}{
		{
			name: "action 1 market",
			req: BinaryOrderFastReq{
				Action: BinaryOrderActionPlaceMarket, Side: BinaryOrderSideBuy,
				AccountLogin: 1001, Volume: 0.1, Symbol: PackBinarySymbol("EURUSD"),
			},
		},
		{
			name: "action 2 close position",
			req:  BinaryOrderFastReq{Action: BinaryOrderActionClosePosition, Ticket: 55},
		},
		{
			name: "action 3 modify position",
			req:  BinaryOrderFastReq{Action: BinaryOrderActionModifyPosition, Ticket: 55},
		},
		{
			name: "action 4 place pending",
			req: BinaryOrderFastReq{
				Action: BinaryOrderActionPlacePending, Side: BinaryOrderSideBuy,
				OrderSubType: BinaryOrderSubTypeBuyLimit,
				Volume:       0.2, Price: 1.05, Symbol: PackBinarySymbol("EURUSD"),
			},
		},
		{
			name: "action 5 modify pending",
			req:  BinaryOrderFastReq{Action: BinaryOrderActionModifyPending, Ticket: 88, Flags: BinaryOrderFlagHasPrice, Price: 1.06},
		},
		{
			name: "action 6 cancel pending",
			req:  BinaryOrderFastReq{Action: BinaryOrderActionCancelPending, Ticket: 88},
		},
		{
			name: "action 7 close bulk",
			req:  BinaryOrderFastReq{Action: BinaryOrderActionCloseBulk, AccountLogin: 1001, OrderSubType: BinaryCloseBulkAll},
		},
		{
			name: "action 8 close by",
			req:  BinaryOrderFastReq{Action: BinaryOrderActionCloseBy, Ticket: 11, Expiration: 22},
		},
	}
	for _, tc := range validCases {
		if err := tc.req.Validate(); err != nil {
			t.Fatalf("%s expected valid, got %v", tc.name, err)
		}
	}

	if err := (BinaryOrderFastReq{Action: 0, AccountLogin: 1001}).Validate(); !errors.Is(err, ErrInvalidBinaryOrderReq) {
		t.Fatalf("action 0: got %v, want ErrInvalidBinaryOrderReq", err)
	}
	if err := (BinaryOrderFastReq{Action: 12, AccountLogin: 1001}).Validate(); !errors.Is(err, ErrInvalidBinaryOrderReq) {
		t.Fatalf("action 12: got %v, want ErrInvalidBinaryOrderReq", err)
	}
	if err := (BinaryOrderFastReq{Action: BinaryOrderActionPlaceMarket, Side: BinaryOrderSideBuy, Volume: 0.1}).Validate(); !errors.Is(err, ErrInvalidBinaryOrderReq) {
		t.Fatalf("action 1 empty symbol: got %v, want ErrInvalidBinaryOrderReq", err)
	}
	if err := (BinaryOrderFastReq{Action: BinaryOrderActionCloseBulk, AccountLogin: 0}).Validate(); err == nil {
		t.Fatal("action 7 missing account_login expected error")
	}
}

func TestDealingDecodeValidateZeroAlloc(t *testing.T) {
	// Build a raw Action 9 frame with dealing TLVs (0x14 RequestUUID, 0x15 RequoteUUID, 0x16 ClientCaps).
	base := EncodeBinaryOrderFastReq(BinaryOrderFastReq{
		Action:        BinaryOrderActionRequoteAccept,
		Side:          BinaryOrderSideBuy,
		AccountLogin:  200074,
		Volume:        0.25,
		Price:         1.09123,
		Symbol:        PackBinarySymbol("EURUSD"),
		ClientOrderID: PackBinaryClientOrderID("cid-dealing-tlv-9"),
	})
	binary.LittleEndian.PutUint16(base[4:6], BinaryOrderFlagHasExtras)

	var tlv []byte
	tlv = append(tlv, 0x14, 16)
	tlv = append(tlv, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)
	tlv = append(tlv, 0x15, 16)
	tlv = append(tlv, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1)
	tlv = append(tlv, 0x16, 4, 0x01, 0x00, 0x00, 0x00)
	var extLen [2]byte
	binary.LittleEndian.PutUint16(extLen[:], uint16(len(tlv)))
	frame9 := append(append(base, extLen[:]...), tlv...)

	var out BinaryOrderFastReq
	allocs := testing.AllocsPerRun(100, func() {
		if err := DecodeBinaryOrderFastReqInto(frame9, &out); err != nil {
			t.Fatal(err)
		}
		if err := out.Validate(); err != nil {
			t.Fatal(err)
		}
	})
	if allocs != 0 {
		t.Fatalf("Action 9 Decode+Validate allocs = %v, want 0", allocs)
	}

	// Build a raw Action 11 DealingSync frame (login-only, no extras).
	frame11 := EncodeBinaryOrderFastReq(BinaryOrderFastReq{
		Action:       BinaryOrderActionDealingSync,
		AccountLogin: 200074,
	})
	allocs11 := testing.AllocsPerRun(100, func() {
		if err := DecodeBinaryOrderFastReqInto(frame11, &out); err != nil {
			t.Fatal(err)
		}
		if err := out.Validate(); err != nil {
			t.Fatal(err)
		}
	})
	if allocs11 != 0 {
		t.Fatalf("Action 11 Decode+Validate allocs = %v, want 0", allocs11)
	}
}
