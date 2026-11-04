package rtx5tcp

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// DefaultBinaryOrderGatewayTCPAddr is the default loopback Raw Binary TCP endpoint on rtx5-gateway.exe.
	DefaultBinaryOrderGatewayTCPAddr = "127.0.0.1:8190"

	// RTOFrameHeaderSize is the fixed 12-byte Little-Endian wire header on the local gateway Raw Binary TCP link:
	//   [0..2]  Magic      'R', 'T', 'O' (0x52, 0x54, 0x4F)
	//   [3]     OpCode     uint8
	//   [4..7]  ReqID      uint32 (LE)
	//   [8..11] PayloadLen uint32 (LE, max 65535)
	RTOFrameHeaderSize = 12

	// RTOMaxPayloadBytes caps a single RTO raw binary frame payload at 65535 bytes.
	RTOMaxPayloadBytes = 65535

	// RTO Raw Binary TCP OpCodes
	RTOOpBinaryOrder         uint8 = 0x01
	RTOOpVerifyAccountSub    uint8 = 0x02
	RTOOpPushTradeEvent      uint8 = 0x03
	RTOOpSubscribePushStream uint8 = 0x04

	rawBinaryGatewayPoolConns    = 32
	rawBinaryGatewayPrewarmConns = 32
)

var (
	defaultBinaryOrderGatewayAddr atomic.Value

	errRawGatewayConnClosed = errors.New("rtx5tcp: raw binary gateway connection closed")

	binaryOrderTimerPool = sync.Pool{
		New: func() any {
			t := time.NewTimer(time.Hour)
			if !t.Stop() {
				select {
				case <-t.C:
				default:
				}
			}
			return t
		},
	}

	binaryOrderWaitChanPool = sync.Pool{
		New: func() any {
			return make(chan []byte, 1)
		},
	}
)

func acquireBinaryOrderTimer(d time.Duration) *time.Timer {
	t := binaryOrderTimerPool.Get().(*time.Timer)
	t.Reset(d)
	return t
}

func releaseBinaryOrderTimer(t *time.Timer) {
	if t == nil {
		return
	}
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
	binaryOrderTimerPool.Put(t)
}

func acquireBinaryOrderWaitChan() chan []byte {
	ch := binaryOrderWaitChanPool.Get().(chan []byte)
	select {
	case <-ch:
	default:
	}
	return ch
}

func releaseBinaryOrderWaitChan(ch chan []byte) {
	if ch == nil {
		return
	}
	select {
	case <-ch:
	default:
	}
	binaryOrderWaitChanPool.Put(ch)
}

func init() {
	addr := strings.TrimSpace(os.Getenv("GATEWAY_BINARY_ORDER_TCP_ADDR"))
	if addr == "" {
		addr = DefaultBinaryOrderGatewayTCPAddr
	}
	defaultBinaryOrderGatewayAddr.Store(addr)
}

// SetDefaultBinaryOrderGatewayAddr updates the target address for the raw binary order TCP connection pool
// and asynchronously pre-warms initial pooled connections.
func SetDefaultBinaryOrderGatewayAddr(addr string) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		addr = DefaultBinaryOrderGatewayTCPAddr
	}
	prev := GetDefaultBinaryOrderGatewayAddr()
	defaultBinaryOrderGatewayAddr.Store(addr)
	if prev != addr {
		rawBinaryGatewayPool.closeAll()
	}
	go PrewarmBinaryOrderGatewayPool()
}

