package rtx5tcp

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

func TestBinaryOrderFastReqRoundTripNoExtras(t *testing.T) {
	req := BinaryOrderFastReq{
		Action:        BinaryOrderActionPlaceMarket,
		Side:          BinaryOrderSideBuy,
		Flags:         BinaryOrderFlagHasSL | BinaryOrderFlagHasTP,
		AccountLogin:  200074,
		Ticket:        100200,
		Volume:        1.25,
		SL:            1.08100,
		TP:            1.09500,
		Symbol:        PackBinarySymbol("eurusd"),
		ClientOrderID: PackBinaryClientOrderID("cid-no-extras-01"),
		AuthToken:     "jwt-token-abc",
	}

	encoded := EncodeBinaryOrderFastReq(req)
	wantLen := BinaryOrderFastReqHeaderSize + 2 + len(req.AuthToken)
	if len(encoded) != wantLen {
		t.Fatalf("encoded len = %d, want %d", len(encoded), wantLen)
	}
	wireFlags := binary.LittleEndian.Uint16(encoded[4:6])
	if (wireFlags & BinaryOrderFlagHasExtras) != 0 {
		t.Fatalf("expected BinaryOrderFlagHasExtras clear on wire, got flags=0x%04x", wireFlags)
	}
	if off, err := BinaryOrderExtrasOffset(encoded); err != nil || off != -1 {
		t.Fatalf("BinaryOrderExtrasOffset = (%d, %v), want (-1, nil)", off, err)
	}

	decoded, err := DecodeBinaryOrderFastReq(encoded)
	if err != nil {
		t.Fatalf("DecodeBinaryOrderFastReq failed: %v", err)
	}
	if err := decoded.Validate(); err != nil {
		t.Fatalf("Validate failed: %v", err)
	}
	if decoded.SymbolString() != "EURUSD" || decoded.ClientOrderIDString() != "cid-no-extras-01" ||
		decoded.AuthToken != "jwt-token-abc" || decoded.Comment != "" || decoded.Magic != 0 {
		t.Fatalf("unexpected decoded struct: %+v", decoded)
	}

	// Verify 0 heap allocations on the no-extras hot path.
	prealloc := make([]byte, 0, 256)
	reqNoTok := req
	reqNoTok.AuthToken = ""
	encAllocs := testing.AllocsPerRun(100, func() {
		_ = AppendBinaryOrderFastReq(prealloc[:0], reqNoTok)
	})
	if encAllocs != 0 {
		t.Fatalf("AppendBinaryOrderFastReq no-extras allocs = %v, want 0", encAllocs)
	}
	payloadNoTok := EncodeBinaryOrderFastReq(reqNoTok)
	var reused BinaryOrderFastReq
	decAllocs := testing.AllocsPerRun(100, func() {
		if err := DecodeBinaryOrderFastReqInto(payloadNoTok, &reused); err != nil {
			t.Fatal(err)
		}
	})
	if decAllocs != 0 {
		t.Fatalf("DecodeBinaryOrderFastReqInto no-extras allocs = %v, want 0", decAllocs)
	}
}

