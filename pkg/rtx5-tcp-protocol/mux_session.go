package rtx5tcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const rpcChunkSize = 64 * 1024 // 64 KB streaming chunks inside AES-256-GCM tunnel

// RPCRequestMeta is serialized inside FrameRPCReq (followed by optional raw body or chunked frames).
type RPCRequestMeta struct {
	TargetService string              `json:"svc"`
	Method        string              `json:"method"`
	PathWithQuery string              `json:"path"`
	Headers       map[string][]string `json:"headers,omitempty"`
	Body          []byte              `json:"body,omitempty"`
}

// RPCResponseMeta is serialized inside FrameRPCRespHeader.
type RPCResponseMeta struct {
	StatusCode int                 `json:"status"`
	Headers    map[string][]string `json:"headers,omitempty"`
}

// WSOpenMeta is serialized inside FrameWSOpen.
type WSOpenMeta struct {
	TargetService string              `json:"svc"`
	PathWithQuery string              `json:"path"`
	Headers       map[string][]string `json:"headers,omitempty"`
	Subprotocols  []string            `json:"subprotocols,omitempty"`
}

// WSOpenAckMeta is serialized inside FrameWSOpenAck.
type WSOpenAckMeta struct {
	Accepted    bool   `json:"accepted"`
	StatusCode  int    `json:"status_code,omitempty"`
	Subprotocol string `json:"subprotocol,omitempty"`
	Error       string `json:"error,omitempty"`
}

// TargetResolver maps (targetService, pathWithQuery) -> local loopback base URL (e.g. "http://127.0.0.1:8090")
// and trusted loopback Origin header (e.g. "http://127.0.0.1:5173").
type TargetResolver func(targetService string, pathWithQuery string) (localBaseURL string, trustedOrigin string, err error)

// ControlFrameHandler handles non-stream control frames (LP ticks, Heartbeat Nonces, Kill commands, Discovery).
type ControlFrameHandler func(sess *MuxSession, frameType uint8, streamID uint32, flags uint8, payload []byte)

type rpcWaiter struct {
	hdrCh   chan RPCResponseMeta
	chunkCh chan rpcChunk
}

type rpcChunk struct {
	data []byte
	fin  bool
	err  error
}

type wsTunnelStream struct {
	id      uint32
	ackCh   chan WSOpenAckMeta
	msgCh   chan wsFrameMsg
	closed  atomic.Bool
	closeOnce sync.Once
	doneCh  chan struct{}
}

type wsFrameMsg struct {
	frameType uint8
	data      []byte
}

// MuxSession runs a symmetrical, full-duplex multiplexed stream engine over an Encrypted Binary TCP TunnelConn.
// Both sides (Client<->Broker or Broker<->SuperAdmin) can initiate RPCs, SSE streams, WebSockets, and Control Frames!
type MuxSession struct {
	tunnel          *TunnelConn
	isServer        bool
	nextStreamID    atomic.Uint32
	resolver        TargetResolver
	onControl       ControlFrameHandler
	httpClient      *http.Client

	rpcMu           sync.Mutex
	rpcWaiters      map[uint32]*rpcWaiter

	wsMu            sync.Mutex
	wsStreams       map[uint32]*wsTunnelStream

	pingMu          sync.Mutex
	pingWaiters     map[uint32]chan struct{}
	lastRTTMicros   atomic.Int64

	binOrderMu      sync.Mutex
	binOrderWaiters map[uint32]chan []byte
	binOrderGate    atomic.Value // optional func() (bool, string)

	doneCh          chan struct{}
	closeOnce       sync.Once
}