// PrewarmBinaryOrderGatewayPool dials/warms up to 8 initial pooled Raw Binary TCP connections
// to the configured binary order gateway address with a short 250ms timeout, ignoring errors if
// the local gateway has not yet bound its listener.
func PrewarmBinaryOrderGatewayPool() {
	addr := GetDefaultBinaryOrderGatewayAddr()
	if addr == "" {
		return
	}
	n := rawBinaryGatewayPrewarmConns
	if n > rawBinaryGatewayPoolConns {
		n = rawBinaryGatewayPoolConns
	}
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		if GetDefaultBinaryOrderGatewayAddr() != addr {
			break
		}
		wg.Add(1)
		go func(slotIdx int) {
			defer wg.Done()
			if GetDefaultBinaryOrderGatewayAddr() != addr {
				return
			}
			c, _, err := rawBinaryGatewayPool.slots[slotIdx].getOrDial(addr, 250*time.Millisecond)
			if err == nil && c != nil && GetDefaultBinaryOrderGatewayAddr() != addr {
				rawBinaryGatewayPool.slots[slotIdx].closeSlot()
			}
		}(i)
	}
	wg.Wait()
}

// GetDefaultBinaryOrderGatewayAddr returns the configured raw binary order gateway TCP address.
func GetDefaultBinaryOrderGatewayAddr() string {
	if v, ok := defaultBinaryOrderGatewayAddr.Load().(string); ok && v != "" {
		return v
	}
	return DefaultBinaryOrderGatewayTCPAddr
}

type rawBinaryPooledConn struct {
	addr              string
	conn              net.Conn
	writeMu           sync.Mutex
	writeBuf          []byte
	lastWriteDeadline time.Time
	nextReqID         atomic.Uint32

	waitersMu sync.Mutex
	waiters   map[uint32]chan []byte

	closed    atomic.Bool
	closeOnce sync.Once
	doneCh    chan struct{}
}

func newRawBinaryPooledConn(conn net.Conn, addr string) *rawBinaryPooledConn {
	c := &rawBinaryPooledConn{
		addr:     addr,
		conn:     conn,
		writeBuf: make([]byte, RTOFrameHeaderSize+512),
		waiters:  make(map[uint32]chan []byte, 64),
		doneCh:   make(chan struct{}),
	}
	go c.readerLoop()
	return c
}

func (c *rawBinaryPooledConn) allocReqID() uint32 {
	for {
		id := c.nextReqID.Add(1)
		if id != 0 {
			return id
		}
	}
}

func (c *rawBinaryPooledConn) close() {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		close(c.doneCh)
		_ = c.conn.Close()

		c.waitersMu.Lock()
		for id, ch := range c.waiters {
			close(ch)
			delete(c.waiters, id)
		}
		c.waitersMu.Unlock()
	})
}

func (c *rawBinaryPooledConn) readerLoop() {
	defer c.close()
	br := bufio.NewReaderSize(c.conn, 64*1024)
	var hdr [RTOFrameHeaderSize]byte

	for {
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			return
		}
		if hdr[0] != 'R' || hdr[1] != 'T' || hdr[2] != 'O' {
			return
		}
		reqID := binary.LittleEndian.Uint32(hdr[4:8])
		payloadLen := binary.LittleEndian.Uint32(hdr[8:12])
		if payloadLen > RTOMaxPayloadBytes {
			return
		}

		var payload []byte
		if payloadLen > 0 {
			payload = make([]byte, payloadLen)
			if _, err := io.ReadFull(br, payload); err != nil {
				return
			}
		} else {
			payload = []byte{}
		}

		c.waitersMu.Lock()
		ch, ok := c.waiters[reqID]
		if ok {
			delete(c.waiters, reqID)
		}
		c.waitersMu.Unlock()

		if ok && ch != nil {
			ch <- payload
		}
	}
}

