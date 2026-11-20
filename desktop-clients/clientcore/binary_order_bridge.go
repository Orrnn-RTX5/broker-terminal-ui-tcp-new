package clientcore

import (
	"encoding/binary"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	rtx5tcp "rtx5-tcp-protocol"
)

const (
	wsOrderReqIDSize   = 4
	wsOrderModeALen    = wsOrderReqIDSize + rtx5tcp.BinaryOrderFastReqHeaderSize     // 132 bytes
	wsOrderModeBMinLen = wsOrderReqIDSize + rtx5tcp.BinaryOrderFastReqHeaderSize + 2 // 134 bytes
	wsOrderWorkers     = 32
	wsOrderQueueCap    = 256
)

// clientBinaryAccountSubs stores the latest active raw FrameBinaryAccountSub payload ([]byte)
// per *DesktopClient (only when AccountLogin > 0) so reconnects automatically rebind
// real-time binary trade/position/account push events (0x3A) without mutating DesktopClient fields.
var clientBinaryAccountSubs sync.Map

var binaryOrderWSUpgrader = websocket.Upgrader{
	ReadBufferSize:    16 * 1024,
	WriteBufferSize:   16 * 1024,
	EnableCompression: false,
	CheckOrigin:       isLoopbackOrderOrigin,
}

var wsOrderFrameBufPool = sync.Pool{
	New: func() any {
		b := make([]byte, 1024)
		return &b
	},
}