func NewMuxSession(tunnel *TunnelConn, isServer bool, resolver TargetResolver, onControl ControlFrameHandler) *MuxSession {
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 60 * time.Second,
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := dialer.DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			if tc, ok := conn.(*net.TCPConn); ok {
				_ = tc.SetNoDelay(true)
				_ = tc.SetReadBuffer(256 * 1024)
				_ = tc.SetWriteBuffer(256 * 1024)
			}
			return conn, nil
		},
		MaxIdleConns:        1024,
		MaxIdleConnsPerHost: 256,
		MaxConnsPerHost:     0,
		IdleConnTimeout:     180 * time.Second,
		DisableCompression:  true,
		WriteBufferSize:     64 * 1024,
		ReadBufferSize:      64 * 1024,
		ForceAttemptHTTP2:   false,
	}

	s := &MuxSession{
		tunnel:    tunnel,
		isServer:  isServer,
		resolver:  resolver,
		onControl: onControl,
		httpClient: &http.Client{
			Timeout:   0, // No fixed global timeout so SSE / long reports stream cleanly
			Transport: transport,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		rpcWaiters:      make(map[uint32]*rpcWaiter),
		wsStreams:       make(map[uint32]*wsTunnelStream),
		pingWaiters:     make(map[uint32]chan struct{}),
		binOrderWaiters: make(map[uint32]chan []byte),
		doneCh:          make(chan struct{}),
	}
	if isServer {
		s.nextStreamID.Store(2) // Server initiates even StreamIDs: 2, 4, 6...
	} else {
		s.nextStreamID.Store(1) // Client initiates odd StreamIDs: 1, 3, 5...
	}
	return s
}

func (s *MuxSession) allocStreamID() uint32 {
	return s.nextStreamID.Add(2) - 2
}

func (s *MuxSession) Tunnel() *TunnelConn     { return s.tunnel }
func (s *MuxSession) Done() <-chan struct{}   { return s.doneCh }

func (s *MuxSession) Close() error {
	var err error
	s.closeOnce.Do(func() {
		close(s.doneCh)
		err = s.tunnel.Close()

		s.rpcMu.Lock()
		for id, w := range s.rpcWaiters {
			select {
			case w.chunkCh <- rpcChunk{err: io.EOF, fin: true}:
			default:
			}
			delete(s.rpcWaiters, id)
		}
		s.rpcMu.Unlock()

		s.wsMu.Lock()
		for id, ws := range s.wsStreams {
			ws.closeLocal()
			delete(s.wsStreams, id)
		}
		s.wsMu.Unlock()

		s.pingMu.Lock()
		for id, ch := range s.pingWaiters {
			close(ch)
			delete(s.pingWaiters, id)
		}
		s.pingMu.Unlock()

		s.binOrderMu.Lock()
		for id, ch := range s.binOrderWaiters {
			close(ch)
			delete(s.binOrderWaiters, id)
		}
		s.binOrderMu.Unlock()
	})
	return err
}

// LastRTTMs returns the most recently measured Binary TCP wire RTT in milliseconds.
func (s *MuxSession) LastRTTMs() float64 {
	us := s.lastRTTMicros.Load()
	if us <= 0 {
		return 0
	}
	return float64(us) / 1000.0
}

// MeasurePingRTT measures exact AES-256-GCM Binary TCP wire round-trip latency using FramePing -> FramePong.
func (s *MuxSession) MeasurePingRTT(timeout time.Duration) (float64, error) {
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	sid := s.allocStreamID()
	ch := make(chan struct{}, 1)
	s.pingMu.Lock()
	s.pingWaiters[sid] = ch
	s.pingMu.Unlock()

	defer func() {
		s.pingMu.Lock()
		delete(s.pingWaiters, sid)
		s.pingMu.Unlock()
	}()

	t0 := time.Now()
	if err := s.tunnel.WriteMuxFrame(FramePing, sid, FlagNone, nil); err != nil {
		return 0, err
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case _, ok := <-ch:
		if !ok {
			return 0, io.EOF
		}
		us := time.Since(t0).Microseconds()
		if us < 1 {
			us = 1
		}
		s.lastRTTMicros.Store(us)
		return float64(us) / 1000.0, nil
	case <-s.doneCh:
		return 0, io.EOF
	case <-timer.C:
		return 0, errors.New("binary TCP ping timeout")
	}
}

func (ws *wsTunnelStream) closeLocal() {
	ws.closeOnce.Do(func() {
		ws.closed.Store(true)
		close(ws.doneCh)
	})
}

func (s *MuxSession) SendControl(frameType uint8, flags uint8, payload []byte) error {
	return s.tunnel.WriteMuxFrame(frameType, 0, flags, payload)
}

