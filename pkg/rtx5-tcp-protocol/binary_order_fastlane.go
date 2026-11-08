package rtx5tcp

import (
	"encoding/binary"
	"errors"
	"math"
	"unicode/utf8"
)

// Compile-time assertion that BinarySymbolMaxBytes (declared in binary_ticks.go) is 16.
const _ = uint(16-BinarySymbolMaxBytes) + uint(BinarySymbolMaxBytes-16)

const (
	// BinaryOrderCodecVersion identifies the wire layout of BinaryOrderFastReq and BinaryOrderFastResp.
	BinaryOrderCodecVersion uint8 = 1

	// BinaryClientOrderIDMaxBytes is the fixed ASCII/UTF-8 client order ID slot size (8-byte aligned).
	// Note: BinarySymbolMaxBytes = 16 is defined in binary_ticks.go within package rtx5tcp.
	BinaryClientOrderIDMaxBytes = 40

	// BinaryOrderFastReqHeaderSize is the fixed 128-byte (exact 2 CPU L1 cache lines) Little-Endian
	// request header before the uint16 TokenLen + UTF-8 AuthToken trailer:
	//   [0]               Version        uint8    (BinaryOrderCodecVersion = 1)
	//   [1]               Action         uint8    (1..8 MT5 trading actions)
	//   [2]               Side           uint8    (0 = None, 1 = Buy, 2 = Sell)
	//   [3]               OrderSubType   uint8    (0 = Market, 1..6 = Pending subtypes)
	//   [4..5]            Flags          uint16   (bitmask, LE)
	//   [6..7]            Reserved       uint16   (0x0000, LE)
	//   [8..15]           AccountLogin   int64    (MT5/RTX5 trader login, LE)
	//   [16..23]          Ticket         int64    (PositionTicket or OrderTicket, LE)
	//   [24..31]          Volume         float64  (IEEE-754 lots, LE)
	//   [32..39]          Price          float64  (IEEE-754 pending trigger/entry price, LE)
	//   [40..47]          StopLimitPrice float64  (IEEE-754 stop-limit order price, LE)
	//   [48..55]          SL             float64  (IEEE-754 stop loss price, LE)
	//   [56..63]          TP             float64  (IEEE-754 take profit price, LE)
	//   [64..71]          Expiration     int64    (Unix epoch timestamp; 0 = GTC, LE)
	//   [72..87]          Symbol         [16]byte (ASCII uppercase, null-padded)
	//   [88..127]         ClientOrderID  [40]byte (ASCII/UTF-8, null-padded)
	//   [128..129]        TokenLen       uint16   (byte length of trailing UTF-8 AuthToken, LE)
	//   [130..130+Len]    AuthToken      []byte   (UTF-8 AuthToken bytes)
	//   [optional]        ExtrasLen      uint16   (present when BinaryOrderFlagHasExtras is set, LE)
	//   [optional]        ExtrasTLV      []byte   (TLV entries: 0x01 Comment UTF-8 1..64B, 0x02 Magic i64 LE 8B)
	BinaryOrderFastReqHeaderSize = 128

	// BinaryOrderFastRespHeaderSize is the fixed 136-byte Little-Endian response header
	// before the length-prefixed ErrorCode and Message trailers:
	//   [0]               Version        uint8    (BinaryOrderCodecVersion = 1)
	//   [1]               Action         uint8    (echoed BinaryOrderAction*)
	//   [2..3]            Status         uint16   (200 = OK, >=400 = error/rejection, LE)
	//   [4..7]            ExecMicros     uint32   (execution latency in microseconds, LE)
	//   [8..15]           OrderTicket    int64    (LE)
	//   [16..23]          PositionTicket int64    (LE)
	//   [24..31]          DealTicket     int64    (LE)
	//   [32..39]          FillPrice      float64  (IEEE-754 executed/order price, LE)
	//   [40..47]          Volume         float64  (IEEE-754 executed/order lots, LE)
	//   [48..55]          Profit         float64  (IEEE-754 realized P&L on close, LE)
	//   [56..63]          Commission     float64  (IEEE-754 deal commission, LE)
	//   [64..71]          SL             float64  (IEEE-754 active stop loss, LE)
	//   [72..79]          TP             float64  (IEEE-754 active take profit, LE)
	//   [80..95]          Symbol         [16]byte (ASCII uppercase, null-padded)
	//   [96..135]         ClientOrderID  [40]byte (ASCII/UTF-8, null-padded)
	//   [136..137]        ErrCodeLen     uint16   (byte length of ErrorCode, LE)
	//   [138..138+ELen]   ErrorCode      []byte   (UTF-8 ErrorCode bytes)
	//   [138+ELen..+2]    MsgLen         uint16   (byte length of Message, LE)
	//   [140+ELen..+MLen] Message        []byte   (UTF-8 Message bytes)
	BinaryOrderFastRespHeaderSize = 136

	// Binary Order Actions (all 8 MT5 production trading actions)
	BinaryOrderActionPlaceMarket    uint8 = 1
	BinaryOrderActionClosePosition  uint8 = 2
	BinaryOrderActionModifyPosition uint8 = 3
	BinaryOrderActionPlacePending   uint8 = 4
	BinaryOrderActionModifyPending  uint8 = 5
	BinaryOrderActionCancelPending  uint8 = 6
	BinaryOrderActionCloseBulk      uint8 = 7
	BinaryOrderActionCloseBy        uint8 = 8

	// Bulk Close Filter SubTypes (OrderSubType when Action == BinaryOrderActionCloseBulk)
	BinaryCloseBulkAll      uint8 = 0
	BinaryCloseBulkWinners  uint8 = 1
	BinaryCloseBulkLosers   uint8 = 2
	BinaryCloseBulkBuyOnly  uint8 = 3
	BinaryCloseBulkSellOnly uint8 = 4

	// Binary Order Sides
	BinaryOrderSideNone uint8 = 0
	BinaryOrderSideBuy  uint8 = 1
	BinaryOrderSideSell uint8 = 2

	// Pending Order SubTypes
	BinaryOrderSubTypeMarket        uint8 = 0
	BinaryOrderSubTypeBuyLimit      uint8 = 1
	BinaryOrderSubTypeSellLimit     uint8 = 2
	BinaryOrderSubTypeBuyStop       uint8 = 3
	BinaryOrderSubTypeSellStop      uint8 = 4
	BinaryOrderSubTypeBuyStopLimit  uint8 = 5
	BinaryOrderSubTypeSellStopLimit uint8 = 6

	// Binary Order Request Flags
	BinaryOrderFlagNone          uint16 = 0
	BinaryOrderFlagHasSL         uint16 = 0x0001
	BinaryOrderFlagHasTP         uint16 = 0x0002
	BinaryOrderFlagPartialClose  uint16 = 0x0004
	BinaryOrderFlagClearSL       uint16 = 0x0008
	BinaryOrderFlagClearTP       uint16 = 0x0010
	BinaryOrderFlagHasPrice      uint16 = 0x0020
	BinaryOrderFlagHasStopLimit  uint16 = 0x0040
	BinaryOrderFlagHasExpiration uint16 = 0x0080
	BinaryOrderFlagHasTrailing   uint16 = 0x0100
	BinaryOrderFlagClearTrailing uint16 = 0x0200
	BinaryOrderFlagHasExtras     uint16 = 0x0400

	// Binary Order Extras TLV tags and limits (present after AuthToken when BinaryOrderFlagHasExtras is set)
	BinaryOrderExtraTagComment uint8 = 0x01
	BinaryOrderExtraTagMagic   uint8 = 0x02

	BinaryOrderCommentMaxBytes = 64
	BinaryOrderMagicByteLen    = 8
	BinaryOrderExtrasMaxBytes  = 512

	// Binary Order Response Statuses (HTTP-aligned)
	BinaryOrderStatusOK           uint16 = 200
	BinaryOrderStatusBadRequest   uint16 = 400
	BinaryOrderStatusUnauthorized uint16 = 401
	BinaryOrderStatusForbidden    uint16 = 403
	BinaryOrderStatusNotFound     uint16 = 404
	BinaryOrderStatusConflict     uint16 = 409
	BinaryOrderStatusRejected     uint16 = 422
	BinaryOrderStatusInternalErr  uint16 = 500
)