func TestBinaryOrderFastReqGoldenBytesWithExtras(t *testing.T) {
	baseReq := BinaryOrderFastReq{
		Action:        BinaryOrderActionPlacePending,
		Side:          BinaryOrderSideBuy,
		OrderSubType:  BinaryOrderSubTypeBuyLimit,
		Flags:         BinaryOrderFlagHasPrice | BinaryOrderFlagHasSL,
		AccountLogin:  500123,
		Volume:        0.50,
		Price:         1.07500,
		SL:            1.07000,
		Symbol:        PackBinarySymbol("GBPUSD"),
		ClientOrderID: PackBinaryClientOrderID("cid-extras-golden"),
		AuthToken:     "tok123",
	}

	t.Run("comment only", func(t *testing.T) {
		req := baseReq
		req.Comment = "scalp-entry"
		enc := EncodeBinaryOrderFastReq(req)

		afterTok := BinaryOrderFastReqHeaderSize + 2 + len(req.AuthToken)
		// Golden extras: [u16 LE len = 13][0x01][0x0b]["scalp-entry"]
		wantExtras := append([]byte{
			13, 0, // u16 LE extrasLen = 13
			BinaryOrderExtraTagComment, 11,
		}, []byte("scalp-entry")...)

		if !bytes.Equal(enc[afterTok:], wantExtras) {
			t.Fatalf("golden extras mismatch:\ngot:  %x\nwant: %x", enc[afterTok:], wantExtras)
		}
		off, err := BinaryOrderExtrasOffset(enc)
		if err != nil || off != afterTok {
			t.Fatalf("BinaryOrderExtrasOffset = (%d, %v), want (%d, nil)", off, err, afterTok)
		}
		dec, err := DecodeBinaryOrderFastReq(enc)
		if err != nil {
			t.Fatalf("DecodeBinaryOrderFastReq failed: %v", err)
		}
		if (dec.Flags&BinaryOrderFlagHasExtras) == 0 || dec.Comment != "scalp-entry" || dec.Magic != 0 {
			t.Fatalf("unexpected decoded extras: flags=0x%04x comment=%q magic=%d", dec.Flags, dec.Comment, dec.Magic)
		}
	})

	t.Run("magic only", func(t *testing.T) {
		req := baseReq
		req.Magic = 20261107
		enc := EncodeBinaryOrderFastReq(req)

		afterTok := BinaryOrderFastReqHeaderSize + 2 + len(req.AuthToken)
		var magicLE [8]byte
		binary.LittleEndian.PutUint64(magicLE[:], uint64(req.Magic))
		// Golden extras: [u16 LE len = 10][0x02][0x08][8B int64 LE]
		wantExtras := append([]byte{
			10, 0, // u16 LE extrasLen = 10
			BinaryOrderExtraTagMagic, 8,
		}, magicLE[:]...)

		if !bytes.Equal(enc[afterTok:], wantExtras) {
			t.Fatalf("golden extras mismatch:\ngot:  %x\nwant: %x", enc[afterTok:], wantExtras)
		}
		dec, err := DecodeBinaryOrderFastReq(enc)
		if err != nil {
			t.Fatalf("DecodeBinaryOrderFastReq failed: %v", err)
		}
		if (dec.Flags&BinaryOrderFlagHasExtras) == 0 || dec.Comment != "" || dec.Magic != 20261107 {
			t.Fatalf("unexpected decoded extras: flags=0x%04x comment=%q magic=%d", dec.Flags, dec.Comment, dec.Magic)
		}
	})

	t.Run("comment and magic both orders", func(t *testing.T) {
		req := baseReq
		req.Comment = "EA-v2-α"
		req.Magic = -9876543210
		enc := EncodeBinaryOrderFastReq(req)

		dec, err := DecodeBinaryOrderFastReq(enc)
		if err != nil {
			t.Fatalf("DecodeBinaryOrderFastReq failed: %v", err)
		}
		if err := dec.Validate(); err != nil {
			t.Fatalf("Validate failed: %v", err)
		}
		if dec.Comment != "EA-v2-α" || dec.Magic != -9876543210 {
			t.Fatalf("decoded = (%q, %d), want (%q, %d)", dec.Comment, dec.Magic, req.Comment, req.Magic)
		}

		// Also test MAGIC tag before COMMENT tag in wire order.
		afterTok := BinaryOrderFastReqHeaderSize + 2 + len(req.AuthToken)
		reordered := make([]byte, afterTok)
		copy(reordered, enc[:afterTok])
		var magicLE [8]byte
		binary.LittleEndian.PutUint64(magicLE[:], uint64(req.Magic))
		commentBytes := []byte(req.Comment)
		var tlv []byte
		tlv = append(tlv, BinaryOrderExtraTagMagic, 8)
		tlv = append(tlv, magicLE[:]...)
		tlv = append(tlv, BinaryOrderExtraTagComment, uint8(len(commentBytes)))
		tlv = append(tlv, commentBytes...)
		var extLenBuf [2]byte
		binary.LittleEndian.PutUint16(extLenBuf[:], uint16(len(tlv)))
		reordered = append(reordered, extLenBuf[:]...)
		reordered = append(reordered, tlv...)

		dec2, err := DecodeBinaryOrderFastReq(reordered)
		if err != nil {
			t.Fatalf("DecodeBinaryOrderFastReq (magic first) failed: %v", err)
		}
		if dec2.Comment != req.Comment || dec2.Magic != req.Magic {
			t.Fatalf("decoded (magic first) = (%q, %d), want (%q, %d)", dec2.Comment, dec2.Magic, req.Comment, req.Magic)
		}
	})
}