// writeCoalesced serializes writes on this pooled TCP connection and coalesces the 12-byte RTO header + payload
// into a single net.Conn.Write syscall without per-call heap allocations.
func (c *rawBinaryPooledConn) writeCoalesced(opCode uint8, reqID uint32, payload []byte, writeTimeout time.Duration) (int, error) {
	c.writeMu.Lock()
	if c.closed.Load() {
		c.writeMu.Unlock()
		return 0, errRawGatewayConnClosed
	}

	frameLen := RTOFrameHeaderSize + len(payload)
	if cap(c.writeBuf) < frameLen {
		c.writeBuf = make([]byte, frameLen)
	}
	buf := c.writeBuf[:frameLen]
	buf[0] = 'R'
	buf[1] = 'T'
	buf[2] = 'O'
	buf[3] = opCode
	binary.LittleEndian.PutUint32(buf[4:8], reqID)
	binary.LittleEndian.PutUint32(buf[8:12], uint32(len(payload)))
	if len(payload) > 0 {
		copy(buf[RTOFrameHeaderSize:], payload)
	}

	if writeTimeout <= 0 {
		writeTimeout = 5 * time.Second
	}
	now := time.Now()
	remCurDL := c.lastWriteDeadline.Sub(now)
	if writeTimeout < 2*time.Second || remCurDL < 2*time.Second || remCurDL > writeTimeout+time.Second {
		dl := now.Add(writeTimeout)
		_ = c.conn.SetWriteDeadline(dl)
		c.lastWriteDeadline = dl
	}
	n, err := c.conn.Write(buf)
	c.writeMu.Unlock()

	if err != nil {
		c.close()
	}
	return n, err
}

type rawBinaryPoolSlot struct {
	mu     sync.RWMutex
	active *rawBinaryPooledConn
}

func (slot *rawBinaryPoolSlot) getOrDial(addr string, dialTimeout time.Duration) (*rawBinaryPooledConn, bool, error) {
	slot.mu.RLock()
	cur := slot.active
	slot.mu.RUnlock()
	if cur != nil && !cur.closed.Load() && cur.addr == addr {
		return cur, true, nil
	}

	slot.mu.Lock()
	defer slot.mu.Unlock()

	if cur = slot.active; cur != nil && !cur.closed.Load() && cur.addr == addr {
		return cur, true, nil
	}
	if slot.active != nil {
		slot.active.close()
		slot.active = nil
	}

	if dialTimeout <= 0 || dialTimeout > 3*time.Second {
		dialTimeout = 3 * time.Second
	}
	dialer := net.Dialer{
		Timeout:   dialTimeout,
		KeepAlive: 60 * time.Second,
	}
	netConn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return nil, false, err
	}
	if tc, ok := netConn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetReadBuffer(256 * 1024)
		_ = tc.SetWriteBuffer(256 * 1024)
	}

	pooled := newRawBinaryPooledConn(netConn, addr)
	slot.active = pooled
	return pooled, false, nil
}

func (slot *rawBinaryPoolSlot) closeSlot() {
	slot.mu.Lock()
	cur := slot.active
	slot.active = nil
	slot.mu.Unlock()
	if cur != nil {
		cur.close()
	}
}

type rawBinaryGatewayClientPool struct {
	rr    atomic.Uint64
	slots [rawBinaryGatewayPoolConns]rawBinaryPoolSlot
}

var rawBinaryGatewayPool = &rawBinaryGatewayClientPool{}

func (p *rawBinaryGatewayClientPool) closeAll() {
	for i := 0; i < rawBinaryGatewayPoolConns; i++ {
		p.slots[i].closeSlot()
	}
}