var (
	ErrTruncatedBinaryOrderFrame = errors.New("rtx5tcp: truncated binary order fastlane frame")
	ErrUnsupportedBinaryOrderVer = errors.New("rtx5tcp: unsupported binary order codec version")
	ErrInvalidBinaryOrderReq     = errors.New("rtx5tcp: invalid binary order fastlane request parameters")
)

// BinaryOrderFastReq is the zero-JSON native Binary TCP trading request supporting all MT5 production actions.
type BinaryOrderFastReq struct {
	Action         uint8
	Side           uint8
	OrderSubType   uint8
	Flags          uint16
	AccountLogin   int64
	Ticket         int64 // PositionTicket (ClosePosition/ModifyPosition) or OrderTicket (ModifyPending/CancelPending)
	Volume         float64
	Price          float64
	StopLimitPrice float64
	SL             float64
	TP             float64
	Expiration     int64
	Symbol         [BinarySymbolMaxBytes]byte
	ClientOrderID  [BinaryClientOrderIDMaxBytes]byte
	AuthToken      string
	Comment        string
	Magic          int64
}

// BinaryOrderFastResp is the zero-JSON native Binary TCP trading response for all MT5 production actions.
type BinaryOrderFastResp struct {
	Action         uint8
	Status         uint16
	ExecMicros     uint32
	OrderTicket    int64
	PositionTicket int64
	DealTicket     int64
	FillPrice      float64
	Volume         float64
	Profit         float64
	Commission     float64
	SL             float64
	TP             float64
	Symbol         [BinarySymbolMaxBytes]byte
	ClientOrderID  [BinaryClientOrderIDMaxBytes]byte
	ErrorCode      string
	Message        string
}

