package rtx5tcp

import (
	"encoding/binary"
	"errors"
	"math"
	"strings"
)

const (
	// BinarySymbolMaxBytes is the fixed ASCII symbol slot size (8-byte aligned).
	// Max enabled MT5 symbol length in public.instruments is 11 bytes.
	BinarySymbolMaxBytes = 16

	// BinaryTickRecordSize is the fixed 48-byte Little-Endian MT5 Binary Tick struct:
	//   [0..15]  Symbol      [16]byte (ASCII uppercase, null-padded)
	//   [16..23] TimestampMs int64    (Unix epoch milliseconds)
	//   [24..31] Bid         float64  (IEEE-754)
	//   [32..39] Ask         float64  (IEEE-754)
	//   [40..47] Sequence    uint64   (monotonic tick sequence)
	BinaryTickRecordSize = 48

	// BinaryCandleRecordSize is the fixed 64-byte (exact 1 CPU L1 cache line) Little-Endian MT5 Binary Candle struct:
	//   [0..15]  Symbol        [16]byte (ASCII uppercase, null-padded)
	//   [16..23] OpenTimeSec   int64    (Unix epoch seconds aligned to bucket boundary)
	//   [24..31] Open          float64  (IEEE-754 Bid open)
	//   [32..39] High          float64  (IEEE-754 Bid high)
	//   [40..47] Low           float64  (IEEE-754 Bid low)
	//   [48..55] Close         float64  (IEEE-754 Bid close)
	//   [56..59] TickVolume    uint32   (tick count in bucket)
	//   [60]     Flags         uint8    (0x01 = Closed/Finalized, 0x00 = Forming/Open)
	//   [61]     TimeframeCode uint8    (1=M1, 2=M5, 3=M15, 4=M30, 5=H1, 6=H4, 7=D1, 8=W1, 9=MN1)
	//   [62..63] Reserved      [2]byte
	BinaryCandleRecordSize = 64

	// BinaryDepthRecordSize is the fixed 360-byte Little-Endian MT5 Binary Market Depth struct:
	//   [0..15]    Symbol      [16]byte (ASCII uppercase, null-padded)
	//   [16..23]   TimestampMs int64    (Unix epoch milliseconds)
	//   [24..31]   Sequence    uint64   (monotonic depth sequence)
	//   [32]       BidCount    uint8    (0..BinaryDepthMaxLevels)
	//   [33]       AskCount    uint8    (0..BinaryDepthMaxLevels)
	//   [34..39]   Reserved    [6]byte
	//   [40..199]  Bids        [10]BinaryDepthLevel (Price float64 + Volume float64, sorted best-first descending)
	//   [200..359] Asks        [10]BinaryDepthLevel (Price float64 + Volume float64, sorted best-first ascending)
	BinaryDepthMaxLevels  = 10
	BinaryDepthHeaderSize = 40
	BinaryDepthLevelSize  = 16
	BinaryDepthRecordSize = BinaryDepthHeaderSize + 2*BinaryDepthMaxLevels*BinaryDepthLevelSize

	CandleFlagForming uint8 = 0x00
	CandleFlagClosed  uint8 = 0x01
)

// Timeframe binary codes
const (
	TFCodeM1  uint8 = 1
	TFCodeM5  uint8 = 2
	TFCodeM15 uint8 = 3
	TFCodeM30 uint8 = 4
	TFCodeH1  uint8 = 5
	TFCodeH4  uint8 = 6
	TFCodeD1  uint8 = 7
	TFCodeW1  uint8 = 8
	TFCodeMN1 uint8 = 9
)

var (
	ErrTruncatedBinaryBatch = errors.New("rtx5tcp: truncated binary market-data batch")
)

// BinaryTick represents a zero-JSON 48-byte fixed-width institutional tick.
type BinaryTick struct {
	Symbol      string
	TimestampMs int64
	Bid         float64
	Ask         float64
	Sequence    uint64
}

// BinaryCandle represents a zero-JSON 64-byte fixed-width institutional OHLCV bar.
type BinaryCandle struct {
	Symbol        string
	OpenTimeSec   int64
	Open          float64
	High          float64
	Low           float64
	Close         float64
	TickVolume    uint32
	Closed        bool
	TimeframeCode uint8
}

// BinaryDepthLevel represents a single price+volume ladder rung in a BinaryDepth record.
type BinaryDepthLevel struct {
	Price  float64
	Volume float64
}

// BinaryDepth represents a zero-JSON 360-byte fixed-width multi-level order book snapshot.
type BinaryDepth struct {
	Symbol      string
	TimestampMs int64
	Sequence    uint64
	Bids        []BinaryDepthLevel
	Asks        []BinaryDepthLevel
}

