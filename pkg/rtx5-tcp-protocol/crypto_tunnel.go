package rtx5tcp

import (
	"bufio"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/hkdf"
)

// 4-Byte Binary Protocol Magic Number: 'R', 'T', 'X', 0x05
var ProtocolMagic = [4]byte{'R', 'T', 'X', 0x05}

const (
	ProtocolVersion uint8 = 0x02

	// Connection Peer Roles (sent in byte 5 of the 8-byte connection preamble)
	RoleBrokerUplink         uint8 = 0x01
	RoleSuperAdminClient     uint8 = 0x02
	RoleBrokerAdminClient    uint8 = 0x03
	RoleBrokerManagerClient  uint8 = 0x04
	RoleTraderTerminalClient uint8 = 0x05
	RoleDiscoveryProbe       uint8 = 0x06
	RoleTraderOrderFastLane  uint8 = 0x07 // Dedicated 0x38/0x39 order tunnel (zero 0x21/0x22/0x3A/RPC background traffic)

	MaxEncryptedFrameBytes = 32 * 1024 * 1024 // 32 MB max frame
)

// EncryptedFrame Types inside AES-256-GCM Tunnel
const (
	FramePing uint8 = 0x01
	FramePong uint8 = 0x02

	FrameAuthChallenge      uint8 = 0x10
	FrameAuthProof          uint8 = 0x11
	FrameAuthLease          uint8 = 0x12
	FrameHeartbeatChallenge uint8 = 0x13
	FrameHeartbeatProof     uint8 = 0x14
	FrameKillCommand        uint8 = 0x15

	FrameLPTickBatch       uint8 = 0x20
	FrameBinaryTickBatch   uint8 = 0x21
	FrameBinaryCandleBatch uint8 = 0x22
	FrameLPDepthBatch      uint8 = 0x23
	FrameBinaryDepthBatch  uint8 = 0x24

	FrameRPCReq        uint8 = 0x30
	FrameRPCRespHeader uint8 = 0x31
	FrameRPCRespChunk  uint8 = 0x32
	FrameRPCAbort      uint8 = 0x33

	FrameBinaryOrderReq   uint8 = 0x38
	FrameBinaryOrderResp  uint8 = 0x39
	FrameBinaryTradeEvent uint8 = 0x3A // Server -> Client native binary private trade/position/order/account push event
	FrameBinaryAccountSub uint8 = 0x3B // Client -> Server native binary account stream subscription bind

	FrameWSOpen      uint8 = 0x40
	FrameWSOpenAck   uint8 = 0x41
	FrameWSMsgText   uint8 = 0x42
	FrameWSMsgBinary uint8 = 0x43
	FrameWSPing      uint8 = 0x44
	FrameWSPong      uint8 = 0x45
	FrameWSClose     uint8 = 0x46

	FrameBrokerDirectoryReq  uint8 = 0x50
	FrameBrokerDirectoryResp uint8 = 0x51
)

// Frame Flags
const (
	FlagNone uint8 = 0x00
	FlagFIN  uint8 = 0x01
	FlagERR  uint8 = 0x02
)

var (
	ErrBadMagic         = errors.New("rtx5tcp: invalid 4-byte protocol magic number (expected RTX\\x05)")
	ErrUnsupportedVer   = errors.New("rtx5tcp: unsupported binary protocol version")
	ErrFrameTooLarge    = errors.New("rtx5tcp: frame exceeds 32MB safety cap")
	ErrNonceExhausted   = errors.New("rtx5tcp: AES-GCM monotonic nonce counter exhausted")
	ErrReplayOrTampered = errors.New("rtx5tcp: AEAD frame authentication/monotonic-nonce verification failed")
)