// PackBinarySymbol packs an ASCII symbol string into an uppercase, null-padded [16]byte without heap allocations.
func PackBinarySymbol(sym string) [BinarySymbolMaxBytes]byte {
	var out [BinarySymbolMaxBytes]byte
	start := 0
	end := len(sym)
	for start < end && (sym[start] == ' ' || sym[start] == '\t' || sym[start] == '\r' || sym[start] == '\n') {
		start++
	}
	for end > start && (sym[end-1] == ' ' || sym[end-1] == '\t' || sym[end-1] == '\r' || sym[end-1] == '\n') {
		end--
	}
	n := end - start
	if n > BinarySymbolMaxBytes {
		n = BinarySymbolMaxBytes
	}
	for i := 0; i < n; i++ {
		c := sym[start+i]
		if c >= 'a' && c <= 'z' {
			c -= 32
		}
		out[i] = c
	}
	return out
}

// UnpackBinarySymbol extracts the null-terminated symbol string from a [16]byte slot.
func UnpackBinarySymbol(buf [BinarySymbolMaxBytes]byte) string {
	end := 0
	for end < BinarySymbolMaxBytes && buf[end] != 0 {
		end++
	}
	if end == 0 {
		return ""
	}
	return string(buf[:end])
}

// PackBinaryClientOrderID packs a client order ID string into a null-padded [40]byte without heap allocations.
func PackBinaryClientOrderID(id string) [BinaryClientOrderIDMaxBytes]byte {
	var out [BinaryClientOrderIDMaxBytes]byte
	start := 0
	end := len(id)
	for start < end && (id[start] == ' ' || id[start] == '\t' || id[start] == '\r' || id[start] == '\n') {
		start++
	}
	for end > start && (id[end-1] == ' ' || id[end-1] == '\t' || id[end-1] == '\r' || id[end-1] == '\n') {
		end--
	}
	n := end - start
	if n > BinaryClientOrderIDMaxBytes {
		n = BinaryClientOrderIDMaxBytes
	}
	for i := 0; i < n; i++ {
		out[i] = id[start+i]
	}
	return out
}

// UnpackBinaryClientOrderID extracts the null-terminated client order ID string from a [40]byte slot.
func UnpackBinaryClientOrderID(buf [BinaryClientOrderIDMaxBytes]byte) string {
	end := 0
	for end < BinaryClientOrderIDMaxBytes && buf[end] != 0 {
		end++
	}
	if end == 0 {
		return ""
	}
	return string(buf[:end])
}

func (r *BinaryOrderFastReq) SetSymbol(sym string)        { r.Symbol = PackBinarySymbol(sym) }
func (r BinaryOrderFastReq) SymbolString() string         { return UnpackBinarySymbol(r.Symbol) }
func (r *BinaryOrderFastReq) SetClientOrderID(id string)  { r.ClientOrderID = PackBinaryClientOrderID(id) }
func (r BinaryOrderFastReq) ClientOrderIDString() string  { return UnpackBinaryClientOrderID(r.ClientOrderID) }
func (r BinaryOrderFastReq) PositionTicketID() int64      { return r.Ticket }
func (r *BinaryOrderFastReq) SetPositionTicket(id int64)  { r.Ticket = id }
func (r BinaryOrderFastReq) OrderTicketID() int64         { return r.Ticket }
func (r *BinaryOrderFastReq) SetOrderTicket(id int64)     { r.Ticket = id }

func (r *BinaryOrderFastResp) SetSymbol(sym string)       { r.Symbol = PackBinarySymbol(sym) }
func (r BinaryOrderFastResp) SymbolString() string        { return UnpackBinarySymbol(r.Symbol) }
func (r *BinaryOrderFastResp) SetClientOrderID(id string) { r.ClientOrderID = PackBinaryClientOrderID(id) }
func (r BinaryOrderFastResp) ClientOrderIDString() string { return UnpackBinaryClientOrderID(r.ClientOrderID) }
func (r BinaryOrderFastResp) IsOK() bool                  { return r.Status >= 200 && r.Status < 300 }

func isValidBinaryOrderCommentBytes(b []byte) bool {
	if len(b) == 0 || len(b) > BinaryOrderCommentMaxBytes {
		return false
	}
	for i := 0; i < len(b); i++ {
		if b[i] == 0 {
			return false
		}
	}
	return utf8.Valid(b)
}

func isValidBinaryOrderCommentString(s string) bool {
	if len(s) == 0 || len(s) > BinaryOrderCommentMaxBytes {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] == 0 {
			return false
		}
	}
	return utf8.ValidString(s)
}