// TimeframeToCode maps canonical timeframe strings to 1-byte binary codes.
func TimeframeToCode(tf string) uint8 {
	switch strings.ToUpper(strings.TrimSpace(tf)) {
	case "M1", "1M":
		return TFCodeM1
	case "M5", "5M":
		return TFCodeM5
	case "M15", "15M":
		return TFCodeM15
	case "M30", "30M":
		return TFCodeM30
	case "H1", "1H":
		return TFCodeH1
	case "H4", "4H":
		return TFCodeH4
	case "D1", "1D":
		return TFCodeD1
	case "W1", "1W":
		return TFCodeW1
	case "MN", "MN1", "1MN":
		return TFCodeMN1
	default:
		return TFCodeM1
	}
}

// CodeToTimeframe maps 1-byte binary timeframe codes back to canonical strings.
func CodeToTimeframe(code uint8) string {
	switch code {
	case TFCodeM5:
		return "M5"
	case TFCodeM15:
		return "M15"
	case TFCodeM30:
		return "M30"
	case TFCodeH1:
		return "H1"
	case TFCodeH4:
		return "H4"
	case TFCodeD1:
		return "D1"
	case TFCodeW1:
		return "W1"
	case TFCodeMN1:
		return "MN1"
	default:
		return "M1"
	}
}

func writeFixedSymbol(dst []byte, sym string) {
	// Zero-fill 16 bytes first
	for i := 0; i < BinarySymbolMaxBytes; i++ {
		dst[i] = 0
	}
	n := len(sym)
	if n > BinarySymbolMaxBytes {
		n = BinarySymbolMaxBytes
	}
	for i := 0; i < n; i++ {
		c := sym[i]
		if c >= 'a' && c <= 'z' {
			c -= 32
		}
		dst[i] = c
	}
}

func readFixedSymbol(src []byte) string {
	end := 0
	for end < BinarySymbolMaxBytes && end < len(src) && src[end] != 0 {
		end++
	}
	return string(src[:end])
}

// PutBinaryTick writes one 48-byte BinaryTick at dst[0:48].
func PutBinaryTick(dst []byte, t BinaryTick) {
	writeFixedSymbol(dst[0:16], t.Symbol)
	binary.LittleEndian.PutUint64(dst[16:24], uint64(t.TimestampMs))
	binary.LittleEndian.PutUint64(dst[24:32], math.Float64bits(t.Bid))
	binary.LittleEndian.PutUint64(dst[32:40], math.Float64bits(t.Ask))
	binary.LittleEndian.PutUint64(dst[40:48], t.Sequence)
}

// ReadBinaryTick decodes one 48-byte BinaryTick from src[0:48].
func ReadBinaryTick(src []byte) BinaryTick {
	return BinaryTick{
		Symbol:      readFixedSymbol(src[0:16]),
		TimestampMs: int64(binary.LittleEndian.Uint64(src[16:24])),
		Bid:         math.Float64frombits(binary.LittleEndian.Uint64(src[24:32])),
		Ask:         math.Float64frombits(binary.LittleEndian.Uint64(src[32:40])),
		Sequence:    binary.LittleEndian.Uint64(src[40:48]),
	}
}

// EncodeBinaryTickBatch packs up to 65535 BinaryTicks into [Count:u16_le][Tick0:48B]...[TickN:48B].
func EncodeBinaryTickBatch(ticks []BinaryTick) []byte {
	count := len(ticks)
	if count > 65535 {
		count = 65535
	}
	buf := make([]byte, 2+count*BinaryTickRecordSize)
	binary.LittleEndian.PutUint16(buf[0:2], uint16(count))
	off := 2
	for i := 0; i < count; i++ {
		PutBinaryTick(buf[off:off+BinaryTickRecordSize], ticks[i])
		off += BinaryTickRecordSize
	}
	return buf
}

// DecodeBinaryTickBatch unpacks [Count:u16_le][Tick0:48B]...[TickN:48B].
func DecodeBinaryTickBatch(payload []byte) ([]BinaryTick, error) {
	if len(payload) < 2 {
		return nil, ErrTruncatedBinaryBatch
	}
	count := int(binary.LittleEndian.Uint16(payload[0:2]))
	if len(payload) < 2+count*BinaryTickRecordSize {
		return nil, ErrTruncatedBinaryBatch
	}
	out := make([]BinaryTick, count)
	off := 2
	for i := 0; i < count; i++ {
		out[i] = ReadBinaryTick(payload[off : off+BinaryTickRecordSize])
		off += BinaryTickRecordSize
	}
	return out, nil
}

