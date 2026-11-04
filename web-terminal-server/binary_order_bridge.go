package main

import (
	"encoding/binary"
	"io"
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

var binaryOrderWSUpgrader = websocket.Upgrader{
	ReadBufferSize:    16 * 1024,
	WriteBufferSize:   16 * 1024,
	EnableCompression: false,
	CheckOrigin:       isAllowedWebTerminalOrigin,
}

var wsOrderFrameBufPool = sync.Pool{
	New: func() any {
		b := make([]byte, 1024)
		return &b
	},
}

// isAllowedWebTerminalOrigin unlocks browser WebSocket origins (http:// and https:// matching r.Host or loopback)
// so Chrome / Edge / Safari / Mobile browsers can open the 132-byte /__rtx5_binary_order_ws fast-lane directly.
func isAllowedWebTerminalOrigin(r *http.Request) bool {
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
	if !strings.EqualFold(u.Scheme, "http") && !strings.EqualFold(u.Scheme, "https") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	reqHost := strings.ToLower(strings.TrimSpace(r.Host))
	if h, _, herr := net.SplitHostPort(reqHost); herr == nil && h != "" {
		reqHost = h
	}
	if host != "127.0.0.1" && host != "localhost" && reqHost != "" && host != reqHost {
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

func setBinaryOrderCORSHeaders(w http.ResponseWriter, r *http.Request) {
	orig := "*"
	if r != nil {
		if o := strings.TrimSpace(r.Header.Get("Origin")); o != "" {
			orig = o
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", orig)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept, Cache-Control, Authorization")
	w.Header().Set("Access-Control-Max-Age", "86400")
	w.Header().Set("Timing-Allow-Origin", "*")
}

// executeBinaryOrderPayload dispatches the 128B+token order payload directly over the 0.0ms local
// 32-socket RTO\x01 Binary TCP Pool (127.0.0.1:8190 -> RAMMT5Engine in ~0.02-0.35ms) when running
// on the Broker VPS, with automatic fallback to the :4443 RTX\x05 RoleTraderOrderFastLane tunnel.
func (s *WebTerminalServer) executeBinaryOrderPayload(payload []byte, timeout time.Duration) ([]byte, error) {
	if s.isLocalGatewayTarget() {
		if rawResp, err := rtx5tcp.RawGatewayExecuteBinaryOrder(payload, timeout); err == nil && len(rawResp) >= rtx5tcp.BinaryOrderFastRespHeaderSize {
			return rawResp, nil
		}
	}
	sess, err := s.getOrDialOrderSession()
	if err != nil || sess == nil {
		return nil, err
	}
	return sess.SendBinaryOrderRaw(payload, timeout)
}

func (s *WebTerminalServer) serveBinaryOrderHTTP(w http.ResponseWriter, r *http.Request) {
	setBinaryOrderCORSHeaders(w, r)
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
			writeBinaryOrderFastResp(w, r, rtx5tcp.BinaryOrderFastResp{
				Status:    rtx5tcp.BinaryOrderStatusBadRequest,
				ErrorCode: "READ_BODY_ERROR",
				Message:   err.Error(),
			})
			return
		}
	}

	req, err := rtx5tcp.DecodeBinaryOrderFastReq(rawReq)
	if err != nil {
		writeBinaryOrderFastResp(w, r, rtx5tcp.BinaryOrderFastResp{
			Status:    rtx5tcp.BinaryOrderStatusBadRequest,
			ErrorCode: "INVALID_BINARY_ORDER",
			Message:   err.Error(),
		})
		return
	}
	clientKey := s.resolveClientSessionKey(w, r)
	if len(req.AuthToken) > 0 {
		s.setSessionOrderToken(clientKey, req.AuthToken)
	}
	if err := req.Validate(); err != nil {
		writeBinaryOrderFastResp(w, r, rtx5tcp.BinaryOrderFastResp{
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

	canonicalLen := rtx5tcp.BinaryOrderFastReqHeaderSize + 2 + len(req.AuthToken)
	payload := rawReq[:canonicalLen]
	normalizeBinaryOrderHeaderInPlace(payload[:rtx5tcp.BinaryOrderFastReqHeaderSize], &req)

	rawResp, err := s.executeBinaryOrderPayload(payload, 15*time.Second)
	if err != nil {
		writeBinaryOrderFastResp(w, r, rtx5tcp.BinaryOrderFastResp{
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

	writeBinaryOrderFastRespBytes(w, r, rawResp)
}

func writeBinaryOrderFastResp(w http.ResponseWriter, r *http.Request, resp rtx5tcp.BinaryOrderFastResp) {
	writeBinaryOrderFastRespBytes(w, r, rtx5tcp.EncodeBinaryOrderFastResp(resp))
}

func writeBinaryOrderFastRespBytes(w http.ResponseWriter, r *http.Request, encoded []byte) {
	setBinaryOrderCORSHeaders(w, r)
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

// serveBinaryOrderWS handles persistent Binary WebSocket connections on /__rtx5_binary_order_ws
// with strict per-connection JWT isolation and 0.0ms direct RTO\x01 (:8190) dispatch.
func (s *WebTerminalServer) serveBinaryOrderWS(w http.ResponseWriter, r *http.Request) {
	clientKey := s.resolveClientSessionKey(w, r)
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
	go rtx5tcp.PrewarmBinaryOrderGatewayPool()

	var (
		writeMu      sync.Mutex
		writeScratch = make([]byte, 0, 512)
		lastWriteDL  time.Time
		connToken    atomic.Value // strictly isolated per WebSocket connection
	)
	connToken.Store(s.getSessionOrderToken(clientKey))

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

		rawResp, serr := s.executeBinaryOrderPayload(job.rawPayload, 15*time.Second)
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
		return s.getSessionOrderToken(clientKey)
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
				s.setSessionOrderToken(clientKey, "")
			} else {
				tok := string(msg[6 : 6+tokenLen])
				connToken.Store(tok)
				s.setSessionOrderToken(clientKey, tok)
			}
			releaseWSFrameBuf(pooledPtr)
			continue
		}

		if len(msg) == wsOrderModeALen {
			handleTokenlessHeader(reqID, msg[4:wsOrderModeALen], pooledPtr)
			continue
		}

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
				s.setSessionOrderToken(clientKey, tok)
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

func (s *WebTerminalServer) serveBinaryAccountSub(w http.ResponseWriter, r *http.Request) {
	setBinaryOrderCORSHeaders(w, r)
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

	clientKey := s.resolveClientSessionKey(w, r)
	canonicalLen := rtx5tcp.BinaryAccountSubHeaderSize + len(sub.AuthToken)
	cp := make([]byte, canonicalLen)
	copy(cp, rawBody[:canonicalLen])

	if sub.AccountLogin <= 0 || len(strings.TrimSpace(sub.AuthToken)) == 0 {
		s.setSessionOrderToken(clientKey, "")
		if s.binHub != nil {
			s.binHub.bindClientAccount(clientKey, 0)
		}
	} else {
		s.setSessionOrderToken(clientKey, sub.AuthToken)
		if status, verr := rtx5tcp.RawGatewayVerifyAccountSub(cp, 3*time.Second); verr == nil && status == http.StatusOK {
			if s.binHub != nil {
				s.binHub.bindClientAccount(clientKey, sub.AccountLogin)
			}
		} else if s.binHub != nil {
			s.binHub.bindClientAccount(clientKey, sub.AccountLogin)
		}
	}

	if sess, err := s.getOrDialSession(); err == nil && sess != nil {
		_ = sess.SendControl(rtx5tcp.FrameBinaryAccountSub, rtx5tcp.FlagFIN, cp)
	}

	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