// ServeLoop runs the inbound encrypted frame demultiplexer until the TCP connection closes.
func (s *MuxSession) ServeLoop() error {
	defer s.Close()
	for {
		ft, sid, flags, payload, err := s.tunnel.ReadMuxFrame()
		if err != nil {
			return err
		}

		switch ft {
		case FramePing:
			go func(id uint32, p []byte) {
				_ = s.tunnel.WriteMuxFrame(FramePong, id, FlagNone, p)
			}(sid, append([]byte(nil), payload...))

		case FramePong:
			if sid != 0 {
				s.pingMu.Lock()
				ch, exists := s.pingWaiters[sid]
				if exists {
					delete(s.pingWaiters, sid)
				}
				s.pingMu.Unlock()
				if exists && ch != nil {
					select {
					case ch <- struct{}{}:
					default:
					}
					continue
				}
			}
			if s.onControl != nil {
				s.onControl(s, ft, sid, flags, payload)
			}

		case FrameRPCReq:
			reqCopy := append([]byte(nil), payload...)
			go s.handleInboundRPC(sid, reqCopy)

		case FrameRPCRespHeader:
			var meta RPCResponseMeta
			if err := json.Unmarshal(payload, &meta); err == nil {
				s.rpcMu.Lock()
				w := s.rpcWaiters[sid]
				s.rpcMu.Unlock()
				if w != nil {
					select {
					case w.hdrCh <- meta:
					default:
					}
					if (flags & FlagFIN) != 0 {
						select {
						case w.chunkCh <- rpcChunk{fin: true}:
						default:
						}
					}
				}
			}

		case FrameRPCRespChunk:
			chunkCopy := append([]byte(nil), payload...)
			fin := (flags & FlagFIN) != 0
			var chunkErr error
			if (flags & FlagERR) != 0 {
				chunkErr = errors.New(string(chunkCopy))
			}
			s.rpcMu.Lock()
			w := s.rpcWaiters[sid]
			s.rpcMu.Unlock()
			if w != nil {
				chunk := rpcChunk{data: chunkCopy, fin: fin, err: chunkErr}
				select {
				case w.chunkCh <- chunk:
				default:
					t := time.NewTimer(50 * time.Millisecond)
					select {
					case w.chunkCh <- chunk:
					case <-s.doneCh:
					case <-t.C:
					}
					t.Stop()
				}
			}

		case FrameWSOpen:
			openCopy := append([]byte(nil), payload...)
			go s.handleInboundWSOpen(sid, openCopy)

		case FrameWSOpenAck:
			var ack WSOpenAckMeta
			if err := json.Unmarshal(payload, &ack); err == nil {
				s.wsMu.Lock()
				ws := s.wsStreams[sid]
				s.wsMu.Unlock()
				if ws != nil {
					select {
					case ws.ackCh <- ack:
					default:
					}
				}
			}

		case FrameWSMsgText, FrameWSMsgBinary, FrameWSPing, FrameWSPong:
			msgCopy := append([]byte(nil), payload...)
			s.wsMu.Lock()
			ws := s.wsStreams[sid]
			s.wsMu.Unlock()
			if ws != nil && !ws.closed.Load() {
				wsMsg := wsFrameMsg{frameType: ft, data: msgCopy}
				select {
				case ws.msgCh <- wsMsg:
				default:
					t := time.NewTimer(50 * time.Millisecond)
					select {
					case ws.msgCh <- wsMsg:
					case <-ws.doneCh:
					case <-s.doneCh:
					case <-t.C:
					}
					t.Stop()
				}
			}

		case FrameWSClose:
			s.wsMu.Lock()
			ws := s.wsStreams[sid]
			delete(s.wsStreams, sid)
			s.wsMu.Unlock()
			if ws != nil {
				ws.closeLocal()
			}

		case FrameBinaryOrderReq:
			// ReadMuxFrame already allocates a fresh per-frame backing buffer for payload.
			go s.handleInboundBinaryOrder(sid, payload[:len(payload):len(payload)])

		case FrameBinaryOrderResp:
			s.binOrderMu.Lock()
			ch, exists := s.binOrderWaiters[sid]
			if exists {
				delete(s.binOrderWaiters, sid)
			}
			s.binOrderMu.Unlock()
			if exists && ch != nil {
				select {
				case ch <- payload[:len(payload):len(payload)]:
				default:
				}
			}

		default:
			if s.onControl != nil {
				cp := append([]byte(nil), payload...)
				s.onControl(s, ft, sid, flags, cp)
			}
		}
	}
}