// PutBinaryCandle writes one 64-byte BinaryCandle at dst[0:64].
func PutBinaryCandle(dst []byte, c BinaryCandle) {
	writeFixedSymbol(dst[0:16], c.Symbol)
	binary.LittleEndian.PutUint64(dst[16:24], uint64(c.OpenTimeSec))
	binary.LittleEndian.PutUint64(dst[24:32], math.Float64bits(c.Open))
	binary.LittleEndian.PutUint64(dst[32:40], math.Float64bits(c.High))
	binary.LittleEndian.PutUint64(dst[40:48], math.Float64bits(c.Low))
	binary.LittleEndian.PutUint64(dst[48:56], math.Float64bits(c.Close))
	binary.LittleEndian.PutUint32(dst[56:60], c.TickVolume)
	flags := CandleFlagForming
	if c.Closed {
		flags = CandleFlagClosed
	}
	dst[60] = flags
	tfCode := c.TimeframeCode
	if tfCode == 0 {
		tfCode = TFCodeM1
	}
	dst[61] = tfCode
	dst[62] = 0
	dst[63] = 0
}

// ReadBinaryCandle decodes one 64-byte BinaryCandle from src[0:64].
func ReadBinaryCandle(src []byte) BinaryCandle {
	tfCode := src[61]
	if tfCode == 0 {
		tfCode = TFCodeM1
	}
	return BinaryCandle{
		Symbol:        readFixedSymbol(src[0:16]),
		OpenTimeSec:   int64(binary.LittleEndian.Uint64(src[16:24])),
		Open:          math.Float64frombits(binary.LittleEndian.Uint64(src[24:32])),
		High:          math.Float64frombits(binary.LittleEndian.Uint64(src[32:40])),
		Low:           math.Float64frombits(binary.LittleEndian.Uint64(src[40:48])),
		Close:         math.Float64frombits(binary.LittleEndian.Uint64(src[48:56])),
		TickVolume:    binary.LittleEndian.Uint32(src[56:60]),
		Closed:        (src[60] & CandleFlagClosed) != 0,
		TimeframeCode: tfCode,
	}
}

// EncodeBinaryCandleBatch packs up to 65535 BinaryCandles into [Count:u16_le][Candle0:64B]...[CandleN:64B].
func EncodeBinaryCandleBatch(candles []BinaryCandle) []byte {
	count := len(candles)
	if count > 65535 {
		count = 65535
	}
	buf := make([]byte, 2+count*BinaryCandleRecordSize)
	binary.LittleEndian.PutUint16(buf[0:2], uint16(count))
	off := 2
	for i := 0; i < count; i++ {
		PutBinaryCandle(buf[off:off+BinaryCandleRecordSize], candles[i])
		off += BinaryCandleRecordSize
	}
	return buf
}

// DecodeBinaryCandleBatch unpacks [Count:u16_le][Candle0:64B]...[CandleN:64B].
func DecodeBinaryCandleBatch(payload []byte) ([]BinaryCandle, error) {
	if len(payload) < 2 {
		return nil, ErrTruncatedBinaryBatch
	}
	count := int(binary.LittleEndian.Uint16(payload[0:2]))
	if len(payload) < 2+count*BinaryCandleRecordSize {
		return nil, ErrTruncatedBinaryBatch
	}
	out := make([]BinaryCandle, count)
	off := 2
	for i := 0; i < count; i++ {
		out[i] = ReadBinaryCandle(payload[off : off+BinaryCandleRecordSize])
		off += BinaryCandleRecordSize
	}
	return out, nil
}

// EncodeRawBinaryCandles packs an arbitrarily large slice of BinaryCandles (e.g., 5,000 M1 bars)
// into [Count:u32_le][Candle0:64B]...[CandleN:64B] for zero-JSON HTTP octet-stream history transfers.
func EncodeRawBinaryCandles(candles []BinaryCandle) []byte {
	count := len(candles)
	buf := make([]byte, 4+count*BinaryCandleRecordSize)
	binary.LittleEndian.PutUint32(buf[0:4], uint32(count))
	off := 4
	for i := 0; i < count; i++ {
		PutBinaryCandle(buf[off:off+BinaryCandleRecordSize], candles[i])
		off += BinaryCandleRecordSize
	}
	return buf
}


