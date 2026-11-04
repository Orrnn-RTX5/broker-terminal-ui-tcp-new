package rtx5tcp

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	// BinaryTradeEventVersion identifies the wire layout of BinaryTradeEvent (0x3A).
	BinaryTradeEventVersion uint8 = 1

	// BinaryTradeEvent EventKind codes (1..6).
	BinaryTradeEventPositions uint8 = 1
	BinaryTradeEventOrders    uint8 = 2
	BinaryTradeEventAccount   uint8 = 3
	BinaryTradeEventMetrics   uint8 = 4
	BinaryTradeEventDeals     uint8 = 5
	BinaryTradeEventState     uint8 = 6

	// BinaryAccountSubHeaderSize is the fixed 10-byte Little-Endian prefix before AuthToken:
	//   [0..7]   AccountLogin int64  (LE; <= 0 means unsubscribe)
	//   [8..9]   TokenLen     uint16 (LE)
	//   [10..]   AuthToken    []byte (UTF-8 bytes)
	BinaryAccountSubHeaderSize = 10

	// BinaryTradeEventMinHeaderSize is the minimum 22-byte Little-Endian framing size (empty Channel & Data):
	//   [0]                   Version      uint8  (= 1)
	//   [1]                   EventKind    uint8  (1..6)
	//   [2..9]                AccountLogin int64  (LE)
	//   [10..17]              TimestampMs  int64  (LE)
	//   [18..19]              ChannelLen   uint16 (LE)
	//   [20..20+ChannelLen]   Channel      []byte (UTF-8)
	//   [20+ChannelLen..+2]   DataLen      uint16 (LE)
	//   [22+ChannelLen..+Len] Data         []byte (UTF-8 payload)
	BinaryTradeEventMinHeaderSize = 22

	// BinaryTradeEventMaxWireBytes caps total encoded BinaryTradeEvent size so it fits cleanly
	// inside uint16 local stream framing.
	BinaryTradeEventMaxWireBytes = 65000
)

var (
	ErrTruncatedBinaryAccountSub = errors.New("rtx5tcp: truncated binary account subscription frame")
	ErrTruncatedBinaryTradeEvent = errors.New("rtx5tcp: truncated binary trade event frame")
	ErrUnsupportedBinaryTradeVer = errors.New("rtx5tcp: unsupported binary trade event codec version")
	ErrBinaryTradeEventTooLarge  = errors.New("rtx5tcp: binary trade event exceeds 65000-byte maximum")
)

// BinaryAccountSub represents the FrameBinaryAccountSub (0x3B) payload for subscribing or
// unsubscribing (AccountLogin <= 0) to pushed binary trade/account events.
type BinaryAccountSub struct {
	AccountLogin int64
	AuthToken    string
}

// BinaryTradeEvent represents the FrameBinaryTradeEvent (0x3A) payload pushed from gateway/server
// to subscribed clients over the encrypted binary TCP tunnel.
type BinaryTradeEvent struct {
	EventKind    uint8
	AccountLogin int64
	TimestampMs  int64
	Channel      string
	Data         []byte
}

// EncodeBinaryAccountSub encodes BinaryAccountSub into Little-Endian wire format.
func EncodeBinaryAccountSub(sub BinaryAccountSub) []byte {
	tokenLen := len(sub.AuthToken)
	if tokenLen > 65535 {
		tokenLen = 65535
	}
	buf := make([]byte, BinaryAccountSubHeaderSize+tokenLen)
	binary.LittleEndian.PutUint64(buf[0:8], uint64(sub.AccountLogin))
	binary.LittleEndian.PutUint16(buf[8:10], uint16(tokenLen))
	if tokenLen > 0 {
		copy(buf[10:10+tokenLen], sub.AuthToken[:tokenLen])
	}
	return buf
}