// TunnelConn wraps a raw TCP socket with:
//   - Verified 8-byte Magic Preamble ('R','T','X',0x05 + Version + Role)
//   - X25519 Ephemeral ECDH Key Exchange
//   - HKDF-SHA256 Directional Traffic Keys (distinct TX/RX keys + distinct 4-byte IV prefixes)
//   - AES-256-GCM AEAD Encryption with strictly monotonic 64-bit packet sequence numbers
//     embedded into 96-bit GCM nonces (zero possibility of packet replay, reordering, or tampering).
type TunnelConn struct {
	raw        net.Conn
	br         *bufio.Reader
	peerRole   uint8
	isServer   bool
	txAEAD     cipher.AEAD
	rxAEAD     cipher.AEAD
	txIVPrefix [4]byte
	rxIVPrefix [4]byte
	txSeq      uint64
	rxSeq      uint64
	writeMu    sync.Mutex
	readMu     sync.Mutex
	transcript [32]byte // SHA-256 binding of handshake preamble + both X25519 public keys (prevents MITM)
	closed     atomic.Bool
}

func configureTCPSocket(c net.Conn) {
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetKeepAlive(true)
		_ = tc.SetKeepAlivePeriod(20 * time.Second)
		_ = tc.SetReadBuffer(1024 * 1024)
		_ = tc.SetWriteBuffer(1024 * 1024)
	}
}

// DialTunnel establishes an outbound Encrypted Binary TCP connection with Magic 'R','T','X',0x05.
func DialTunnel(addr string, role uint8, timeout time.Duration) (*TunnelConn, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	raw, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	configureTCPSocket(raw)
	_ = raw.SetDeadline(time.Now().Add(timeout))

	tc, err := handshakeClient(raw, role)
	if err != nil {
		_ = raw.Close()
		return nil, err
	}
	_ = raw.SetDeadline(time.Time{})
	return tc, nil
}

// AcceptTunnel verifies the incoming 4-byte Magic Number ('R','T','X',0x05) on byte 1
// and completes the server side of the X25519 + HKDF-SHA256 + AES-256-GCM handshake.
func AcceptTunnel(raw net.Conn, timeout time.Duration) (*TunnelConn, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	configureTCPSocket(raw)
	_ = raw.SetDeadline(time.Now().Add(timeout))

	tc, err := handshakeServer(raw)
	if err != nil {
		_ = raw.Close()
		return nil, err
	}
	_ = raw.SetDeadline(time.Time{})
	return tc, nil
}

func handshakeClient(raw net.Conn, role uint8) (*TunnelConn, error) {
	curve := ecdh.X25519()
	priv, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	clientPub := priv.PublicKey().Bytes()

	// Send 8-byte Magic Preamble + 32-byte Client Ephemeral X25519 Public Key (40 bytes)
	var hello [40]byte
	copy(hello[0:4], ProtocolMagic[:])
	hello[4] = ProtocolVersion
	hello[5] = role
	hello[6] = 0
	hello[7] = 0
	copy(hello[8:40], clientPub)

	if _, err := raw.Write(hello[:]); err != nil {
		return nil, fmt.Errorf("write client hello: %w", err)
	}

	// Read 8-byte Server Magic Ack + 32-byte Server Ephemeral X25519 Public Key (40 bytes)
	var srvHello [40]byte
	if _, err := io.ReadFull(raw, srvHello[:]); err != nil {
		return nil, fmt.Errorf("read server hello: %w", err)
	}
	if srvHello[0] != ProtocolMagic[0] || srvHello[1] != ProtocolMagic[1] ||
		srvHello[2] != ProtocolMagic[2] || srvHello[3] != ProtocolMagic[3] {
		return nil, ErrBadMagic
	}
	if srvHello[4] != ProtocolVersion {
		return nil, ErrUnsupportedVer
	}

	srvPub, err := curve.NewPublicKey(srvHello[8:40])
	if err != nil {
		return nil, fmt.Errorf("invalid server X25519 public key: %w", err)
	}
	shared, err := priv.ECDH(srvPub)
	if err != nil {
		return nil, fmt.Errorf("X25519 ECDH failed: %w", err)
	}

	return deriveTunnelKeys(raw, role, false, shared, hello[:], srvHello[:])
}