// PutBinaryDepth writes one 360-byte BinaryDepth record at dst[0:360].
func PutBinaryDepth(dst []byte, d BinaryDepth) {
	for i := 0; i < BinaryDepthRecordSize; i++ {
		dst[i] = 0
	}
	writeFixedSymbol(dst[0:16], d.Symbol)
	binary.LittleEndian.PutUint64(dst[16:24], uint64(d.TimestampMs))
	binary.LittleEndian.PutUint64(dst[24:32], d.Sequence)

	bidCount := len(d.Bids)
	if bidCount > BinaryDepthMaxLevels {
		bidCount = BinaryDepthMaxLevels
	}
	askCount := len(d.Asks)
	if askCount > BinaryDepthMaxLevels {
		askCount = BinaryDepthMaxLevels
	}
	dst[32] = uint8(bidCount)
	dst[33] = uint8(askCount)

	bidBase := BinaryDepthHeaderSize
	for i := 0; i < bidCount; i++ {
		off := bidBase + i*BinaryDepthLevelSize
		binary.LittleEndian.PutUint64(dst[off:off+8], math.Float64bits(d.Bids[i].Price))
		binary.LittleEndian.PutUint64(dst[off+8:off+16], math.Float64bits(d.Bids[i].Volume))
	}

	askBase := BinaryDepthHeaderSize + BinaryDepthMaxLevels*BinaryDepthLevelSize
	for i := 0; i < askCount; i++ {
		off := askBase + i*BinaryDepthLevelSize
		binary.LittleEndian.PutUint64(dst[off:off+8], math.Float64bits(d.Asks[i].Price))
		binary.LittleEndian.PutUint64(dst[off+8:off+16], math.Float64bits(d.Asks[i].Volume))
	}
}

// ReadBinaryDepth decodes one 360-byte BinaryDepth record from src[0:360].
func ReadBinaryDepth(src []byte) BinaryDepth {
	bidCount := int(src[32])
	if bidCount > BinaryDepthMaxLevels {
		bidCount = BinaryDepthMaxLevels
	}
	askCount := int(src[33])
	if askCount > BinaryDepthMaxLevels {
		askCount = BinaryDepthMaxLevels
	}

	bids := make([]BinaryDepthLevel, 0, bidCount)
	bidBase := BinaryDepthHeaderSize
	for i := 0; i < bidCount; i++ {
		off := bidBase + i*BinaryDepthLevelSize
		p := math.Float64frombits(binary.LittleEndian.Uint64(src[off : off+8]))
		v := math.Float64frombits(binary.LittleEndian.Uint64(src[off+8 : off+16]))
		if p > 0 && v > 0 && !math.IsNaN(p) && !math.IsInf(p, 0) && !math.IsNaN(v) && !math.IsInf(v, 0) {
			bids = append(bids, BinaryDepthLevel{Price: p, Volume: v})
		}
	}

	asks := make([]BinaryDepthLevel, 0, askCount)
	askBase := BinaryDepthHeaderSize + BinaryDepthMaxLevels*BinaryDepthLevelSize
	for i := 0; i < askCount; i++ {
		off := askBase + i*BinaryDepthLevelSize
		p := math.Float64frombits(binary.LittleEndian.Uint64(src[off : off+8]))
		v := math.Float64frombits(binary.LittleEndian.Uint64(src[off+8 : off+16]))
		if p > 0 && v > 0 && !math.IsNaN(p) && !math.IsInf(p, 0) && !math.IsNaN(v) && !math.IsInf(v, 0) {
			asks = append(asks, BinaryDepthLevel{Price: p, Volume: v})
		}
	}

	return BinaryDepth{
		Symbol:      readFixedSymbol(src[0:16]),
		TimestampMs: int64(binary.LittleEndian.Uint64(src[16:24])),
		Sequence:    binary.LittleEndian.Uint64(src[24:32]),
		Bids:        bids,
		Asks:        asks,
	}
}

// EncodeBinaryDepthBatch packs up to 65535 BinaryDepth records into [Count:u16_le][Depth0:360B]...[DepthN:360B].
func EncodeBinaryDepthBatch(depths []BinaryDepth) []byte {
	count := len(depths)
	if count > 65535 {
		count = 65535
	}
	buf := make([]byte, 2+count*BinaryDepthRecordSize)
	binary.LittleEndian.PutUint16(buf[0:2], uint16(count))
	off := 2
	for i := 0; i < count; i++ {
		PutBinaryDepth(buf[off:off+BinaryDepthRecordSize], depths[i])
		off += BinaryDepthRecordSize
	}
	return buf
}

// DecodeBinaryDepthBatch unpacks [Count:u16_le][Depth0:360B]...[DepthN:360B].
func DecodeBinaryDepthBatch(payload []byte) ([]BinaryDepth, error) {
	if len(payload) < 2 {
		return nil, ErrTruncatedBinaryBatch
	}
	count := int(binary.LittleEndian.Uint16(payload[0:2]))
	if len(payload) < 2+count*BinaryDepthRecordSize {
		return nil, ErrTruncatedBinaryBatch
	}
	out := make([]BinaryDepth, count)
	off := 2
	for i := 0; i < count; i++ {
		out[i] = ReadBinaryDepth(payload[off : off+BinaryDepthRecordSize])
		off += BinaryDepthRecordSize
	}
	return out, nil
}