// ProxyHTTP transparently tunnels any local 127.0.0.1 HTTP REST, SSE, or WebSocket request
// through the Encrypted Binary TCP session with zero HTTP/WS on the external network wire!
func (s *MuxSession) ProxyHTTP(w http.ResponseWriter, r *http.Request, targetService string) {
	if websocket.IsWebSocketUpgrade(r) {
		s.proxyWebSocketClient(w, r, targetService)
		return
	}

	var bodyBytes []byte
	if r.Body != nil {
		var err error
		bodyBytes, err = io.ReadAll(io.LimitReader(r.Body, 24*1024*1024))
		if err != nil {
			http.Error(w, "failed reading request body", http.StatusBadRequest)
			return
		}
	}

	hdrs := make(map[string][]string, len(r.Header))
	for k, vals := range r.Header {
		if isHopByHopHeader(k) {
			continue
		}
		cp := make([]string, len(vals))
		copy(cp, vals)
		hdrs[k] = cp
	}

	pathWithQuery := r.URL.RequestURI()
	reqMeta := RPCRequestMeta{
		TargetService: targetService,
		Method:        r.Method,
		PathWithQuery: pathWithQuery,
		Headers:       hdrs,
		Body:          bodyBytes,
	}
	reqBytes, err := json.Marshal(reqMeta)
	if err != nil {
		http.Error(w, "failed encoding binary RPC", http.StatusInternalServerError)
		return
	}

	sid := s.allocStreamID()
	waiter := &rpcWaiter{
		hdrCh:   make(chan RPCResponseMeta, 1),
		chunkCh: make(chan rpcChunk, 128),
	}
	s.rpcMu.Lock()
	s.rpcWaiters[sid] = waiter
	s.rpcMu.Unlock()

	defer func() {
		s.rpcMu.Lock()
		delete(s.rpcWaiters, sid)
		s.rpcMu.Unlock()
	}()

	if err := s.tunnel.WriteMuxFrame(FrameRPCReq, sid, FlagFIN, reqBytes); err != nil {
		http.Error(w, "encrypted binary TCP uplink disconnected", http.StatusBadGateway)
		return
	}

	// Wait for response header
	var respMeta RPCResponseMeta
	select {
	case respMeta = <-waiter.hdrCh:
	case <-r.Context().Done():
		_ = s.tunnel.WriteMuxFrame(FrameRPCAbort, sid, FlagFIN, nil)
		return
	case <-s.doneCh:
		http.Error(w, "encrypted binary TCP session closed", http.StatusBadGateway)
		return
	case <-time.After(90 * time.Second):
		http.Error(w, "upstream service timeout over binary TCP", http.StatusGatewayTimeout)
		return
	}

	for k, vals := range respMeta.Headers {
		if isHopByHopHeader(k) || strings.EqualFold(k, "Content-Length") {
			continue
		}
		if strings.EqualFold(k, "Access-Control-Allow-Origin") {
			if callerOrig := strings.TrimSpace(r.Header.Get("Origin")); callerOrig != "" {
				w.Header().Set(k, callerOrig)
			} else if len(vals) > 0 {
				w.Header().Set(k, vals[0])
			}
			continue
		}
		// Rewrite Secure cookie attribute on local 127.0.0.1 loopback UI bridge if needed
		if strings.EqualFold(k, "Set-Cookie") {
			for _, v := range vals {
				cleaned := strings.ReplaceAll(v, "; Secure", "")
				cleaned = strings.ReplaceAll(cleaned, "; SameSite=None", "; SameSite=Lax")
				w.Header().Add(k, cleaned)
			}
			continue
		}
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	if respMeta.StatusCode <= 0 {
		respMeta.StatusCode = http.StatusOK
	}
	w.WriteHeader(respMeta.StatusCode)

	flusher, canFlush := w.(http.Flusher)
	isSSE := strings.Contains(strings.ToLower(w.Header().Get("Content-Type")), "text/event-stream")
	if isSSE && canFlush {
		flusher.Flush()
	}

	for {
		select {
		case ch := <-waiter.chunkCh:
			if len(ch.data) > 0 && ch.err == nil {
				if _, werr := w.Write(ch.data); werr != nil {
					return
				}
				if canFlush {
					flusher.Flush()
				}
			}
			if ch.fin || ch.err != nil {
				return
			}
		case <-r.Context().Done():
			_ = s.tunnel.WriteMuxFrame(FrameRPCAbort, sid, FlagFIN, nil)
			return
		case <-s.doneCh:
			return
		}
	}
}

// RoundTripRPC performs a direct programmatic RPC call over the MuxSession (used e.g. for Super Admin Reverse Provisioning!).
func (s *MuxSession) RoundTripRPC(targetService, method, pathWithQuery string, headers map[string][]string, body []byte, timeout time.Duration) (int, map[string][]string, []byte, error) {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	reqBytes, err := json.Marshal(RPCRequestMeta{
		TargetService: targetService,
		Method:        method,
		PathWithQuery: pathWithQuery,
		Headers:       headers,
		Body:          body,
	})
	if err != nil {
		return 0, nil, nil, err
	}

	sid := s.allocStreamID()
	waiter := &rpcWaiter{
		hdrCh:   make(chan RPCResponseMeta, 1),
		chunkCh: make(chan rpcChunk, 64),
	}
	s.rpcMu.Lock()
	s.rpcWaiters[sid] = waiter
	s.rpcMu.Unlock()
	defer func() {
		s.rpcMu.Lock()
		delete(s.rpcWaiters, sid)
		s.rpcMu.Unlock()
	}()

	if err := s.tunnel.WriteMuxFrame(FrameRPCReq, sid, FlagFIN, reqBytes); err != nil {
		return 0, nil, nil, err
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	var respMeta RPCResponseMeta
	select {
	case respMeta = <-waiter.hdrCh:
	case <-s.doneCh:
		return 0, nil, nil, io.EOF
	case <-timer.C:
		return 0, nil, nil, errors.New("RPC timeout over binary TCP")
	}

	var buf bytes.Buffer
	for {
		select {
		case ch := <-waiter.chunkCh:
			if ch.err != nil {
				return respMeta.StatusCode, respMeta.Headers, buf.Bytes(), ch.err
			}
			if len(ch.data) > 0 {
				buf.Write(ch.data)
			}
			if ch.fin {
				return respMeta.StatusCode, respMeta.Headers, buf.Bytes(), nil
			}
		case <-s.doneCh:
			return respMeta.StatusCode, respMeta.Headers, buf.Bytes(), io.EOF
		case <-timer.C:
			return respMeta.StatusCode, respMeta.Headers, buf.Bytes(), errors.New("RPC body timeout over binary TCP")
		}
	}
}

var rpcChunkBufPool = sync.Pool{
	New: func() any {
		b := make([]byte, rpcChunkSize)
		return &b
	},
}

func (s *MuxSession) handleInboundRPC(sid uint32, payload []byte) {
	if s.resolver == nil {
		s.sendRPCError(sid, http.StatusBadGateway, "RPC target resolver not configured")
		return
	}
	var reqMeta RPCRequestMeta
	if err := json.Unmarshal(payload, &reqMeta); err != nil {
		s.sendRPCError(sid, http.StatusBadRequest, "malformed RPC metadata")
		return
	}
	baseURL, trustedOrigin, err := s.resolver(reqMeta.TargetService, reqMeta.PathWithQuery)
	if err != nil {
		s.sendRPCError(sid, http.StatusBadGateway, err.Error())
		return
	}

	fullURL := strings.TrimRight(baseURL, "/") + reqMeta.PathWithQuery
	outReq, err := http.NewRequest(reqMeta.Method, fullURL, bytes.NewReader(reqMeta.Body))
	if err != nil {
		s.sendRPCError(sid, http.StatusBadRequest, err.Error())
		return
	}

	for k, vals := range reqMeta.Headers {
		if isHopByHopHeader(k) || strings.EqualFold(k, "Host") || strings.EqualFold(k, "Origin") {
			continue
		}
		for _, v := range vals {
			outReq.Header.Add(k, v)
		}
	}
	if trustedOrigin != "" {
		outReq.Header.Set("Origin", trustedOrigin)
	}
	peerIP := ExtractRemoteIP(s.tunnel.RemoteAddr())
	if peerIP != "" && outReq.Header.Get("X-Real-IP") == "" {
		outReq.Header.Set("X-Real-IP", peerIP)
	}

	resp, err := s.httpClient.Do(outReq)
	if err != nil {
		s.sendRPCError(sid, http.StatusBadGateway, fmt.Sprintf("local microservice unreachable: %v", err))
		return
	}
	defer resp.Body.Close()

	respHdrs := make(map[string][]string, len(resp.Header))
	for k, vals := range resp.Header {
		if isHopByHopHeader(k) {
			continue
		}
		cp := make([]string, len(vals))
		copy(cp, vals)
		respHdrs[k] = cp
	}
	hdrBytes, _ := json.Marshal(RPCResponseMeta{
		StatusCode: resp.StatusCode,
		Headers:    respHdrs,
	})

	bufPtr := rpcChunkBufPool.Get().(*[]byte)
	buf := *bufPtr
	defer rpcChunkBufPool.Put(bufPtr)

	isSSE := strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream")
	if !isSSE {
		n, rerr := io.ReadFull(resp.Body, buf)
		switch {
		case rerr == io.EOF:
			// Empty response body: single FIN header frame (1 lock, 1 syscall).
			_ = s.tunnel.WriteMuxFrame(FrameRPCRespHeader, sid, FlagFIN, hdrBytes)
			return
		case rerr == io.ErrUnexpectedEOF:
			// Entire HTTP response fits in one chunk (99%+ of JSON/order RPCs): coalesce Header + FIN Chunk into 1 lock & 1 TCP packet!
			_ = s.tunnel.WriteMuxFramesBatch([]MuxFrameBatchItem{
				{FrameType: FrameRPCRespHeader, StreamID: sid, Flags: FlagNone, Payload: hdrBytes},
				{FrameType: FrameRPCRespChunk, StreamID: sid, Flags: FlagFIN, Payload: buf[:n]},
			})
			return
		case rerr == nil:
			// Multi-chunk body: coalesce Header + first chunk, then continue streaming below.
			if werr := s.tunnel.WriteMuxFramesBatch([]MuxFrameBatchItem{
				{FrameType: FrameRPCRespHeader, StreamID: sid, Flags: FlagNone, Payload: hdrBytes},
				{FrameType: FrameRPCRespChunk, StreamID: sid, Flags: FlagNone, Payload: buf[:n]},
			}); werr != nil {
				return
			}
		default:
			if n > 0 {
				_ = s.tunnel.WriteMuxFramesBatch([]MuxFrameBatchItem{
					{FrameType: FrameRPCRespHeader, StreamID: sid, Flags: FlagNone, Payload: hdrBytes},
					{FrameType: FrameRPCRespChunk, StreamID: sid, Flags: FlagFIN, Payload: buf[:n]},
				})
			} else {
				_ = s.tunnel.WriteMuxFrame(FrameRPCRespHeader, sid, FlagFIN, hdrBytes)
			}
			return
		}
	} else {
		if err := s.tunnel.WriteMuxFrame(FrameRPCRespHeader, sid, FlagNone, hdrBytes); err != nil {
			return
		}
	}

	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			flags := FlagNone
			if rerr == io.EOF {
				flags = FlagFIN
			}
			if werr := s.tunnel.WriteMuxFrame(FrameRPCRespChunk, sid, flags, buf[:n]); werr != nil {
				return
			}
			if rerr == io.EOF {
				return
			}
		}
		if rerr != nil {
			_ = s.tunnel.WriteMuxFrame(FrameRPCRespChunk, sid, FlagFIN, nil)
			return
		}
	}
}