// Validate performs fast zero-allocation domain sanity checks on a decoded BinaryOrderFastReq
// across all MT5 production trading actions.
func (r BinaryOrderFastReq) Validate() error {
	if math.IsNaN(r.Volume) || math.IsInf(r.Volume, 0) || r.Volume < 0 ||
		math.IsNaN(r.Price) || math.IsInf(r.Price, 0) || r.Price < 0 ||
		math.IsNaN(r.StopLimitPrice) || math.IsInf(r.StopLimitPrice, 0) || r.StopLimitPrice < 0 ||
		math.IsNaN(r.SL) || math.IsInf(r.SL, 0) || r.SL < 0 ||
		math.IsNaN(r.TP) || math.IsInf(r.TP, 0) || r.TP < 0 ||
		r.Expiration < 0 {
		return ErrInvalidBinaryOrderReq
	}
	if ((r.Flags&BinaryOrderFlagHasSL) != 0 && (r.Flags&BinaryOrderFlagClearSL) != 0) ||
		((r.Flags&BinaryOrderFlagHasTP) != 0 && (r.Flags&BinaryOrderFlagClearTP) != 0) {
		return ErrInvalidBinaryOrderReq
	}
	if len(r.Comment) != 0 && !isValidBinaryOrderCommentString(r.Comment) {
		return ErrInvalidBinaryOrderReq
	}

	switch r.Action {
	case BinaryOrderActionPlaceMarket:
		if (r.Side != BinaryOrderSideBuy && r.Side != BinaryOrderSideSell) ||
			r.Symbol[0] == 0 ||
			r.Volume <= 0 {
			return ErrInvalidBinaryOrderReq
		}
		return nil

	case BinaryOrderActionClosePosition:
		if r.Ticket <= 0 {
			return ErrInvalidBinaryOrderReq
		}
		if (r.Flags&BinaryOrderFlagPartialClose) != 0 && r.Volume <= 0 {
			return ErrInvalidBinaryOrderReq
		}
		return nil

	case BinaryOrderActionModifyPosition:
		if r.Ticket <= 0 {
			return ErrInvalidBinaryOrderReq
		}
		return nil

	case BinaryOrderActionPlacePending:
		if r.Symbol[0] == 0 || r.Volume <= 0 || r.Price <= 0 {
			return ErrInvalidBinaryOrderReq
		}
		switch r.OrderSubType {
		case BinaryOrderSubTypeBuyLimit, BinaryOrderSubTypeBuyStop:
			if r.Side != BinaryOrderSideNone && r.Side != BinaryOrderSideBuy {
				return ErrInvalidBinaryOrderReq
			}
		case BinaryOrderSubTypeSellLimit, BinaryOrderSubTypeSellStop:
			if r.Side != BinaryOrderSideNone && r.Side != BinaryOrderSideSell {
				return ErrInvalidBinaryOrderReq
			}
		case BinaryOrderSubTypeBuyStopLimit:
			if (r.Side != BinaryOrderSideNone && r.Side != BinaryOrderSideBuy) || r.StopLimitPrice <= 0 {
				return ErrInvalidBinaryOrderReq
			}
		case BinaryOrderSubTypeSellStopLimit:
			if (r.Side != BinaryOrderSideNone && r.Side != BinaryOrderSideSell) || r.StopLimitPrice <= 0 {
				return ErrInvalidBinaryOrderReq
			}
		default:
			return ErrInvalidBinaryOrderReq
		}
		return nil

	case BinaryOrderActionModifyPending:
		if r.Ticket <= 0 {
			return ErrInvalidBinaryOrderReq
		}
		if (r.Flags&BinaryOrderFlagHasPrice) != 0 && r.Price <= 0 {
			return ErrInvalidBinaryOrderReq
		}
		if (r.Flags&BinaryOrderFlagHasStopLimit) != 0 && r.StopLimitPrice <= 0 {
			return ErrInvalidBinaryOrderReq
		}
		return nil

	case BinaryOrderActionCancelPending:
		if r.Ticket <= 0 {
			return ErrInvalidBinaryOrderReq
		}
		return nil

	case BinaryOrderActionCloseBulk:
		if r.AccountLogin <= 0 {
			return errors.New("account_login required for close_bulk")
		}
		if r.OrderSubType > BinaryCloseBulkSellOnly {
			return errors.New("invalid close_bulk filter subtype")
		}
		return nil

	case BinaryOrderActionCloseBy:
		otherTicket := r.Expiration
		if otherTicket <= 0 && r.Price > 0 {
			otherTicket = int64(math.Round(r.Price))
		}
		if r.Ticket <= 0 || otherTicket <= 0 || r.Ticket == otherTicket {
			return ErrInvalidBinaryOrderReq
		}
		return nil

	default:
		return ErrInvalidBinaryOrderReq
	}
}

func putNormalizedFixedSymbol(dst []byte, src [BinarySymbolMaxBytes]byte) {
	clear(dst[:BinarySymbolMaxBytes])
	for i := 0; i < BinarySymbolMaxBytes; i++ {
		c := src[i]
		if c == 0 {
			return
		}
		if c >= 'a' && c <= 'z' {
			c -= 32
		}
		dst[i] = c
	}
}

func readNormalizedFixedSymbol(dst *[BinarySymbolMaxBytes]byte, src []byte) {
	_ = src[BinarySymbolMaxBytes-1]
	*dst = [BinarySymbolMaxBytes]byte{}
	for i := 0; i < BinarySymbolMaxBytes; i++ {
		c := src[i]
		if c == 0 {
			return
		}
		if c >= 'a' && c <= 'z' {
			c -= 32
		}
		dst[i] = c
	}
}

func putNormalizedFixedBytes40(dst []byte, src [BinaryClientOrderIDMaxBytes]byte) {
	clear(dst[:BinaryClientOrderIDMaxBytes])
	for i := 0; i < BinaryClientOrderIDMaxBytes; i++ {
		c := src[i]
		if c == 0 {
			return
		}
		dst[i] = c
	}
}