func (p *rawBinaryGatewayClientPool) roundTrip(opCode uint8, payload []byte, timeout time.Duration) ([]byte, error) {
	if len(payload) > RTOMaxPayloadBytes {
		return nil, fmt.Errorf("rtx5tcp: RTO payload length %d exceeds max %d", len(payload), RTOMaxPayloadBytes)
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}

	addr := GetDefaultBinaryOrderGatewayAddr()
	idx := int((p.rr.Add(1) - 1) % rawBinaryGatewayPoolConns)
	slot := &p.slots[idx]

	deadline := time.Now().Add(timeout)

	for attempt := 0; attempt < 2; attempt++ {
		rem := time.Until(deadline)
		if rem <= 0 {
			return nil, errors.New("rtx5tcp: raw binary gateway timeout")
		}

		c, wasCached, err := slot.getOrDial(addr, rem)
		if err != nil {
			return nil, err
		}

		reqID := c.allocReqID()
		ch := acquireBinaryOrderWaitChan()

		c.waitersMu.Lock()
		if c.closed.Load() {
			c.waitersMu.Unlock()
			releaseBinaryOrderWaitChan(ch)
			if attempt == 0 {
				continue
			}
			return nil, errRawGatewayConnClosed
		}
		c.waiters[reqID] = ch
		c.waitersMu.Unlock()

		nWritten, werr := c.writeCoalesced(opCode, reqID, payload, rem)
		if werr != nil {
			c.waitersMu.Lock()
			delete(c.waiters, reqID)
			c.waitersMu.Unlock()
			c.close()

			// Retry transparently if the cached socket had dropped before any bytes were transmitted,
			// or if the operation is idempotent account-subscription verification.
			if attempt == 0 && wasCached && (nWritten == 0 || opCode == RTOOpVerifyAccountSub) {
				continue
			}
			return nil, werr
		}

		waitRem := time.Until(deadline)
		if waitRem <= 0 {
			c.waitersMu.Lock()
			delete(c.waiters, reqID)
			c.waitersMu.Unlock()
			return nil, errors.New("rtx5tcp: raw binary gateway timeout")
		}

		timer := acquireBinaryOrderTimer(waitRem)
		select {
		case resp, ok := <-ch:
			releaseBinaryOrderTimer(timer)
			if !ok {
				// Pooled socket closed while awaiting response; retry once only for idempotent verification.
				if attempt == 0 && wasCached && opCode == RTOOpVerifyAccountSub {
					continue
				}
				return nil, io.ErrUnexpectedEOF
			}
			releaseBinaryOrderWaitChan(ch)
			return resp, nil

		case <-c.doneCh:
			releaseBinaryOrderTimer(timer)
			c.waitersMu.Lock()
			delete(c.waiters, reqID)
			c.waitersMu.Unlock()
			// Check if readerLoop delivered the response immediately prior to closing doneCh.
			select {
			case resp, ok := <-ch:
				if ok {
					releaseBinaryOrderWaitChan(ch)
					return resp, nil
				}
			default:
			}
			if attempt == 0 && wasCached && opCode == RTOOpVerifyAccountSub {
				continue
			}
			return nil, io.ErrUnexpectedEOF

		case <-timer.C:
			releaseBinaryOrderTimer(timer)
			c.waitersMu.Lock()
			delete(c.waiters, reqID)
			c.waitersMu.Unlock()
			return nil, errors.New("rtx5tcp: raw binary gateway response timeout")
		}
	}

	return nil, errRawGatewayConnClosed
}

// RawGatewayExecuteBinaryOrder sends RTOOpBinaryOrder (0x01) directly over the 32-socket persistent
// Raw Binary TCP pool (127.0.0.1:8190) and returns the raw BinaryOrderFastResp bytes in ~0.02-0.35 ms.
func RawGatewayExecuteBinaryOrder(rawReqPayload []byte, timeout time.Duration) ([]byte, error) {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return rawBinaryGatewayPool.roundTrip(RTOOpBinaryOrder, rawReqPayload, timeout)
}

// RawGatewayVerifyAccountSub sends RTOOpVerifyAccountSub (0x02) over the persistent Raw Binary TCP pool
// and parses the 4-byte [Status:u16_le][Reserved:u16_le] response (Status == 200 means authorized).
func RawGatewayVerifyAccountSub(rawSubPayload []byte, timeout time.Duration) (uint16, error) {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	resp, err := rawBinaryGatewayPool.roundTrip(RTOOpVerifyAccountSub, rawSubPayload, timeout)
	if err != nil {
		return 0, err
	}
	if len(resp) < 4 {
		return 0, fmt.Errorf("rtx5tcp: truncated RTO verify-account-sub response (%d bytes)", len(resp))
	}
	status := binary.LittleEndian.Uint16(resp[0:2])
	return status, nil
}