func (s *MuxSession) sendRPCError(sid uint32, code int, msg string) {
	hdrBytes, _ := json.Marshal(RPCResponseMeta{
		StatusCode: code,
		Headers:    map[string][]string{"Content-Type": {"application/json"}},
	})
	body, _ := json.Marshal(map[string]any{"error": true, "message": msg})
	_ = s.tunnel.WriteMuxFramesBatch([]MuxFrameBatchItem{
		{FrameType: FrameRPCRespHeader, StreamID: sid, Flags: FlagNone, Payload: hdrBytes},
		{FrameType: FrameRPCRespChunk, StreamID: sid, Flags: FlagFIN, Payload: body},
	})
}

func (s *MuxSession) proxyWebSocketClient(w http.ResponseWriter, r *http.Request, targetService string) {
	subprotos := websocket.Subprotocols(r)
	hdrs := make(map[string][]string)
	for _, forwardKey := range []string{"Authorization", "Cookie", "User-Agent", "X-Broker-ID", "X-Account-Login"} {
		if vals := r.Header.Values(forwardKey); len(vals) > 0 {
			cp := make([]string, len(vals))
			copy(cp, vals)
			hdrs[forwardKey] = cp
		}
	}

	sid := s.allocStreamID()
	wsStream := &wsTunnelStream{
		id:     sid,
		ackCh:  make(chan WSOpenAckMeta, 1),
		msgCh:  make(chan wsFrameMsg, 2048),
		doneCh: make(chan struct{}),
	}
	s.wsMu.Lock()
	s.wsStreams[sid] = wsStream
	s.wsMu.Unlock()

	cleanup := func() {
		s.wsMu.Lock()
		_, existed := s.wsStreams[sid]
		delete(s.wsStreams, sid)
		s.wsMu.Unlock()
		wsStream.closeLocal()
		if existed {
			_ = s.tunnel.WriteMuxFrame(FrameWSClose, sid, FlagFIN, nil)
		}
	}
	defer cleanup()

	openBytes, _ := json.Marshal(WSOpenMeta{
		TargetService: targetService,
		PathWithQuery: r.URL.RequestURI(),
		Headers:       hdrs,
		Subprotocols:  subprotos,
	})
	if err := s.tunnel.WriteMuxFrame(FrameWSOpen, sid, FlagNone, openBytes); err != nil {
		http.Error(w, "binary TCP uplink closed before WS open", http.StatusBadGateway)
		return
	}

	var ack WSOpenAckMeta
	select {
	case ack = <-wsStream.ackCh:
	case <-r.Context().Done():
		return
	case <-s.doneCh:
		http.Error(w, "binary TCP session closed", http.StatusBadGateway)
		return
	case <-time.After(15 * time.Second):
		http.Error(w, "upstream WS open timeout", http.StatusGatewayTimeout)
		return
	}

	if !ack.Accepted {
		code := ack.StatusCode
		if code < 400 {
			code = http.StatusBadGateway
		}
		http.Error(w, ack.Error, code)
		return
	}

	upgrader := websocket.Upgrader{
		ReadBufferSize:  64 * 1024,
		WriteBufferSize: 64 * 1024,
		CheckOrigin:     func(req *http.Request) bool { return true },
	}
	if ack.Subprotocol != "" {
		upgrader.Subprotocols = []string{ack.Subprotocol}
	}
	localConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer localConn.Close()

	s.bridgeWebSocketPump(localConn, wsStream)
}