func readNormalizedFixedBytes40(dst *[BinaryClientOrderIDMaxBytes]byte, src []byte) {
	_ = src[BinaryClientOrderIDMaxBytes-1]
	*dst = [BinaryClientOrderIDMaxBytes]byte{}
	for i := 0; i < BinaryClientOrderIDMaxBytes; i++ {
		c := src[i]
		if c == 0 {
			return
		}
		dst[i] = c
	}
}

// BinaryOrderExtrasOffset returns the byte offset of the [u16 LE extrasLen][TLV] block
// within a canonical BinaryOrderFastReq payload when BinaryOrderFlagHasExtras is set,
// or (-1, nil) when the flag is clear.
func BinaryOrderExtrasOffset(payload []byte) (int, error) {
	if len(payload) < BinaryOrderFastReqHeaderSize {
		return -1, ErrTruncatedBinaryOrderFrame
	}
	if payload[0] != BinaryOrderCodecVersion {
		return -1, ErrUnsupportedBinaryOrderVer
	}
	if len(payload) < BinaryOrderFastReqHeaderSize+2 {
		return -1, ErrTruncatedBinaryOrderFrame
	}
	tokenLen := int(binary.LittleEndian.Uint16(payload[128:130]))
	off := BinaryOrderFastReqHeaderSize + 2 + tokenLen
	if len(payload) < off {
		return -1, ErrTruncatedBinaryOrderFrame
	}
	flags := binary.LittleEndian.Uint16(payload[4:6])
	if (flags & BinaryOrderFlagHasExtras) == 0 {
		return -1, nil
	}
	if len(payload) < off+2 {
		return -1, ErrInvalidBinaryOrderReq
	}
	return off, nil
}

// DecodeBinaryOrderExtrasBlock parses and strictly validates a [u16 LE extrasLen][TLV bytes] extras block.
// Unknown tags are skipped (forward compatible); duplicate tags, bad lengths, NUL/invalid UTF-8 comments,
// or zero/non-8-byte magic values return ErrInvalidBinaryOrderReq.
func DecodeBinaryOrderExtrasBlock(block []byte) (comment string, magic int64, totalBytes int, err error) {
	if len(block) < 2 {
		return "", 0, 0, ErrInvalidBinaryOrderReq
	}
	extrasLen := int(binary.LittleEndian.Uint16(block[0:2]))
	if extrasLen <= 0 || extrasLen > BinaryOrderExtrasMaxBytes {
		return "", 0, 0, ErrInvalidBinaryOrderReq
	}
	totalBytes = 2 + extrasLen
	if len(block) < totalBytes {
		return "", 0, 0, ErrInvalidBinaryOrderReq
	}

	tlv := block[2:totalBytes]
	var seenTags [4]uint64
	pos := 0
	for pos < len(tlv) {
		if pos+2 > len(tlv) {
			return "", 0, 0, ErrInvalidBinaryOrderReq
		}
		tag := tlv[pos]
		entryLen := int(tlv[pos+1])
		valStart := pos + 2
		valEnd := valStart + entryLen
		if valEnd > len(tlv) {
			return "", 0, 0, ErrInvalidBinaryOrderReq
		}

		word := tag >> 6
		bit := uint64(1) << (tag & 63)
		if (seenTags[word] & bit) != 0 {
			return "", 0, 0, ErrInvalidBinaryOrderReq
		}
		seenTags[word] |= bit

		switch tag {
		case BinaryOrderExtraTagComment:
			val := tlv[valStart:valEnd]
			if !isValidBinaryOrderCommentBytes(val) {
				return "", 0, 0, ErrInvalidBinaryOrderReq
			}
			comment = string(val)

		case BinaryOrderExtraTagMagic:
			if entryLen != BinaryOrderMagicByteLen {
				return "", 0, 0, ErrInvalidBinaryOrderReq
			}
			m := int64(binary.LittleEndian.Uint64(tlv[valStart:valEnd]))
			if m == 0 {
				return "", 0, 0, ErrInvalidBinaryOrderReq
			}
			magic = m

		default:
			// Unknown tag: skip for forward compatibility.
		}

		pos = valEnd
	}
	return comment, magic, totalBytes, nil
}