func TestBinaryOrderFastReqFlagClearIgnoresTrailingGarbage(t *testing.T) {
	req := BinaryOrderFastReq{
		Action:        BinaryOrderActionPlaceMarket,
		Side:          BinaryOrderSideSell,
		AccountLogin:  200074,
		Volume:        0.10,
		Symbol:        PackBinarySymbol("XAUUSD"),
		ClientOrderID: PackBinaryClientOrderID("cid-trailing"),
		AuthToken:     "jwt-tok",
	}
	encoded := EncodeBinaryOrderFastReq(req)
	withGarbage := append(append([]byte{}, encoded...), 0xff, 0x00, 0x01, 0x99, 0xab)

	// Pre-populate out with stale Comment/Magic to verify they are cleared when flag is clear.
	out := BinaryOrderFastReq{
		Comment: "stale-comment",
		Magic:   123456,
	}
	if err := DecodeBinaryOrderFastReqInto(withGarbage, &out); err != nil {
		t.Fatalf("expected flag-clear frame with trailing garbage to decode, got err: %v", err)
	}
	if out.Comment != "" || out.Magic != 0 {
		t.Fatalf("expected Comment and Magic cleared when flag is clear, got Comment=%q Magic=%d", out.Comment, out.Magic)
	}
	if off, err := BinaryOrderExtrasOffset(withGarbage); err != nil || off != -1 {
		t.Fatalf("BinaryOrderExtrasOffset = (%d, %v), want (-1, nil)", off, err)
	}
}

func TestBinaryOrderFastReqUnknownTagSkipped(t *testing.T) {
	req := BinaryOrderFastReq{
		Action:        BinaryOrderActionPlaceMarket,
		Side:          BinaryOrderSideBuy,
		Flags:         BinaryOrderFlagHasExtras,
		AccountLogin:  200074,
		Volume:        0.20,
		Symbol:        PackBinarySymbol("EURUSD"),
		ClientOrderID: PackBinaryClientOrderID("cid-unknown-tag"),
		AuthToken:     "tok",
	}
	// Encode base frame without extras, then set flag and append custom TLV with unknown tags.
	base := EncodeBinaryOrderFastReq(req)
	binary.LittleEndian.PutUint16(base[4:6], BinaryOrderFlagHasExtras)

	var magicLE [8]byte
	binary.LittleEndian.PutUint64(magicLE[:], 42)

	var tlv []byte
	tlv = append(tlv, 0x7f, 4, 0xde, 0xad, 0xbe, 0xef) // unknown tag 0x7f (4B)
	tlv = append(tlv, BinaryOrderExtraTagComment, 10)
	tlv = append(tlv, []byte("fwd-compat")...)
	tlv = append(tlv, 0xfe, 0) // unknown tag 0xfe (0B)
	tlv = append(tlv, BinaryOrderExtraTagMagic, 8)
	tlv = append(tlv, magicLE[:]...)

	var extHdr [2]byte
	binary.LittleEndian.PutUint16(extHdr[:], uint16(len(tlv)))
	frame := append(append(base, extHdr[:]...), tlv...)

	dec, err := DecodeBinaryOrderFastReq(frame)
	if err != nil {
		t.Fatalf("expected unknown tags to be skipped, got err: %v", err)
	}
	if dec.Comment != "fwd-compat" || dec.Magic != 42 {
		t.Fatalf("decoded = (%q, %d), want (\"fwd-compat\", 42)", dec.Comment, dec.Magic)
	}
}