// DialRawGatewayPushStream connects to addr over Raw Binary TCP (TCP_NODELAY, 512KB read buffer),
// sends ['R','T','O', RTOOpSubscribePushStream (0x04), ReqID=0, PayloadLen=0], and loops reading
// RTOOpPushTradeEvent (0x03) frames and invoking onPush(payload) until EOF or connection error.
func DialRawGatewayPushStream(addr string, onPush func(eventPayload []byte)) error {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		addr = GetDefaultBinaryOrderGatewayAddr()
	}

	dialer := net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	conn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return err
	}
	defer conn.Close()

	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetReadBuffer(512 * 1024)
		_ = tc.SetWriteBuffer(64 * 1024)
	}

	var subHdr [RTOFrameHeaderSize]byte
	subHdr[0] = 'R'
	subHdr[1] = 'T'
	subHdr[2] = 'O'
	subHdr[3] = RTOOpSubscribePushStream
	// subHdr[4..7] = 0 (ReqID = 0 LE)
	// subHdr[8..11] = 0 (PayloadLen = 0 LE)

	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write(subHdr[:]); err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(time.Time{})

	br := bufio.NewReaderSize(conn, 64*1024)
	var hdr [RTOFrameHeaderSize]byte

	for {
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			return err
		}
		if hdr[0] != 'R' || hdr[1] != 'T' || hdr[2] != 'O' {
			return errors.New("rtx5tcp: invalid RTO magic on gateway push stream")
		}
		opCode := hdr[3]
		payloadLen := binary.LittleEndian.Uint32(hdr[8:12])
		if payloadLen > RTOMaxPayloadBytes {
			return fmt.Errorf("rtx5tcp: RTO push payload length %d exceeds max %d", payloadLen, RTOMaxPayloadBytes)
		}

		var payload []byte
		if payloadLen > 0 {
			payload = make([]byte, payloadLen)
			if _, err := io.ReadFull(br, payload); err != nil {
				return err
			}
		} else {
			payload = []byte{}
		}

		if opCode == RTOOpPushTradeEvent && onPush != nil {
			onPush(payload)
		}
	}
}

// SendBinaryOrderRaw transmits a pre-encoded FrameBinaryOrderReq (0x38) payload over the
// Encrypted Binary TCP tunnel and returns the raw FrameBinaryOrderResp (0x39) payload bytes
// without intermediate struct decode/re-encode.
func (s *MuxSession) SendBinaryOrderRaw(rawReqPayload []byte, timeout time.Duration) ([]byte, error) {
	if s == nil || s.tunnel == nil {
		return nil, io.EOF
	}
	if len(rawReqPayload) < BinaryOrderFastReqHeaderSize+2 {
		return nil, ErrTruncatedBinaryOrderFrame
	}
	if len(rawReqPayload) > RTOMaxPayloadBytes {
		return nil, fmt.Errorf("rtx5tcp: binary order payload length %d exceeds max %d", len(rawReqPayload), RTOMaxPayloadBytes)
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}

	sid := s.allocStreamID()
	ch := acquireBinaryOrderWaitChan()

	s.binOrderMu.Lock()
	select {
	case <-s.doneCh:
		s.binOrderMu.Unlock()
		releaseBinaryOrderWaitChan(ch)
		return nil, io.EOF
	default:
	}
	s.binOrderWaiters[sid] = ch
	s.binOrderMu.Unlock()

	if err := s.tunnel.WriteMuxFrame(FrameBinaryOrderReq, sid, FlagFIN, rawReqPayload); err != nil {
		s.binOrderMu.Lock()
		_, stillPending := s.binOrderWaiters[sid]
		delete(s.binOrderWaiters, sid)
		s.binOrderMu.Unlock()
		if stillPending {
			releaseBinaryOrderWaitChan(ch)
		}
		return nil, err
	}

	timer := acquireBinaryOrderTimer(timeout)
	defer releaseBinaryOrderTimer(timer)

	select {
	case rawResp, ok := <-ch:
		if !ok {
			return nil, io.EOF
		}
		releaseBinaryOrderWaitChan(ch)
		if len(rawResp) < BinaryOrderFastRespHeaderSize+4 {
			return nil, ErrTruncatedBinaryOrderFrame
		}
		if rawResp[0] != BinaryOrderCodecVersion {
			return nil, ErrUnsupportedBinaryOrderVer
		}
		return rawResp, nil

	case <-s.doneCh:
		s.binOrderMu.Lock()
		delete(s.binOrderWaiters, sid)
		s.binOrderMu.Unlock()
		select {
		case rawResp, ok := <-ch:
			if ok {
				releaseBinaryOrderWaitChan(ch)
				if len(rawResp) >= BinaryOrderFastRespHeaderSize+4 && rawResp[0] == BinaryOrderCodecVersion {
					return rawResp, nil
				}
			}
		default:
		}
		return nil, io.EOF

	case <-timer.C:
		s.binOrderMu.Lock()
		delete(s.binOrderWaiters, sid)
		s.binOrderMu.Unlock()
		return nil, errors.New("binary TCP order fast-lane timeout")
	}
}