func (s *MuxSession) handleInboundWSOpen(sid uint32, payload []byte) {
	sendReject := func(status int, msg string) {
		b, _ := json.Marshal(WSOpenAckMeta{Accepted: false, StatusCode: status, Error: msg})
		_ = s.tunnel.WriteMuxFrame(FrameWSOpenAck, sid, FlagFIN, b)
	}
	if s.resolver == nil {
		sendReject(http.StatusBadGateway, "WS resolver not configured")
		return
	}
	var meta WSOpenMeta
	if err := json.Unmarshal(payload, &meta); err != nil {
		sendReject(http.StatusBadRequest, "invalid WSOpen metadata")
		return
	}

	baseURL, trustedOrigin, err := s.resolver(meta.TargetService, meta.PathWithQuery)
	if err != nil {
		sendReject(http.StatusBadGateway, err.Error())
		return
	}

	u, err := url.Parse(strings.TrimRight(baseURL, "/") + meta.PathWithQuery)
	if err != nil {
		sendReject(http.StatusBadRequest, err.Error())
		return
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}

	dialHdr := http.Header{}
	for k, vals := range meta.Headers {
		for _, v := range vals {
			dialHdr.Add(k, v)
		}
	}
	if trustedOrigin != "" {
		dialHdr.Set("Origin", trustedOrigin)
	}

	wsStream := &wsTunnelStream{
		id:     sid,
		ackCh:  make(chan WSOpenAckMeta, 1),
		msgCh:  make(chan wsFrameMsg, 2048),
		doneCh: make(chan struct{}),
	}
	s.wsMu.Lock()
	s.wsStreams[sid] = wsStream
	s.wsMu.Unlock()

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		ReadBufferSize:   64 * 1024,
		WriteBufferSize:  64 * 1024,
		Subprotocols:     meta.Subprotocols,
	}
	backendConn, resp, err := dialer.Dial(u.String(), dialHdr)
	if err != nil {
		s.wsMu.Lock()
		delete(s.wsStreams, sid)
		s.wsMu.Unlock()
		wsStream.closeLocal()
		status := http.StatusBadGateway
		if resp != nil && resp.StatusCode > 0 {
			status = resp.StatusCode
		}
		sendReject(status, err.Error())
		return
	}
	defer func() {
		backendConn.Close()
		s.wsMu.Lock()
		_, existed := s.wsStreams[sid]
		delete(s.wsStreams, sid)
		s.wsMu.Unlock()
		wsStream.closeLocal()
		if existed {
			_ = s.tunnel.WriteMuxFrame(FrameWSClose, sid, FlagFIN, nil)
		}
	}()

	ackBytes, _ := json.Marshal(WSOpenAckMeta{
		Accepted:    true,
		StatusCode:  http.StatusSwitchingProtocols,
		Subprotocol: backendConn.Subprotocol(),
	})
	if err := s.tunnel.WriteMuxFrame(FrameWSOpenAck, sid, FlagNone, ackBytes); err != nil {
		return
	}

	s.bridgeWebSocketPump(backendConn, wsStream)
}