func TestBinaryOrderFastReqInvalidExtrasRejected(t *testing.T) {
	makeBaseWithFlag := func() []byte {
		b := EncodeBinaryOrderFastReq(BinaryOrderFastReq{
			Action:        BinaryOrderActionPlaceMarket,
			Side:          BinaryOrderSideBuy,
			AccountLogin:  200074,
			Volume:        0.10,
			Symbol:        PackBinarySymbol("EURUSD"),
			ClientOrderID: PackBinaryClientOrderID("cid-invalid-ext"),
			AuthToken:     "tok",
		})
		binary.LittleEndian.PutUint16(b[4:6], BinaryOrderFlagHasExtras)
		return b
	}

	withTLV := func(tlv []byte) []byte {
		base := makeBaseWithFlag()
		var extHdr [2]byte
		binary.LittleEndian.PutUint16(extHdr[:], uint16(len(tlv)))
		return append(append(base, extHdr[:]...), tlv...)
	}

	var magicLE [8]byte
	binary.LittleEndian.PutUint64(magicLE[:], 12345)

	cases := []struct {
		name  string
		frame []byte
	}{
		{
			name:  "flag set but extrasLen missing (0 bytes after token)",
			frame: makeBaseWithFlag(),
		},
		{
			name:  "flag set but extrasLen truncated (1 byte after token)",
			frame: append(makeBaseWithFlag(), 0x05),
		},
		{
			name:  "flag set with extrasLen == 0",
			frame: append(makeBaseWithFlag(), 0x00, 0x00),
		},
		{
			name: "extrasLen > 512 (oversized 513 bytes)",
			frame: func() []byte {
				base := makeBaseWithFlag()
				var extHdr [2]byte
				binary.LittleEndian.PutUint16(extHdr[:], 513)
				return append(append(base, extHdr[:]...), make([]byte, 513)...)
			}(),
		},
		{
			name:  "truncated TLV block (extrasLen=10, only 4 bytes present)",
			frame: append(makeBaseWithFlag(), 10, 0, 0x01, 0x02, 'a', 'b'),
		},
		{
			name:  "truncated TLV entry header (1 trailing byte inside extrasLen)",
			frame: withTLV([]byte{0x01, 0x02, 'h', 'i', 0x02}),
		},
		{
			name:  "truncated TLV entry value (entryLen extends past extrasLen)",
			frame: withTLV([]byte{0x01, 0x05, 'a', 'b'}),
		},
		{
			name:  "duplicate COMMENT tag",
			frame: withTLV([]byte{0x01, 0x01, 'a', 0x01, 0x01, 'b'}),
		},
		{
			name: "duplicate MAGIC tag",
			frame: func() []byte {
				var tlv []byte
				tlv = append(tlv, 0x02, 8)
				tlv = append(tlv, magicLE[:]...)
				tlv = append(tlv, 0x02, 8)
				tlv = append(tlv, magicLE[:]...)
				return withTLV(tlv)
			}(),
		},
		{
			name:  "duplicate unknown tag",
			frame: withTLV([]byte{0x99, 0x01, 0x01, 0x99, 0x01, 0x02}),
		},
		{
			name:  "empty COMMENT (len 0)",
			frame: withTLV([]byte{0x01, 0x00}),
		},
		{
			name:  "oversized COMMENT (65 bytes > 64 max)",
			frame: withTLV(append([]byte{0x01, 65}, []byte(strings.Repeat("x", 65))...)),
		},
		{
			name:  "COMMENT with NUL byte",
			frame: withTLV([]byte{0x01, 0x05, 'a', 'b', 0x00, 'c', 'd'}),
		},
		{
			name:  "COMMENT with invalid UTF-8",
			frame: withTLV([]byte{0x01, 0x03, 0xff, 0xfe, 0xfd}),
		},
		{
			name:  "MAGIC with bad length 4",
			frame: withTLV([]byte{0x02, 0x04, 1, 2, 3, 4}),
		},
		{
			name:  "MAGIC with bad length 9",
			frame: withTLV([]byte{0x02, 0x09, 1, 2, 3, 4, 5, 6, 7, 8, 9}),
		},
		{
			name:  "MAGIC with zero value",
			frame: withTLV([]byte{0x02, 0x08, 0, 0, 0, 0, 0, 0, 0, 0}),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeBinaryOrderFastReq(tc.frame)
			if !errors.Is(err, ErrInvalidBinaryOrderReq) {
				t.Fatalf("DecodeBinaryOrderFastReq(%s) err = %v, want ErrInvalidBinaryOrderReq", tc.name, err)
			}
		})
	}

	// Also verify Validate() rejects struct-level invalid comments.
	validReq := BinaryOrderFastReq{
		Action:        BinaryOrderActionPlaceMarket,
		Side:          BinaryOrderSideBuy,
		AccountLogin:  200074,
		Volume:        0.10,
		Symbol:        PackBinarySymbol("EURUSD"),
		ClientOrderID: PackBinaryClientOrderID("cid-val"),
	}
	overComment := validReq
	overComment.Comment = strings.Repeat("a", 65)
	if err := overComment.Validate(); !errors.Is(err, ErrInvalidBinaryOrderReq) {
		t.Fatalf("Validate(65B comment) = %v, want ErrInvalidBinaryOrderReq", err)
	}
	nulComment := validReq
	nulComment.Comment = "bad\x00comment"
	if err := nulComment.Validate(); !errors.Is(err, ErrInvalidBinaryOrderReq) {
		t.Fatalf("Validate(NUL comment) = %v, want ErrInvalidBinaryOrderReq", err)
	}
}