func handshakeServer(raw net.Conn) (*TunnelConn, error) {
	var clientHello [40]byte
	// Read first 4 bytes immediately to reject non-RTX5 traffic/scanners on byte 1!
	if _, err := io.ReadFull(raw, clientHello[0:4]); err != nil {
		return nil, err
	}
	if clientHello[0] != ProtocolMagic[0] || clientHello[1] != ProtocolMagic[1] ||
		clientHello[2] != ProtocolMagic[2] || clientHello[3] != ProtocolMagic[3] {
		return nil, ErrBadMagic
	}
	if _, err := io.ReadFull(raw, clientHello[4:40]); err != nil {
		return nil, err
	}
	if clientHello[4] != ProtocolVersion {
		return nil, ErrUnsupportedVer
	}
	peerRole := clientHello[5]

	curve := ecdh.X25519()
	clientPub, err := curve.NewPublicKey(clientHello[8:40])
	if err != nil {
		return nil, fmt.Errorf("invalid client X25519 public key: %w", err)
	}

	priv, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	srvPub := priv.PublicKey().Bytes()

	var srvHello [40]byte
	copy(srvHello[0:4], ProtocolMagic[:])
	srvHello[4] = ProtocolVersion
	srvHello[5] = 0xFF
	srvHello[6] = 0
	srvHello[7] = 0
	copy(srvHello[8:40], srvPub)

	if _, err := raw.Write(srvHello[:]); err != nil {
		return nil, fmt.Errorf("write server hello: %w", err)
	}

	shared, err := priv.ECDH(clientPub)
	if err != nil {
		return nil, fmt.Errorf("X25519 ECDH failed: %w", err)
	}

	return deriveTunnelKeys(raw, peerRole, true, shared, clientHello[:], srvHello[:])
}

func deriveTunnelKeys(raw net.Conn, peerRole uint8, isServer bool, shared, clientHello, srvHello []byte) (*TunnelConn, error) {
	th := sha256.New()
	th.Write([]byte("RTX5-BINARY-TCP-V2-TRANSCRIPT"))
	th.Write(clientHello)
	th.Write(srvHello)
	var transcript [32]byte
	copy(transcript[:], th.Sum(nil))

	// Derive 32B client->server key + 32B server->client key + 4B c2s IV salt + 4B s2c IV salt = 72 bytes
	kdf := hkdf.New(sha256.New, shared, transcript[:], []byte("RTX5-AES256GCM-TRAFFIC-KEYS-V2"))
	var material [72]byte
	if _, err := io.ReadFull(kdf, material[:]); err != nil {
		return nil, err
	}

	c2sBlock, err := aes.NewCipher(material[0:32])
	if err != nil {
		return nil, err
	}
	c2sAEAD, err := cipher.NewGCM(c2sBlock)
	if err != nil {
		return nil, err
	}

	s2cBlock, err := aes.NewCipher(material[32:64])
	if err != nil {
		return nil, err
	}
	s2cAEAD, err := cipher.NewGCM(s2cBlock)
	if err != nil {
		return nil, err
	}

	tc := &TunnelConn{
		raw:        raw,
		br:         bufio.NewReaderSize(raw, 64*1024),
		peerRole:   peerRole,
		isServer:   isServer,
		transcript: transcript,
	}
	if isServer {
		tc.rxAEAD = c2sAEAD
		tc.txAEAD = s2cAEAD
		copy(tc.rxIVPrefix[:], material[64:68])
		copy(tc.txIVPrefix[:], material[68:72])
	} else {
		tc.txAEAD = c2sAEAD
		tc.rxAEAD = s2cAEAD
		copy(tc.txIVPrefix[:], material[64:68])
		copy(tc.rxIVPrefix[:], material[68:72])
	}
	return tc, nil
}

func (t *TunnelConn) PeerRole() uint8          { return t.peerRole }
func (t *TunnelConn) TranscriptHash() [32]byte { return t.transcript }
func (t *TunnelConn) RemoteAddr() net.Addr     { return t.raw.RemoteAddr() }
func (t *TunnelConn) LocalAddr() net.Addr      { return t.raw.LocalAddr() }

func (t *TunnelConn) Close() error {
	t.closed.Store(true)
	return t.raw.Close()
}

const (
	maxPooledMuxPayload = 64 * 1024
	muxScratchBufSize   = 8 + 6 + maxPooledMuxPayload + 64
)