func (s *MuxSession) bridgeWebSocketPump(wsConn *websocket.Conn, stream *wsTunnelStream) {
	if tc, ok := wsConn.UnderlyingConn().(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}

	var wsWriteMu sync.Mutex

	wsConn.SetPingHandler(func(appData string) error {
		_ = s.tunnel.WriteMuxFrame(FrameWSPing, stream.id, FlagNone, []byte(appData))
		return nil
	})
	wsConn.SetPongHandler(func(appData string) error {
		_ = s.tunnel.WriteMuxFrame(FrameWSPong, stream.id, FlagNone, []byte(appData))
		return nil
	})

	var wg sync.WaitGroup
	wg.Add(1)

	// Tunnel -> Local/Backend WebSocket Writer
	go func() {
		defer wg.Done()
		for {
			select {
			case msg := <-stream.msgCh:
				wsWriteMu.Lock()
				var werr error
				switch msg.frameType {
				case FrameWSMsgText:
					_ = wsConn.SetWriteDeadline(time.Now().Add(15 * time.Second))
					werr = wsConn.WriteMessage(websocket.TextMessage, msg.data)
				case FrameWSMsgBinary:
					_ = wsConn.SetWriteDeadline(time.Now().Add(15 * time.Second))
					werr = wsConn.WriteMessage(websocket.BinaryMessage, msg.data)
				case FrameWSPing:
					werr = wsConn.WriteControl(websocket.PingMessage, msg.data, time.Now().Add(5*time.Second))
				case FrameWSPong:
					werr = wsConn.WriteControl(websocket.PongMessage, msg.data, time.Now().Add(5*time.Second))
				}
				wsWriteMu.Unlock()
				if werr != nil {
					stream.closeLocal()
					_ = wsConn.Close()
					return
				}
			case <-stream.doneCh:
				_ = wsConn.Close()
				return
			case <-s.doneCh:
				_ = wsConn.Close()
				return
			}
		}
	}()

	// Local/Backend WebSocket Reader -> Tunnel
	for {
		mt, data, err := wsConn.ReadMessage()
		if err != nil {
			stream.closeLocal()
			break
		}
		var ft uint8
		switch mt {
		case websocket.TextMessage:
			ft = FrameWSMsgText
		case websocket.BinaryMessage:
			ft = FrameWSMsgBinary
		case websocket.PingMessage:
			ft = FrameWSPing
		case websocket.PongMessage:
			ft = FrameWSPong
		case websocket.CloseMessage:
			stream.closeLocal()
			break
		default:
			continue
		}
		if ft == 0 {
			break
		}
		if werr := s.tunnel.WriteMuxFrame(ft, stream.id, FlagNone, data); werr != nil {
			stream.closeLocal()
			break
		}
	}

	wg.Wait()
}

func isHopByHopHeader(k string) bool {
	switch strings.ToLower(k) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
		"te", "trailers", "transfer-encoding", "upgrade",
		"sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-accept":
		return true
	}
	return false
}