func BenchmarkAppendBinaryOrderFastReqNoExtras(b *testing.B) {
	req := BinaryOrderFastReq{
		Action:        BinaryOrderActionPlaceMarket,
		Side:          BinaryOrderSideBuy,
		Flags:         BinaryOrderFlagHasSL | BinaryOrderFlagHasTP,
		AccountLogin:  200074,
		Ticket:        999001,
		Volume:        0.10,
		SL:            1.08000,
		TP:            1.09200,
		Symbol:        PackBinarySymbol("EURUSD"),
		ClientOrderID: PackBinaryClientOrderID("bench-no-extras-001"),
		AuthToken:     "jwt-bench-token-1234567890",
	}
	buf := make([]byte, 0, 256)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		out := AppendBinaryOrderFastReq(buf[:0], req)
		if len(out) == 0 {
			b.Fatal("empty")
		}
	}
}

func BenchmarkAppendBinaryOrderFastReqWithExtras(b *testing.B) {
	req := BinaryOrderFastReq{
		Action:        BinaryOrderActionPlaceMarket,
		Side:          BinaryOrderSideBuy,
		Flags:         BinaryOrderFlagHasSL | BinaryOrderFlagHasTP,
		AccountLogin:  200074,
		Ticket:        999001,
		Volume:        0.10,
		SL:            1.08000,
		TP:            1.09200,
		Symbol:        PackBinarySymbol("EURUSD"),
		ClientOrderID: PackBinaryClientOrderID("bench-with-extras-001"),
		AuthToken:     "jwt-bench-token-1234567890",
		Comment:       "scalp-bot-v2",
		Magic:         20261107,
	}
	buf := make([]byte, 0, 256)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		out := AppendBinaryOrderFastReq(buf[:0], req)
		if len(out) == 0 {
			b.Fatal("empty")
		}
	}
}

func BenchmarkDecodeBinaryOrderFastReqIntoNoExtras(b *testing.B) {
	req := BinaryOrderFastReq{
		Action:        BinaryOrderActionPlaceMarket,
		Side:          BinaryOrderSideBuy,
		Flags:         BinaryOrderFlagHasSL | BinaryOrderFlagHasTP,
		AccountLogin:  200074,
		Ticket:        999001,
		Volume:        0.10,
		SL:            1.08000,
		TP:            1.09200,
		Symbol:        PackBinarySymbol("EURUSD"),
		ClientOrderID: PackBinaryClientOrderID("bench-no-extras-001"),
		AuthToken:     "",
	}
	payload := EncodeBinaryOrderFastReq(req)
	var out BinaryOrderFastReq
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := DecodeBinaryOrderFastReqInto(payload, &out); err != nil {
			b.Fatal(err)
		}
		if err := out.Validate(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkDecodeBinaryOrderFastReqIntoWithExtras(b *testing.B) {
	req := BinaryOrderFastReq{
		Action:        BinaryOrderActionPlaceMarket,
		Side:          BinaryOrderSideBuy,
		Flags:         BinaryOrderFlagHasSL | BinaryOrderFlagHasTP,
		AccountLogin:  200074,
		Ticket:        999001,
		Volume:        0.10,
		SL:            1.08000,
		TP:            1.09200,
		Symbol:        PackBinarySymbol("EURUSD"),
		ClientOrderID: PackBinaryClientOrderID("bench-with-extras-001"),
		AuthToken:     "",
		Comment:       "scalp-bot-v2",
		Magic:         20261107,
	}
	payload := EncodeBinaryOrderFastReq(req)
	var out BinaryOrderFastReq
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := DecodeBinaryOrderFastReqInto(payload, &out); err != nil {
			b.Fatal(err)
		}
		if err := out.Validate(); err != nil {
			b.Fatal(err)
		}
	}
}