type muxWriteScratch struct {
	nonce [12]byte
	aad   [16]byte
	buf   [muxScratchBufSize]byte
}

var muxWriteScratchPool = sync.Pool{
	New: func() any {
		return new(muxWriteScratch)
	},
}

// MuxFrameBatchItem represents a single multiplexed frame to be encrypted and coalesced
// into one contiguous TCP write by WriteMuxFramesBatch.
type MuxFrameBatchItem struct {
	FrameType uint8
	StreamID  uint32
	Flags     uint8
	Payload   []byte
}

func (t *TunnelConn) sealMuxFrameInto(
	dst []byte,
	s *muxWriteScratch,
	seq uint64,
	overhead int,
	frameType uint8,
	streamID uint32,
	flags uint8,
	payload []byte,
) {
	plainLen := 6 + len(payload)
	cipherLen := uint32(plainLen + overhead)
	frameWireLen := 8 + int(cipherLen)

	frameBuf := dst[:frameWireLen:frameWireLen]
	copy(frameBuf[0:4], ProtocolMagic[:])
	binary.BigEndian.PutUint32(frameBuf[4:8], cipherLen)

	plain := frameBuf[8 : 8+plainLen]
	plain[0] = frameType
	binary.BigEndian.PutUint32(plain[1:5], streamID)
	plain[5] = flags
	copy(plain[6:], payload)

	copy(s.nonce[0:4], t.txIVPrefix[:])
	binary.BigEndian.PutUint64(s.nonce[4:12], seq)

	// Wire packet: [4-byte Magic 'R','T','X',0x05][4-byte CipherLen][Ciphertext+Tag]
	// Authenticate Magic + CipherLen + Seq as GCM Additional Authenticated Data (AAD)!
	copy(s.aad[0:4], ProtocolMagic[:])
	binary.BigEndian.PutUint32(s.aad[4:8], cipherLen)
	binary.BigEndian.PutUint64(s.aad[8:16], seq)

	sealed := t.txAEAD.Seal(plain[:0], s.nonce[:], plain, s.aad[:])
	if len(sealed) != int(cipherLen) || &sealed[0] != &frameBuf[8] {
		copy(frameBuf[8:frameWireLen], sealed)
	}
}

// WriteMuxFrame encrypts and writes [FrameType(1B) || StreamID(4B) || Flags(1B) || Payload]
// inside an AES-256-GCM frame protected by a strictly monotonic 96-bit nonce and AAD header binding.
func (t *TunnelConn) WriteMuxFrame(frameType uint8, streamID uint32, flags uint8, payload []byte) error {
	overhead := t.txAEAD.Overhead()
	plainLen := 6 + len(payload)
	if plainLen+overhead > MaxEncryptedFrameBytes {
		return ErrFrameTooLarge
	}
	wireLen := 8 + plainLen + overhead

	t.writeMu.Lock()
	defer t.writeMu.Unlock()

	if t.txSeq == ^uint64(0) {
		return ErrNonceExhausted
	}
	seq := t.txSeq
	t.txSeq++

	s := muxWriteScratchPool.Get().(*muxWriteScratch)
	if len(payload) <= maxPooledMuxPayload && wireLen <= len(s.buf) {
		t.sealMuxFrameInto(s.buf[:wireLen], s, seq, overhead, frameType, streamID, flags, payload)
		err := writeFull(t.raw, s.buf[:wireLen])
		muxWriteScratchPool.Put(s)
		return err
	}

	wire := make([]byte, wireLen)
	t.sealMuxFrameInto(wire, s, seq, overhead, frameType, streamID, flags, payload)
	muxWriteScratchPool.Put(s)
	return writeFull(t.raw, wire)
}