func appendBinaryOrderFastReqWithExtras(dst []byte, req BinaryOrderFastReq) []byte {
	tokenLen := len(req.AuthToken)
	if tokenLen > 65535 {
		tokenLen = 65535
	}
	commentLen := len(req.Comment)
	if commentLen > 255 {
		commentLen = 255
	}
	hasComment := commentLen > 0
	hasMagic := req.Magic != 0

	extrasPayloadLen := 0
	if hasComment {
		extrasPayloadLen += 2 + commentLen
	}
	if hasMagic {
		extrasPayloadLen += 2 + BinaryOrderMagicByteLen
	}

	needed := BinaryOrderFastReqHeaderSize + 2 + tokenLen + 2 + extrasPayloadLen
	off := len(dst)
	if cap(dst)-off >= needed {
		dst = dst[:off+needed]
	} else {
		grown := make([]byte, off+needed)
		copy(grown, dst)
		dst = grown
	}
	b := dst[off : off+needed]

	b[0] = BinaryOrderCodecVersion
	b[1] = req.Action
	b[2] = req.Side
	b[3] = req.OrderSubType
	binary.LittleEndian.PutUint16(b[4:6], req.Flags|BinaryOrderFlagHasExtras)
	binary.LittleEndian.PutUint16(b[6:8], 0)
	binary.LittleEndian.PutUint64(b[8:16], uint64(req.AccountLogin))
	binary.LittleEndian.PutUint64(b[16:24], uint64(req.Ticket))
	binary.LittleEndian.PutUint64(b[24:32], math.Float64bits(req.Volume))
	binary.LittleEndian.PutUint64(b[32:40], math.Float64bits(req.Price))
	binary.LittleEndian.PutUint64(b[40:48], math.Float64bits(req.StopLimitPrice))
	binary.LittleEndian.PutUint64(b[48:56], math.Float64bits(req.SL))
	binary.LittleEndian.PutUint64(b[56:64], math.Float64bits(req.TP))
	binary.LittleEndian.PutUint64(b[64:72], uint64(req.Expiration))
	putNormalizedFixedSymbol(b[72:88], req.Symbol)
	putNormalizedFixedBytes40(b[88:128], req.ClientOrderID)
	binary.LittleEndian.PutUint16(b[128:130], uint16(tokenLen))
	if tokenLen > 0 {
		copy(b[130:130+tokenLen], req.AuthToken[:tokenLen])
	}
	extOff := 130 + tokenLen
	binary.LittleEndian.PutUint16(b[extOff:extOff+2], uint16(extrasPayloadLen))
	pos := extOff + 2
	if hasComment {
		b[pos] = BinaryOrderExtraTagComment
		b[pos+1] = uint8(commentLen)
		copy(b[pos+2:pos+2+commentLen], req.Comment[:commentLen])
		pos += 2 + commentLen
	}
	if hasMagic {
		b[pos] = BinaryOrderExtraTagMagic
		b[pos+1] = BinaryOrderMagicByteLen
		binary.LittleEndian.PutUint64(b[pos+2:pos+2+BinaryOrderMagicByteLen], uint64(req.Magic))
	}
	return dst
}

// AppendBinaryOrderFastReq appends the 128-byte fixed Little-Endian header + uint16 TokenLen + UTF-8 AuthToken
// (+ [u16 LE extrasLen][TLV] when Comment != "" or Magic != 0) onto dst (0 allocs when cap(dst) suffices).
func AppendBinaryOrderFastReq(dst []byte, req BinaryOrderFastReq) []byte {
	if len(req.Comment) != 0 || req.Magic != 0 {
		return appendBinaryOrderFastReqWithExtras(dst, req)
	}
	tokenLen := len(req.AuthToken)
	if tokenLen > 65535 {
		tokenLen = 65535
	}
	needed := BinaryOrderFastReqHeaderSize + 2 + tokenLen
	off := len(dst)
	if cap(dst)-off >= needed {
		dst = dst[:off+needed]
	} else {
		grown := make([]byte, off+needed)
		copy(grown, dst)
		dst = grown
	}
	b := dst[off : off+needed]

	b[0] = BinaryOrderCodecVersion
	b[1] = req.Action
	b[2] = req.Side
	b[3] = req.OrderSubType
	binary.LittleEndian.PutUint16(b[4:6], req.Flags&^BinaryOrderFlagHasExtras)
	binary.LittleEndian.PutUint16(b[6:8], 0)
	binary.LittleEndian.PutUint64(b[8:16], uint64(req.AccountLogin))
	binary.LittleEndian.PutUint64(b[16:24], uint64(req.Ticket))
	binary.LittleEndian.PutUint64(b[24:32], math.Float64bits(req.Volume))
	binary.LittleEndian.PutUint64(b[32:40], math.Float64bits(req.Price))
	binary.LittleEndian.PutUint64(b[40:48], math.Float64bits(req.StopLimitPrice))
	binary.LittleEndian.PutUint64(b[48:56], math.Float64bits(req.SL))
	binary.LittleEndian.PutUint64(b[56:64], math.Float64bits(req.TP))
	binary.LittleEndian.PutUint64(b[64:72], uint64(req.Expiration))
	putNormalizedFixedSymbol(b[72:88], req.Symbol)
	putNormalizedFixedBytes40(b[88:128], req.ClientOrderID)
	binary.LittleEndian.PutUint16(b[128:130], uint16(tokenLen))
	if tokenLen > 0 {
		copy(b[130:130+tokenLen], req.AuthToken[:tokenLen])
	}
	return dst
}