// SendBinaryOrder transmits a compact fixed-header FrameBinaryOrderReq (0x38) over the
// Encrypted Binary TCP tunnel and awaits the fixed-header FrameBinaryOrderResp (0x39).
func (s *MuxSession) SendBinaryOrder(req BinaryOrderFastReq, timeout time.Duration) (BinaryOrderFastResp, error) {
	if err := req.Validate(); err != nil {
		return BinaryOrderFastResp{}, err
	}
	var stackBuf [512]byte
	payload := AppendBinaryOrderFastReq(stackBuf[:0], req)
	rawResp, err := s.SendBinaryOrderRaw(payload, timeout)
	if err != nil {
		return BinaryOrderFastResp{}, err
	}
	return DecodeBinaryOrderFastResp(rawResp)
}

// SetBinaryOrderGate installs an optional fast-path authorization check (e.g. active ExecutionLease)
// evaluated before forwarding FrameBinaryOrderReq (0x38) to the local raw binary order gateway.
func (s *MuxSession) SetBinaryOrderGate(gate func() (bool, string)) {
	if s == nil || gate == nil {
		return
	}
	s.binOrderGate.Store(gate)
}

func (s *MuxSession) handleInboundBinaryOrder(sid uint32, payload []byte) {
	t0 := time.Now()
	if gateFn, ok := s.binOrderGate.Load().(func() (bool, string)); ok && gateFn != nil {
		if allowed, reason := gateFn(); !allowed {
			if reason == "" {
				reason = "Broker ExecutionLease inactive"
			}
			s.sendBinaryOrderError(sid, 503, "LEASE_INACTIVE", reason, t0)
			return
		}
	}
	if len(payload) > RTOMaxPayloadBytes {
		s.sendBinaryOrderError(sid, BinaryOrderStatusBadRequest, "INVALID_BINARY_FRAME", "binary order frame exceeds maximum RTO payload size", t0)
		return
	}

	respBytes, err := rawBinaryGatewayPool.roundTrip(RTOOpBinaryOrder, payload, 15*time.Second)
	if err != nil {
		s.sendBinaryOrderError(sid, BinaryOrderStatusInternalErr, "BINARY_GATEWAY_UNAVAILABLE", err.Error(), t0)
		return
	}
	if len(respBytes) == 0 {
		s.sendBinaryOrderError(sid, BinaryOrderStatusInternalErr, "BINARY_GATEWAY_UNAVAILABLE", "empty response from binary order gateway", t0)
		return
	}

	_ = s.tunnel.WriteMuxFrame(FrameBinaryOrderResp, sid, FlagFIN, respBytes)
}

func (s *MuxSession) sendBinaryOrderError(sid uint32, status uint16, code, msg string, started time.Time) {
	out := BinaryOrderFastResp{
		Status:     status,
		ExecMicros: uint32(time.Since(started).Microseconds()),
		ErrorCode:  code,
		Message:    msg,
	}
	_ = s.tunnel.WriteMuxFrame(FrameBinaryOrderResp, sid, FlagFIN, EncodeBinaryOrderFastResp(out))
}