// WriteMuxFramesBatch acquires t.writeMu once, encrypts each item sequentially with its own
// monotonic 96-bit GCM nonce and AAD header (100% wire-compatible with ReadMuxFrame),
// coalesces all frames into one contiguous buffer, and writes them in a single writeFull call.
func (t *TunnelConn) WriteMuxFramesBatch(items []MuxFrameBatchItem) error {
	if len(items) == 0 {
		return nil
	}

	const maxInt = int(^uint(0) >> 1)
	overhead := t.txAEAD.Overhead()
	totalWireLen := 0
	for i := range items {
		plainLen := 6 + len(items[i].Payload)
		if plainLen+overhead > MaxEncryptedFrameBytes {
			return ErrFrameTooLarge
		}
		frameWireLen := 8 + plainLen + overhead
		if frameWireLen > maxInt-totalWireLen {
			return ErrFrameTooLarge
		}
		totalWireLen += frameWireLen
	}

	t.writeMu.Lock()
	defer t.writeMu.Unlock()

	if ^uint64(0)-t.txSeq < uint64(len(items)) {
		return ErrNonceExhausted
	}

	s := muxWriteScratchPool.Get().(*muxWriteScratch)
	var batchBuf []byte
	pooledOut := totalWireLen <= len(s.buf)
	if pooledOut {
		batchBuf = s.buf[:totalWireLen]
	} else {
		batchBuf = make([]byte, totalWireLen)
	}

	offset := 0
	for i := range items {
		it := &items[i]
		frameWireLen := 8 + 6 + len(it.Payload) + overhead
		seq := t.txSeq
		t.txSeq++
		t.sealMuxFrameInto(
			batchBuf[offset:offset+frameWireLen],
			s,
			seq,
			overhead,
			it.FrameType,
			it.StreamID,
			it.Flags,
			it.Payload,
		)
		offset += frameWireLen
	}

	if pooledOut {
		err := writeFull(t.raw, batchBuf)
		muxWriteScratchPool.Put(s)
		return err
	}

	muxWriteScratchPool.Put(s)
	return writeFull(t.raw, batchBuf)
}

// ReadMuxFrame reads, verifies Magic ('R','T','X',0x05), authenticates monotonic 96-bit GCM nonce + AAD,
// and decrypts [FrameType, StreamID, Flags, Payload].
func (t *TunnelConn) ReadMuxFrame() (frameType uint8, streamID uint32, flags uint8, payload []byte, err error) {
	t.readMu.Lock()
	defer t.readMu.Unlock()

	var r io.Reader = t.raw
	if t.br != nil {
		r = t.br
	}

	var hdr [8]byte
	if _, err = io.ReadFull(r, hdr[:]); err != nil {
		return 0, 0, 0, nil, err
	}
	if hdr[0] != ProtocolMagic[0] || hdr[1] != ProtocolMagic[1] ||
		hdr[2] != ProtocolMagic[2] || hdr[3] != ProtocolMagic[3] {
		return 0, 0, 0, nil, ErrBadMagic
	}
	cipherLen := binary.BigEndian.Uint32(hdr[4:8])
	if cipherLen < uint32(6+t.rxAEAD.Overhead()) || cipherLen > MaxEncryptedFrameBytes {
		return 0, 0, 0, nil, ErrFrameTooLarge
	}

	cipherBuf := make([]byte, cipherLen)
	if _, err = io.ReadFull(r, cipherBuf); err != nil {
		return 0, 0, 0, nil, err
	}

	seq := t.rxSeq
	t.rxSeq++

	var nonce [12]byte
	copy(nonce[0:4], t.rxIVPrefix[:])
	binary.BigEndian.PutUint64(nonce[4:12], seq)

	var aad [16]byte
	copy(aad[0:4], ProtocolMagic[:])
	binary.BigEndian.PutUint32(aad[4:8], cipherLen)
	binary.BigEndian.PutUint64(aad[8:16], seq)

	plain, decErr := t.rxAEAD.Open(cipherBuf[:0], nonce[:], cipherBuf, aad[:])
	if decErr != nil || len(plain) < 6 {
		return 0, 0, 0, nil, ErrReplayOrTampered
	}

	frameType = plain[0]
	streamID = binary.BigEndian.Uint32(plain[1:5])
	flags = plain[5]
	payload = plain[6:]
	return frameType, streamID, flags, payload, nil
}

func writeFull(w io.Writer, buf []byte) error {
	for len(buf) > 0 {
		n, err := w.Write(buf)
		if err != nil {
			return err
		}
		buf = buf[n:]
	}
	return nil
}