// isLoopbackOrderOrigin enforces strict loopback origin security on /__rtx5_binary_order_ws,
// allowing empty Origin or http://127.0.0.1 / http://localhost (with any valid port) and
// rejecting all external web or sandboxed origins.
func isLoopbackOrderOrigin(r *http.Request) bool {
	if r == nil {
		return false
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.User != nil {
		return false
	}
	if !strings.EqualFold(u.Scheme, "http") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host != "127.0.0.1" && host != "localhost" {
		return false
	}
	if port := u.Port(); port != "" {
		p, perr := strconv.Atoi(port)
		if perr != nil || p < 1 || p > 65535 {
			return false
		}
	}
	return true
}

func (c *DesktopClient) setCachedOrderAuthToken(tok string) {
	if c == nil {
		return
	}
	c.cachedOrderAuthToken.Store(tok)
}

func (c *DesktopClient) getCachedOrderAuthToken() string {
	if c == nil {
		return ""
	}
	if v, ok := c.cachedOrderAuthToken.Load().(string); ok {
		return v
	}
	return ""
}

// rebindBinaryAccountSub replays the last bound FrameBinaryAccountSub (0x3B) control frame
// onto a newly established Encrypted Binary TCP MuxSession, retrying up to 3 times with short backoff.
func (c *DesktopClient) rebindBinaryAccountSub(sess *rtx5tcp.MuxSession) {
	if c == nil || sess == nil {
		return
	}
	const maxAttempts = 3
	backoffs := [...]time.Duration{150 * time.Millisecond, 400 * time.Millisecond}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		select {
		case <-sess.Done():
			return
		default:
		}
		v, ok := clientBinaryAccountSubs.Load(c)
		if !ok {
			return
		}
		rawAccountSub, ok := v.([]byte)
		if !ok || len(rawAccountSub) == 0 {
			return
		}
		err := sess.SendControl(rtx5tcp.FrameBinaryAccountSub, rtx5tcp.FlagFIN, rawAccountSub)
		if err == nil {
			return
		}
		if attempt+1 >= maxAttempts {
			log.Printf("[BINARY-STREAM] rebindBinaryAccountSub failed after %d attempts: %v", maxAttempts, err)
			return
		}
		timer := time.NewTimer(backoffs[attempt])
		select {
		case <-sess.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func setBinaryOrderCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept, Cache-Control, Authorization")
	w.Header().Set("Access-Control-Max-Age", "86400")
	w.Header().Set("Timing-Allow-Origin", "*")
}

// getOrDialOrderSession maintains a dedicated 2nd Encrypted Binary TCP tunnel
// (RoleTraderOrderFastLane = 0x07) exclusively for 128-byte 0x38/0x39 binary orders
// so order execution never queues behind 68KB-178KB REST RPC responses or 198-symbol
// tick/candle bursts on activeMux. Automatically falls back to getOrDialSession() if
// the remote server does not yet support RoleTraderOrderFastLane.
func (c *DesktopClient) getOrDialOrderSession() (*rtx5tcp.MuxSession, error) {
	if c.cfg.Kind == KindSuperAdmin || c.orderFastLaneUnsupported.Load() {
		return c.getOrDialSession()
	}

	c.mu.RLock()
	sess := c.orderMux
	c.mu.RUnlock()
	if sess != nil {
		select {
		case <-sess.Done():
		default:
			return sess, nil
		}
	}

	c.orderDialMu.Lock()
	defer c.orderDialMu.Unlock()

	if c.orderFastLaneUnsupported.Load() {
		return c.getOrDialSession()
	}

	c.mu.RLock()
	sess = c.orderMux
	target := c.targetTCPAddr
	c.mu.RUnlock()
	if sess != nil {
		select {
		case <-sess.Done():
		default:
			return sess, nil
		}
	}
	if target == "" {
		return c.getOrDialSession()
	}

	tc, err := rtx5tcp.DialTunnel(target, rtx5tcp.RoleTraderOrderFastLane, 5*time.Second)
	if err != nil {
		return c.getOrDialSession()
	}
	newSess := rtx5tcp.NewMuxSession(tc, false, nil, nil)
	go func(s *rtx5tcp.MuxSession) {
		_ = s.ServeLoop()
		c.mu.Lock()
		if c.orderMux == s {
			c.orderMux = nil
		}
		c.mu.Unlock()
	}(newSess)

	c.mu.Lock()
	c.orderMux = newSess
	c.mu.Unlock()
	return newSess, nil
}

// serveLocalBinaryOrder handles POST /__rtx5_binary_order (application/octet-stream) on both
// the dedicated fast-lane loopback port (BINARY_ORDER_URL) and the primary loopback bridge,
// forwarding compact 128-byte fixed-header BinaryOrderFastReq frames directly over
// FrameBinaryOrderReq (0x38) -> FrameBinaryOrderResp (0x39) with zero JSON on the client wire.
func (c *DesktopClient) serveLocalBinaryOrder(w http.ResponseWriter, r *http.Request) {
	setBinaryOrderCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.Header().Set("Allow", "POST, OPTIONS")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var rawReq []byte
	if r.Body != nil {
		defer r.Body.Close()
		var err error
		rawReq, err = io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err != nil {
			writeBinaryOrderFastResp(w, rtx5tcp.BinaryOrderFastResp{
				Status:    rtx5tcp.BinaryOrderStatusBadRequest,
				ErrorCode: "READ_BODY_ERROR",
				Message:   err.Error(),
			})
			return
		}
	}

	req, err := rtx5tcp.DecodeBinaryOrderFastReq(rawReq)
	if err != nil {
		writeBinaryOrderFastResp(w, rtx5tcp.BinaryOrderFastResp{
			Status:    rtx5tcp.BinaryOrderStatusBadRequest,
			ErrorCode: "INVALID_BINARY_ORDER",
			Message:   err.Error(),
		})
		return
	}
	if len(req.AuthToken) > 0 {
		c.setCachedOrderAuthToken(req.AuthToken)
	}
	if err := req.Validate(); err != nil {
		writeBinaryOrderFastResp(w, rtx5tcp.BinaryOrderFastResp{
			Action:         req.Action,
			Status:         rtx5tcp.BinaryOrderStatusBadRequest,
			OrderTicket:    req.Ticket,
			PositionTicket: req.Ticket,
			Symbol:         req.Symbol,
			ClientOrderID:  req.ClientOrderID,
			ErrorCode:      "INVALID_ORDER_PARAMS",
			Message:        err.Error(),
		})
		return
	}

	sess, err := c.getOrDialOrderSession()
	if err != nil || sess == nil {
		writeBinaryOrderFastResp(w, rtx5tcp.BinaryOrderFastResp{
			Action:         req.Action,
			Status:         503,
			OrderTicket:    req.Ticket,
			PositionTicket: req.Ticket,
			Symbol:         req.Symbol,
			ClientOrderID:  req.ClientOrderID,
			ErrorCode:      "TCP_TUNNEL_DISCONNECTED",
			Message:        "Encrypted Binary TCP uplink disconnected",
		})
		return
	}

	canonicalLen := rtx5tcp.BinaryOrderFastReqHeaderSize + 2 + len(req.AuthToken)
	payload := rawReq[:canonicalLen]
	normalizeBinaryOrderHeaderInPlace(payload[:rtx5tcp.BinaryOrderFastReqHeaderSize], &req)

	rawResp, err := sess.SendBinaryOrderRaw(payload, 15*time.Second)
	if err != nil {
		writeBinaryOrderFastResp(w, rtx5tcp.BinaryOrderFastResp{
			Action:         req.Action,
			Status:         504,
			OrderTicket:    req.Ticket,
			PositionTicket: req.Ticket,
			Symbol:         req.Symbol,
			ClientOrderID:  req.ClientOrderID,
			ErrorCode:      "BINARY_TCP_TIMEOUT",
			Message:        err.Error(),
		})
		return
	}

	writeBinaryOrderFastRespBytes(w, rawResp)
}

func writeBinaryOrderFastResp(w http.ResponseWriter, resp rtx5tcp.BinaryOrderFastResp) {
	writeBinaryOrderFastRespBytes(w, rtx5tcp.EncodeBinaryOrderFastResp(resp))
}

func writeBinaryOrderFastRespBytes(w http.ResponseWriter, encoded []byte) {
	setBinaryOrderCORSHeaders(w)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(encoded)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded)
}

func normalizeBinaryOrderHeaderInPlace(hdr128 []byte, decoded *rtx5tcp.BinaryOrderFastReq) {
	hdr128[6] = 0
	hdr128[7] = 0
	copy(hdr128[72:88], decoded.Symbol[:])
	copy(hdr128[88:128], decoded.ClientOrderID[:])
}

func validateBinaryOrderHeaderZeroAlloc(hdr128 []byte, out *rtx5tcp.BinaryOrderFastReq) (errCode string, err error) {
	if len(hdr128) < rtx5tcp.BinaryOrderFastReqHeaderSize {
		return "INVALID_BINARY_ORDER", rtx5tcp.ErrTruncatedBinaryOrderFrame
	}
	var stackFrame [rtx5tcp.BinaryOrderFastReqHeaderSize + 2]byte
	copy(stackFrame[:rtx5tcp.BinaryOrderFastReqHeaderSize], hdr128[:rtx5tcp.BinaryOrderFastReqHeaderSize])
	// stackFrame[128:130] == 0 avoids string heap allocation for AuthToken during header validation
	if derr := rtx5tcp.DecodeBinaryOrderFastReqInto(stackFrame[:], out); derr != nil {
		return "INVALID_BINARY_ORDER", derr
	}
	if verr := out.Validate(); verr != nil {
		return "INVALID_ORDER_PARAMS", verr
	}
	return "", nil
}

type wsBinaryOrderJob struct {
	reqID      uint32
	rawPayload []byte
	poolBuf    *[]byte
}

func releaseWSFrameBuf(bufPtr *[]byte) {
	if bufPtr != nil {
		wsOrderFrameBufPool.Put(bufPtr)
	}
}

// serveLocalBinaryOrderWS handles persistent Binary WebSocket connections on /__rtx5_binary_order_ws
// (both on fastOrderPort and localPort), eliminating per-click HTTP/CORS handshakes and forwarding
// 132-byte tokenless (Mode A) or >=134-byte inline-token (Mode B) frames directly over
// RoleTraderOrderFastLane via SendBinaryOrderRaw with concurrent pipelining.
func (c *DesktopClient) serveLocalBinaryOrderWS(w http.ResponseWriter, r *http.Request) {
	wsConn, err := binaryOrderWSUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer wsConn.Close()

	if netConn := wsConn.UnderlyingConn(); netConn != nil {
		if tc, ok := netConn.(*net.TCPConn); ok {
			_ = tc.SetNoDelay(true)
			_ = tc.SetReadBuffer(256 * 1024)
			_ = tc.SetWriteBuffer(256 * 1024)
		}
	}

	wsConn.SetReadLimit(64 * 1024)

	// Pre-warm dedicated RoleTraderOrderFastLane (0x07) tunnel immediately on WS connect
	go func() {
		_, _ = c.getOrDialOrderSession()
	}()

	var (
		writeMu      sync.Mutex
		writeScratch = make([]byte, 0, 512)
		lastWriteDL  time.Time
		connToken    atomic.Value // stores string
	)
	connToken.Store("")

	writeWSRawResp := func(reqID uint32, rawResp []byte) error {
		writeMu.Lock()
		needed := wsOrderReqIDSize + len(rawResp)
		if cap(writeScratch) < needed {
			writeScratch = make([]byte, needed)
		}
		out := writeScratch[:needed]
		binary.LittleEndian.PutUint32(out[0:4], reqID)
		copy(out[4:], rawResp)
		if now := time.Now(); lastWriteDL.Sub(now) < 2*time.Second {
			lastWriteDL = now.Add(10 * time.Second)
			_ = wsConn.SetWriteDeadline(lastWriteDL)
		}
		werr := wsConn.WriteMessage(websocket.BinaryMessage, out)
		writeMu.Unlock()
		return werr
	}

	writeWSErrorResp := func(reqID uint32, resp rtx5tcp.BinaryOrderFastResp) error {
		writeMu.Lock()
		if cap(writeScratch) < 256 {
			writeScratch = make([]byte, 4, 256)
		} else {
			writeScratch = writeScratch[:4]
		}
		binary.LittleEndian.PutUint32(writeScratch[0:4], reqID)
		writeScratch = rtx5tcp.AppendBinaryOrderFastResp(writeScratch, resp)
		if now := time.Now(); lastWriteDL.Sub(now) < 2*time.Second {
			lastWriteDL = now.Add(10 * time.Second)
			_ = wsConn.SetWriteDeadline(lastWriteDL)
		}
		werr := wsConn.WriteMessage(websocket.BinaryMessage, writeScratch)
		writeMu.Unlock()
		return werr
	}

	executeOrderJob := func(job wsBinaryOrderJob) {
		defer releaseWSFrameBuf(job.poolBuf)

		sess, derr := c.getOrDialOrderSession()
		if derr != nil || sess == nil {
			var req rtx5tcp.BinaryOrderFastReq
			_, _ = validateBinaryOrderHeaderZeroAlloc(job.rawPayload[:rtx5tcp.BinaryOrderFastReqHeaderSize], &req)
			_ = writeWSErrorResp(job.reqID, rtx5tcp.BinaryOrderFastResp{
				Action:         req.Action,
				Status:         503,
				OrderTicket:    req.Ticket,
				PositionTicket: req.Ticket,
				Symbol:         req.Symbol,
				ClientOrderID:  req.ClientOrderID,
				ErrorCode:      "TCP_TUNNEL_DISCONNECTED",
				Message:        "Encrypted Binary TCP uplink disconnected",
			})
			return
		}

		rawResp, serr := sess.SendBinaryOrderRaw(job.rawPayload, 15*time.Second)
		if serr != nil {
			var req rtx5tcp.BinaryOrderFastReq
			_, _ = validateBinaryOrderHeaderZeroAlloc(job.rawPayload[:rtx5tcp.BinaryOrderFastReqHeaderSize], &req)
			_ = writeWSErrorResp(job.reqID, rtx5tcp.BinaryOrderFastResp{
				Action:         req.Action,
				Status:         504,
				OrderTicket:    req.Ticket,
				PositionTicket: req.Ticket,
				Symbol:         req.Symbol,
				ClientOrderID:  req.ClientOrderID,
				ErrorCode:      "BINARY_TCP_TIMEOUT",
				Message:        serr.Error(),
			})
			return
		}

		_ = writeWSRawResp(job.reqID, rawResp)
	}

	workCh := make(chan wsBinaryOrderJob, wsOrderQueueCap)
	var workersWG sync.WaitGroup
	for i := 0; i < wsOrderWorkers; i++ {
		workersWG.Add(1)
		go func() {
			defer workersWG.Done()
			for job := range workCh {
				executeOrderJob(job)
			}
		}()
	}
	defer func() {
		close(workCh)
		workersWG.Wait()
	}()

	dispatchJob := func(reqID uint32, rawPayload []byte, poolBuf *[]byte) {
		job := wsBinaryOrderJob{reqID: reqID, rawPayload: rawPayload, poolBuf: poolBuf}
		select {
		case workCh <- job:
		default:
			go executeOrderJob(job)
		}
	}

	resolveToken := func() string {
		if tok, _ := connToken.Load().(string); tok != "" {
			return tok
		}
		return c.getCachedOrderAuthToken()
	}

	handleTokenlessHeader := func(reqID uint32, hdr128 []byte, poolBuf *[]byte) {
		tok := resolveToken()
		if tok == "" {
			action := hdr128[1]
			releaseWSFrameBuf(poolBuf)
			_ = writeWSErrorResp(reqID, rtx5tcp.BinaryOrderFastResp{
				Action:    action,
				Status:    rtx5tcp.BinaryOrderStatusUnauthorized,
				ErrorCode: "AUTH_TOKEN_REQUIRED",
				Message:   "missing cached auth token",
			})
			return
		}

		var req rtx5tcp.BinaryOrderFastReq
		if errCode, verr := validateBinaryOrderHeaderZeroAlloc(hdr128, &req); verr != nil {
			action := hdr128[1]
			releaseWSFrameBuf(poolBuf)
			if errCode == "INVALID_ORDER_PARAMS" {
				_ = writeWSErrorResp(reqID, rtx5tcp.BinaryOrderFastResp{
					Action:         req.Action,
					Status:         rtx5tcp.BinaryOrderStatusBadRequest,
					OrderTicket:    req.Ticket,
					PositionTicket: req.Ticket,
					Symbol:         req.Symbol,
					ClientOrderID:  req.ClientOrderID,
					ErrorCode:      errCode,
					Message:        verr.Error(),
				})
			} else {
				_ = writeWSErrorResp(reqID, rtx5tcp.BinaryOrderFastResp{
					Action:    action,
					Status:    rtx5tcp.BinaryOrderStatusBadRequest,
					ErrorCode: errCode,
					Message:   verr.Error(),
				})
			}
			return
		}

		tokLen := len(tok)
		totalLen := rtx5tcp.BinaryOrderFastReqHeaderSize + 2 + tokLen
		if tokLen > 65535 || totalLen > rtx5tcp.RTOMaxPayloadBytes {
			releaseWSFrameBuf(poolBuf)
			_ = writeWSErrorResp(reqID, rtx5tcp.BinaryOrderFastResp{
				Action:    req.Action,
				Status:    rtx5tcp.BinaryOrderStatusBadRequest,
				ErrorCode: "INVALID_BINARY_ORDER",
				Message:   "auth token exceeds maximum RTO payload size",
			})
			return
		}

		var rawPayload []byte
		var ownedPool *[]byte
		if poolBuf != nil && cap(*poolBuf) >= totalLen {
			rawPayload = (*poolBuf)[:totalLen]
			copy(rawPayload[:rtx5tcp.BinaryOrderFastReqHeaderSize], hdr128[:rtx5tcp.BinaryOrderFastReqHeaderSize])
			ownedPool = poolBuf
		} else {
			rawPayload = make([]byte, totalLen)
			copy(rawPayload[:rtx5tcp.BinaryOrderFastReqHeaderSize], hdr128[:rtx5tcp.BinaryOrderFastReqHeaderSize])
			releaseWSFrameBuf(poolBuf)
		}
		normalizeBinaryOrderHeaderInPlace(rawPayload[:rtx5tcp.BinaryOrderFastReqHeaderSize], &req)
		binary.LittleEndian.PutUint16(rawPayload[128:130], uint16(tokLen))
		copy(rawPayload[130:], tok)

		dispatchJob(reqID, rawPayload, ownedPool)
	}

	for {
		mt, rdr, rerr := wsConn.NextReader()
		if rerr != nil {
			return
		}
		if mt != websocket.BinaryMessage {
			_, _ = io.Copy(io.Discard, rdr)
			continue
		}

		bufPtr := wsOrderFrameBufPool.Get().(*[]byte)
		buf := (*bufPtr)[:cap(*bufPtr)]
		n, ferr := io.ReadFull(rdr, buf)
		var msg []byte
		var pooledPtr *[]byte
		switch {
		case ferr == io.EOF:
			releaseWSFrameBuf(bufPtr)
			continue
		case ferr == io.ErrUnexpectedEOF:
			msg = buf[:n]
			pooledPtr = bufPtr
		case ferr == nil:
			rest, merr := io.ReadAll(rdr)
			if merr != nil {
				releaseWSFrameBuf(bufPtr)
				return
			}
			if len(rest) == 0 {
				msg = buf[:n]
				pooledPtr = bufPtr
			} else {
				full := make([]byte, n+len(rest))
				copy(full, buf[:n])
				copy(full[n:], rest)
				releaseWSFrameBuf(bufPtr)
				msg = full
			}
		default:
			releaseWSFrameBuf(bufPtr)
			return
		}

		if len(msg) < wsOrderReqIDSize {
			releaseWSFrameBuf(pooledPtr)
			continue
		}

		reqID := binary.LittleEndian.Uint32(msg[0:4])

		// 1. reqId == 0: Auth Token Sync Control Frame ([0..3] reqId=0, [4..5] tokenLen, [6..6+tokenLen] token)
		if reqID == 0 {
			if len(msg) < 6 {
				releaseWSFrameBuf(pooledPtr)
				continue
			}
			tokenLen := int(binary.LittleEndian.Uint16(msg[4:6]))
			if len(msg) < 6+tokenLen {
				releaseWSFrameBuf(pooledPtr)
				continue
			}
			if tokenLen == 0 {
				connToken.Store("")
				c.setCachedOrderAuthToken("")
			} else {
				tok := string(msg[6 : 6+tokenLen])
				connToken.Store(tok)
				c.setCachedOrderAuthToken(tok)
			}
			releaseWSFrameBuf(pooledPtr)
			continue
		}

		// 2. reqId >= 1, Mode A: Ultra-Fast 132-byte Tokenless Frame
		if len(msg) == wsOrderModeALen {
			handleTokenlessHeader(reqID, msg[4:wsOrderModeALen], pooledPtr)
			continue
		}

		// 3. reqId >= 1, Mode B: Self-Contained >= 134-byte Inline-Token Frame
		if len(msg) >= wsOrderModeBMinLen {
			tokenLen := int(binary.LittleEndian.Uint16(msg[132:134]))
			if len(msg) < wsOrderModeBMinLen+tokenLen {
				action := msg[5]
				releaseWSFrameBuf(pooledPtr)
				_ = writeWSErrorResp(reqID, rtx5tcp.BinaryOrderFastResp{
					Action:    action,
					Status:    rtx5tcp.BinaryOrderStatusBadRequest,
					ErrorCode: "INVALID_BINARY_ORDER",
					Message:   rtx5tcp.ErrTruncatedBinaryOrderFrame.Error(),
				})
				continue
			}

			if tokenLen == 0 {
				handleTokenlessHeader(reqID, msg[4:wsOrderModeALen], pooledPtr)
				continue
			}

			tokBytes := msg[134 : 134+tokenLen]
			curConnTok, _ := connToken.Load().(string)
			if len(curConnTok) != tokenLen || string(tokBytes) != curConnTok {
				tok := string(tokBytes)
				connToken.Store(tok)
				c.setCachedOrderAuthToken(tok)
			} else if c.getCachedOrderAuthToken() != curConnTok {
				c.setCachedOrderAuthToken(curConnTok)
			}

			rawPayload := msg[4 : wsOrderModeBMinLen+tokenLen]
			if len(rawPayload) > rtx5tcp.RTOMaxPayloadBytes {
				action := msg[5]
				releaseWSFrameBuf(pooledPtr)
				_ = writeWSErrorResp(reqID, rtx5tcp.BinaryOrderFastResp{
					Action:    action,
					Status:    rtx5tcp.BinaryOrderStatusBadRequest,
					ErrorCode: "INVALID_BINARY_ORDER",
					Message:   "binary order frame exceeds maximum RTO payload size",
				})
				continue
			}

			var req rtx5tcp.BinaryOrderFastReq
			if errCode, verr := validateBinaryOrderHeaderZeroAlloc(rawPayload[:rtx5tcp.BinaryOrderFastReqHeaderSize], &req); verr != nil {
				action := rawPayload[1]
				releaseWSFrameBuf(pooledPtr)
				if errCode == "INVALID_ORDER_PARAMS" {
					_ = writeWSErrorResp(reqID, rtx5tcp.BinaryOrderFastResp{
						Action:         req.Action,
						Status:         rtx5tcp.BinaryOrderStatusBadRequest,
						OrderTicket:    req.Ticket,
						PositionTicket: req.Ticket,
						Symbol:         req.Symbol,
						ClientOrderID:  req.ClientOrderID,
						ErrorCode:      errCode,
						Message:        verr.Error(),
					})
				} else {
					_ = writeWSErrorResp(reqID, rtx5tcp.BinaryOrderFastResp{
						Action:    action,
						Status:    rtx5tcp.BinaryOrderStatusBadRequest,
						ErrorCode: errCode,
						Message:   verr.Error(),
					})
				}
				continue
			}

			normalizeBinaryOrderHeaderInPlace(rawPayload[:rtx5tcp.BinaryOrderFastReqHeaderSize], &req)
			dispatchJob(reqID, rawPayload[:len(rawPayload):len(rawPayload)], pooledPtr)
			continue
		}

		// Truncated reqId >= 1 frame (len < 132 or len == 133)
		var action uint8
		if len(msg) >= 6 {
			action = msg[5]
		}
		releaseWSFrameBuf(pooledPtr)
		_ = writeWSErrorResp(reqID, rtx5tcp.BinaryOrderFastResp{
			Action:    action,
			Status:    rtx5tcp.BinaryOrderStatusBadRequest,
			ErrorCode: "INVALID_BINARY_ORDER",
			Message:   rtx5tcp.ErrTruncatedBinaryOrderFrame.Error(),
		})
	}
}

// serveLocalBinaryAccountSub handles POST /__rtx5_binary_account_sub (application/octet-stream)
// to bind or unbind (AccountLogin <= 0) real-time pushed FrameBinaryTradeEvent (0x3A) updates
// over the Encrypted Binary TCP tunnel via FrameBinaryAccountSub (0x3B).
func (c *DesktopClient) serveLocalBinaryAccountSub(w http.ResponseWriter, r *http.Request) {
	setBinaryOrderCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.Header().Set("Allow", "POST, OPTIONS")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var rawBody []byte
	if r.Body != nil {
		defer r.Body.Close()
		var err error
		rawBody, err = io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err != nil {
			http.Error(w, "failed reading binary account subscription", http.StatusBadRequest)
			return
		}
	}

	sub, err := rtx5tcp.DecodeBinaryAccountSub(rawBody)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	canonicalLen := rtx5tcp.BinaryAccountSubHeaderSize + len(sub.AuthToken)
	cp := make([]byte, canonicalLen)
	copy(cp, rawBody[:canonicalLen])

	if sub.AccountLogin < 0 || (sub.AccountLogin == 0 && len(strings.TrimSpace(sub.AuthToken)) == 0) {
		c.setCachedOrderAuthToken("")
		clientBinaryAccountSubs.Delete(c)
	} else {
		if len(sub.AuthToken) > 0 {
			c.setCachedOrderAuthToken(sub.AuthToken)
			go func() {
				_, _ = c.getOrDialOrderSession()
			}()
		}
		clientBinaryAccountSubs.Store(c, cp)
	}

	if sess, err := c.getOrDialSession(); err == nil && sess != nil {
		_ = sess.SendControl(rtx5tcp.FrameBinaryAccountSub, rtx5tcp.FlagFIN, cp)
	}

	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