// EncodeBinaryOrderFastReq encodes BinaryOrderFastReq into a single exact-sized byte slice.
func EncodeBinaryOrderFastReq(req BinaryOrderFastReq) []byte {
	tokenLen := len(req.AuthToken)
	if tokenLen > 65535 {
		tokenLen = 65535
	}
	if len(req.Comment) == 0 && req.Magic == 0 {
		buf := make([]byte, 0, BinaryOrderFastReqHeaderSize+2+tokenLen)
		return AppendBinaryOrderFastReq(buf, req)
	}
	commentLen := len(req.Comment)
	if commentLen > 255 {
		commentLen = 255
	}
	extrasTotal := 2
	if commentLen > 0 {
		extrasTotal += 2 + commentLen
	}
	if req.Magic != 0 {
		extrasTotal += 2 + BinaryOrderMagicByteLen
	}
	buf := make([]byte, 0, BinaryOrderFastReqHeaderSize+2+tokenLen+extrasTotal)
	return appendBinaryOrderFastReqWithExtras(buf, req)
}

func decodeBinaryOrderExtrasInto(block []byte, out *BinaryOrderFastReq) error {
	comment, magic, _, err := DecodeBinaryOrderExtrasBlock(block)
	if err != nil {
		*out = BinaryOrderFastReq{}
		return err
	}
	out.Comment = comment
	out.Magic = magic
	return nil
}

// DecodeBinaryOrderFastReqInto decodes payload into out without heap-allocating the struct.
func DecodeBinaryOrderFastReqInto(payload []byte, out *BinaryOrderFastReq) error {
	if out == nil {
		return ErrInvalidBinaryOrderReq
	}
	if len(payload) < BinaryOrderFastReqHeaderSize {
		return ErrTruncatedBinaryOrderFrame
	}
	if payload[0] != BinaryOrderCodecVersion {
		return ErrUnsupportedBinaryOrderVer
	}
	if len(payload) < BinaryOrderFastReqHeaderSize+2 {
		return ErrTruncatedBinaryOrderFrame
	}
	tokenLen := int(binary.LittleEndian.Uint16(payload[128:130]))
	afterToken := BinaryOrderFastReqHeaderSize + 2 + tokenLen
	if len(payload) < afterToken {
		return ErrTruncatedBinaryOrderFrame
	}

	out.Action = payload[1]
	out.Side = payload[2]
	out.OrderSubType = payload[3]
	out.Flags = binary.LittleEndian.Uint16(payload[4:6])
	out.AccountLogin = int64(binary.LittleEndian.Uint64(payload[8:16]))
	out.Ticket = int64(binary.LittleEndian.Uint64(payload[16:24]))
	out.Volume = math.Float64frombits(binary.LittleEndian.Uint64(payload[24:32]))
	out.Price = math.Float64frombits(binary.LittleEndian.Uint64(payload[32:40]))
	out.StopLimitPrice = math.Float64frombits(binary.LittleEndian.Uint64(payload[40:48]))
	out.SL = math.Float64frombits(binary.LittleEndian.Uint64(payload[48:56]))
	out.TP = math.Float64frombits(binary.LittleEndian.Uint64(payload[56:64]))
	out.Expiration = int64(binary.LittleEndian.Uint64(payload[64:72]))
	readNormalizedFixedSymbol(&out.Symbol, payload[72:88])
	readNormalizedFixedBytes40(&out.ClientOrderID, payload[88:128])
	if tokenLen > 0 {
		out.AuthToken = string(payload[130:afterToken])
	} else {
		out.AuthToken = ""
	}
	out.Comment = ""
	out.Magic = 0

	if (out.Flags & BinaryOrderFlagHasExtras) != 0 {
		return decodeBinaryOrderExtrasInto(payload[afterToken:], out)
	}
	return nil
}

// DecodeBinaryOrderFastReq decodes a Little-Endian BinaryOrderFastReq frame payload.
func DecodeBinaryOrderFastReq(payload []byte) (BinaryOrderFastReq, error) {
	var out BinaryOrderFastReq
	if err := DecodeBinaryOrderFastReqInto(payload, &out); err != nil {
		return BinaryOrderFastReq{}, err
	}
	return out, nil
}

// AppendBinaryOrderFastResp appends the 136-byte fixed Little-Endian header + uint16 ErrCodeLen + ErrCode +
// uint16 MsgLen + Msg onto dst (0 allocs when cap(dst) suffices).
func AppendBinaryOrderFastResp(dst []byte, resp BinaryOrderFastResp) []byte {
	errCodeLen := len(resp.ErrorCode)
	if errCodeLen > 65535 {
		errCodeLen = 65535
	}
	msgLen := len(resp.Message)
	if msgLen > 65535 {
		msgLen = 65535
	}
	needed := BinaryOrderFastRespHeaderSize + 4 + errCodeLen + msgLen
	off := len(dst)
	if cap(dst)-off >= needed {
		dst = dst[:off+needed]
	} else {
		grown := make([]byte, off+needed)
		copy(grown, dst)
		dst = grown
	}
	b := dst[off : off+needed]

	b[0] = BinaryOrderCodecVersion
	b[1] = resp.Action
	binary.LittleEndian.PutUint16(b[2:4], resp.Status)
	binary.LittleEndian.PutUint32(b[4:8], resp.ExecMicros)
	binary.LittleEndian.PutUint64(b[8:16], uint64(resp.OrderTicket))
	binary.LittleEndian.PutUint64(b[16:24], uint64(resp.PositionTicket))
	binary.LittleEndian.PutUint64(b[24:32], uint64(resp.DealTicket))
	binary.LittleEndian.PutUint64(b[32:40], math.Float64bits(resp.FillPrice))
	binary.LittleEndian.PutUint64(b[40:48], math.Float64bits(resp.Volume))
	binary.LittleEndian.PutUint64(b[48:56], math.Float64bits(resp.Profit))
	binary.LittleEndian.PutUint64(b[56:64], math.Float64bits(resp.Commission))
	binary.LittleEndian.PutUint64(b[64:72], math.Float64bits(resp.SL))
	binary.LittleEndian.PutUint64(b[72:80], math.Float64bits(resp.TP))
	putNormalizedFixedSymbol(b[80:96], resp.Symbol)
	putNormalizedFixedBytes40(b[96:136], resp.ClientOrderID)
	binary.LittleEndian.PutUint16(b[136:138], uint16(errCodeLen))
	if errCodeLen > 0 {
		copy(b[138:138+errCodeLen], resp.ErrorCode[:errCodeLen])
	}
	msgLenOff := 138 + errCodeLen
	binary.LittleEndian.PutUint16(b[msgLenOff:msgLenOff+2], uint16(msgLen))
	if msgLen > 0 {
		msgOff := msgLenOff + 2
		copy(b[msgOff:msgOff+msgLen], resp.Message[:msgLen])
	}
	return dst
}