// DecodeBinaryAccountSub decodes a Little-Endian BinaryAccountSub payload.
func DecodeBinaryAccountSub(b []byte) (BinaryAccountSub, error) {
	if len(b) < BinaryAccountSubHeaderSize {
		return BinaryAccountSub{}, ErrTruncatedBinaryAccountSub
	}
	login := int64(binary.LittleEndian.Uint64(b[0:8]))
	tokenLen := int(binary.LittleEndian.Uint16(b[8:10]))
	if len(b) < BinaryAccountSubHeaderSize+tokenLen {
		return BinaryAccountSub{}, ErrTruncatedBinaryAccountSub
	}
	var token string
	if tokenLen > 0 {
		token = string(b[10 : 10+tokenLen])
	}
	return BinaryAccountSub{
		AccountLogin: login,
		AuthToken:    token,
	}, nil
}

// EncodeBinaryTradeEvent encodes BinaryTradeEvent into Little-Endian wire format.
// Returns an error if 22 + len(Channel) + len(Data) > 65000.
func EncodeBinaryTradeEvent(ev BinaryTradeEvent) ([]byte, error) {
	chLen := len(ev.Channel)
	dataLen := len(ev.Data)
	if chLen > BinaryTradeEventMaxWireBytes ||
		dataLen > BinaryTradeEventMaxWireBytes ||
		BinaryTradeEventMinHeaderSize+chLen+dataLen > BinaryTradeEventMaxWireBytes {
		return nil, fmt.Errorf("%w: size=%d", ErrBinaryTradeEventTooLarge, BinaryTradeEventMinHeaderSize+chLen+dataLen)
	}

	totalLen := BinaryTradeEventMinHeaderSize + chLen + dataLen
	buf := make([]byte, totalLen)
	buf[0] = BinaryTradeEventVersion
	buf[1] = ev.EventKind
	binary.LittleEndian.PutUint64(buf[2:10], uint64(ev.AccountLogin))
	binary.LittleEndian.PutUint64(buf[10:18], uint64(ev.TimestampMs))
	binary.LittleEndian.PutUint16(buf[18:20], uint16(chLen))
	if chLen > 0 {
		copy(buf[20:20+chLen], ev.Channel)
	}
	dataLenOff := 20 + chLen
	binary.LittleEndian.PutUint16(buf[dataLenOff:dataLenOff+2], uint16(dataLen))
	if dataLen > 0 {
		dataOff := 22 + chLen
		copy(buf[dataOff:dataOff+dataLen], ev.Data)
	}
	return buf, nil
}

// DecodeBinaryTradeEvent decodes a Little-Endian BinaryTradeEvent payload.
func DecodeBinaryTradeEvent(b []byte) (BinaryTradeEvent, error) {
	if len(b) < BinaryTradeEventMinHeaderSize {
		return BinaryTradeEvent{}, ErrTruncatedBinaryTradeEvent
	}
	if b[0] != BinaryTradeEventVersion {
		return BinaryTradeEvent{}, ErrUnsupportedBinaryTradeVer
	}
	eventKind := b[1]
	accountLogin := int64(binary.LittleEndian.Uint64(b[2:10]))
	timestampMs := int64(binary.LittleEndian.Uint64(b[10:18]))
	chLen := int(binary.LittleEndian.Uint16(b[18:20]))
	if len(b) < BinaryTradeEventMinHeaderSize+chLen {
		return BinaryTradeEvent{}, ErrTruncatedBinaryTradeEvent
	}
	dataLenOff := 20 + chLen
	dataLen := int(binary.LittleEndian.Uint16(b[dataLenOff : dataLenOff+2]))
	if len(b) < BinaryTradeEventMinHeaderSize+chLen+dataLen {
		return BinaryTradeEvent{}, ErrTruncatedBinaryTradeEvent
	}

	var channel string
	if chLen > 0 {
		channel = string(b[20 : 20+chLen])
	}
	var data []byte
	if dataLen > 0 {
		dataOff := 22 + chLen
		data = make([]byte, dataLen)
		copy(data, b[dataOff:dataOff+dataLen])
	}

	return BinaryTradeEvent{
		EventKind:    eventKind,
		AccountLogin: accountLogin,
		TimestampMs:  timestampMs,
		Channel:      channel,
		Data:         data,
	}, nil
}