// EncodeBinaryOrderFastResp encodes BinaryOrderFastResp into a single exact-sized byte slice.
func EncodeBinaryOrderFastResp(resp BinaryOrderFastResp) []byte {
	errCodeLen := len(resp.ErrorCode)
	if errCodeLen > 65535 {
		errCodeLen = 65535
	}
	msgLen := len(resp.Message)
	if msgLen > 65535 {
		msgLen = 65535
	}
	buf := make([]byte, 0, BinaryOrderFastRespHeaderSize+4+errCodeLen+msgLen)
	return AppendBinaryOrderFastResp(buf, resp)
}

// DecodeBinaryOrderFastRespInto decodes payload into out without heap-allocating the struct.
func DecodeBinaryOrderFastRespInto(payload []byte, out *BinaryOrderFastResp) error {
	if out == nil {
		return ErrInvalidBinaryOrderReq
	}
	if len(payload) < BinaryOrderFastRespHeaderSize {
		return ErrTruncatedBinaryOrderFrame
	}
	if payload[0] != BinaryOrderCodecVersion {
		return ErrUnsupportedBinaryOrderVer
	}
	if len(payload) < BinaryOrderFastRespHeaderSize+4 {
		return ErrTruncatedBinaryOrderFrame
	}
	errCodeLen := int(binary.LittleEndian.Uint16(payload[136:138]))
	if len(payload) < BinaryOrderFastRespHeaderSize+4+errCodeLen {
		return ErrTruncatedBinaryOrderFrame
	}
	msgLenOff := 138 + errCodeLen
	msgLen := int(binary.LittleEndian.Uint16(payload[msgLenOff : msgLenOff+2]))
	if len(payload) < BinaryOrderFastRespHeaderSize+4+errCodeLen+msgLen {
		return ErrTruncatedBinaryOrderFrame
	}

	out.Action = payload[1]
	out.Status = binary.LittleEndian.Uint16(payload[2:4])
	out.ExecMicros = binary.LittleEndian.Uint32(payload[4:8])
	out.OrderTicket = int64(binary.LittleEndian.Uint64(payload[8:16]))
	out.PositionTicket = int64(binary.LittleEndian.Uint64(payload[16:24]))
	out.DealTicket = int64(binary.LittleEndian.Uint64(payload[24:32]))
	out.FillPrice = math.Float64frombits(binary.LittleEndian.Uint64(payload[32:40]))
	out.Volume = math.Float64frombits(binary.LittleEndian.Uint64(payload[40:48]))
	out.Profit = math.Float64frombits(binary.LittleEndian.Uint64(payload[48:56]))
	out.Commission = math.Float64frombits(binary.LittleEndian.Uint64(payload[56:64]))
	out.SL = math.Float64frombits(binary.LittleEndian.Uint64(payload[64:72]))
	out.TP = math.Float64frombits(binary.LittleEndian.Uint64(payload[72:80]))
	readNormalizedFixedSymbol(&out.Symbol, payload[80:96])
	readNormalizedFixedBytes40(&out.ClientOrderID, payload[96:136])
	if errCodeLen > 0 {
		out.ErrorCode = string(payload[138 : 138+errCodeLen])
	} else {
		out.ErrorCode = ""
	}
	if msgLen > 0 {
		msgOff := msgLenOff + 2
		out.Message = string(payload[msgOff : msgOff+msgLen])
	} else {
		out.Message = ""
	}
	return nil
}

// DecodeBinaryOrderFastResp decodes a Little-Endian BinaryOrderFastResp frame payload.
func DecodeBinaryOrderFastResp(payload []byte) (BinaryOrderFastResp, error) {
	var out BinaryOrderFastResp
	if err := DecodeBinaryOrderFastRespInto(payload, &out); err != nil {
		return BinaryOrderFastResp{}, err
	}
	return out, nil
}
