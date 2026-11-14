package main

// Per-session broker targets.
//
// One web server can serve several brokers: the Terminal login page lists every broker in
// the SuperAdmin directory and asks the server to switch to the one the user picks. Each
// browser session (cookie rtx5_wt_sid) now keeps its own broker, so a switch on one page
// never moves another page. Before this, one global target served every page: a Tradex
// login on the yo4x web server turned the yo4x Admin's prices and API calls to Tradex.
//
// A brokerLink holds one broker's tunnels (terminal, order fast lane, manager, admin) and
// its market hub. Sessions that never chose a broker use the server's own broker (the
// -broker-id / -server flags). Links of other brokers close after linkIdleTimeout without
// use; the default link stays.

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

const (
	linkIdleTimeout        = 10 * time.Minute
	sessionBindingTTL      = 7 * 24 * time.Hour
	sessionBindingTouchGap = time.Minute
)

type brokerLink struct {
	id     string
	target string
	local  bool // the broker on this host: orders and trade events use the :8190 gateway pool

	mu                                        sync.RWMutex
	name                                      string
	activeMux, orderMux, managerMux, adminMux *rtx5tcp.MuxSession
	lastRTTMs, avgRTTMs                       float64

	dialMu, orderDialMu, managerDialMu, adminDialMu sync.Mutex
	orderFastLaneUnsupported                        atomic.Bool

	binHub   *webBinaryMarketHub
	lastUsed atomic.Int64
}

type sessionBinding struct {
	key string
	at  time.Time
}

type sessionKeyCtx struct{}

func linkKey(brokerID, target string) string {
	if id := strings.ToLower(strings.TrimSpace(brokerID)); id != "" {
		return id
	}
	return "tcp:" + strings.ToLower(strings.TrimSpace(target))
}

func isLoopbackTarget(target string) bool {
	return strings.HasPrefix(target, "127.0.0.1:") || strings.HasPrefix(target, "localhost:")
}

func (l *brokerLink) touch() { l.lastUsed.Store(time.Now().UnixNano()) }

func (l *brokerLink) displayName() string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.name != "" {
		return l.name
	}
	return l.id
}

func liveSession(s *rtx5tcp.MuxSession) bool {
	if s == nil {
		return false
	}
	select {
	case <-s.Done():
		return false
	default:
		return true
	}
}

// dialSlot returns the cached tunnel in *slot or dials a new one for role. withControl feeds
// server control frames (ticks, depth, trade events) into this link's market hub.
func (l *brokerLink) dialSlot(slot **rtx5tcp.MuxSession, dialMu *sync.Mutex, role uint8, timeout time.Duration, withControl bool) (*rtx5tcp.MuxSession, error) {
	l.mu.RLock()
	sess := *slot
	l.mu.RUnlock()
	if liveSession(sess) {
		return sess, nil
	}
	dialMu.Lock()
	defer dialMu.Unlock()
	l.mu.RLock()
	sess = *slot
	l.mu.RUnlock()
	if liveSession(sess) {
		return sess, nil
	}
	tc, err := rtx5tcp.DialTunnel(l.target, role, timeout)
	if err != nil {
		return nil, err
	}
	var onControl rtx5tcp.ControlFrameHandler
	if withControl {
		onControl = l.handleServerControlFrame
	}
	newSess := rtx5tcp.NewMuxSession(tc, false, nil, onControl)
	l.mu.Lock()
	*slot = newSess
	l.mu.Unlock()
	go func(s *rtx5tcp.MuxSession) {
		_ = s.ServeLoop()
		l.mu.Lock()
		if *slot == s {
			*slot = nil
		}
		l.mu.Unlock()
	}(newSess)
	return newSess, nil
}

func (l *brokerLink) getOrDialSession() (*rtx5tcp.MuxSession, error) {
	return l.dialSlot(&l.activeMux, &l.dialMu, rtx5tcp.RoleTraderTerminalClient, 8*time.Second, true)
}

func (l *brokerLink) getOrDialManagerSession() (*rtx5tcp.MuxSession, error) {
	return l.dialSlot(&l.managerMux, &l.managerDialMu, rtx5tcp.RoleBrokerManagerClient, 8*time.Second, true)
}

func (l *brokerLink) getOrDialAdminSession() (*rtx5tcp.MuxSession, error) {
	return l.dialSlot(&l.adminMux, &l.adminDialMu, rtx5tcp.RoleBrokerAdminClient, 8*time.Second, false)
}

func (l *brokerLink) getOrDialOrderSession() (*rtx5tcp.MuxSession, error) {
	if l.orderFastLaneUnsupported.Load() {
		return l.getOrDialSession()
	}
	sess, err := l.dialSlot(&l.orderMux, &l.orderDialMu, rtx5tcp.RoleTraderOrderFastLane, 3*time.Second, false)
	if err != nil {
		if strings.Contains(err.Error(), "handshake server ack read failed") {
			l.orderFastLaneUnsupported.Store(true)
		}
		return l.getOrDialSession()
	}
	return sess, nil
}

func (l *brokerLink) handleServerControlFrame(_ *rtx5tcp.MuxSession, frameType uint8, _ uint32, _ uint8, payload []byte) {
	if l.binHub != nil {
		l.binHub.handleControlFrame(frameType, payload)
	}
}

func (l *brokerLink) recordRTT(rtt float64) {
	l.mu.Lock()
	l.lastRTTMs = rtt
	if l.avgRTTMs <= 0 {
		l.avgRTTMs = rtt
	} else {
		l.avgRTTMs = l.avgRTTMs*0.7 + rtt*0.3
	}
	l.mu.Unlock()
}

func (l *brokerLink) rtt() (last, avg float64) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.lastRTTMs, l.avgRTTMs
}

func (l *brokerLink) closeAll() {
	l.mu.Lock()
	sessions := []*rtx5tcp.MuxSession{l.activeMux, l.orderMux, l.managerMux, l.adminMux}
	l.activeMux, l.orderMux, l.managerMux, l.adminMux = nil, nil, nil, nil
	l.mu.Unlock()
	seen := make(map[*rtx5tcp.MuxSession]bool, len(sessions))
	for _, s := range sessions {
		if s != nil && !seen[s] {
			seen[s] = true
			_ = s.Close()
		}
	}
}

func (l *brokerLink) hasStreamSubscribers() bool {
	if l.binHub == nil {
		return false
	}
	l.binHub.mu.RLock()
	defer l.binHub.mu.RUnlock()
	return len(l.binHub.subs) > 0
}

// ensureLink returns the link for this broker, creating it when needed. The broker on this
// host always uses the loopback target. It returns nil when no target is known.
func (c *WebTerminalServer) ensureLink(brokerID, brokerName, target string) *brokerLink {
	brokerID = strings.TrimSpace(brokerID)
	brokerName = strings.TrimSpace(brokerName)
	target = strings.TrimSpace(target)
	if c.localBrokerID != "" && strings.EqualFold(brokerID, c.localBrokerID) && c.localTarget != "" {
		target = c.localTarget
	}
	if target == "" {
		return nil
	}
	key := linkKey(brokerID, target)

	c.linksMu.Lock()
	if c.links == nil {
		c.links = make(map[string]*brokerLink)
	}
	if l := c.links[key]; l != nil && strings.EqualFold(l.target, target) {
		c.linksMu.Unlock()
		if brokerName != "" {
			l.mu.Lock()
			l.name = brokerName
			l.mu.Unlock()
		}
		l.touch()
		return l
	}
	old := c.links[key]
	local := isLoopbackTarget(target) || (c.localBrokerID != "" && strings.EqualFold(brokerID, c.localBrokerID))
	l := &brokerLink{id: brokerID, name: brokerName, target: target, local: local, binHub: newWebBinaryMarketHub()}
	l.touch()
	c.links[key] = l
	c.linksMu.Unlock()

	if old != nil {
		old.closeAll() // the broker moved to another address
	}
	if local && c.directGatewayPush {
		// Direct :8190 RTO\x01 push stream (0.0 ms trade-event fanout when co-located with rtx5-gateway)
		l.binHub.startDirectGatewayPushLoop()
	}
	return l
}

// setDefaultBroker sets the broker for sessions that never chose one.
func (c *WebTerminalServer) setDefaultBroker(brokerID, brokerName, target string) *brokerLink {
	l := c.ensureLink(brokerID, brokerName, target)
	c.linksMu.Lock()
	if l != nil {
		c.defaultLinkKey = linkKey(l.id, l.target)
	} else {
		// No target yet: remember the identity so status pages still name the broker.
		c.defaultBrokerID = strings.TrimSpace(brokerID)
		c.defaultBrokerName = strings.TrimSpace(brokerName)
	}
	c.linksMu.Unlock()
	return l
}

func (c *WebTerminalServer) defaultLink() *brokerLink {
	c.linksMu.RLock()
	l := c.links[c.defaultLinkKey]
	c.linksMu.RUnlock()
	if l != nil {
		l.touch()
	}
	return l
}

// bindSession makes sessionKey use link l from now on.
func (c *WebTerminalServer) bindSession(sessionKey string, l *brokerLink) {
	if sessionKey == "" || l == nil {
		return
	}
	c.linksMu.Lock()
	if c.sessionBrokers == nil {
		c.sessionBrokers = make(map[string]sessionBinding)
	}
	c.sessionBrokers[sessionKey] = sessionBinding{key: linkKey(l.id, l.target), at: time.Now()}
	c.linksMu.Unlock()
}

// linkForSession returns the broker this session chose, or the server's default broker.
func (c *WebTerminalServer) linkForSession(sessionKey string) *brokerLink {
	if sessionKey != "" {
		c.linksMu.RLock()
		b, ok := c.sessionBrokers[sessionKey]
		l := c.links[b.key]
		c.linksMu.RUnlock()
		if ok && l != nil {
			if time.Since(b.at) > sessionBindingTouchGap {
				c.linksMu.Lock()
				if cur, still := c.sessionBrokers[sessionKey]; still && cur.key == b.key {
					c.sessionBrokers[sessionKey] = sessionBinding{key: b.key, at: time.Now()}
				}
				c.linksMu.Unlock()
			}
			l.touch()
			return l
		}
	}
	return c.defaultLink()
}

func (c *WebTerminalServer) linkForRequest(r *http.Request) *brokerLink {
	return c.linkForSession(requestSessionKey(r))
}

// requestSessionKey reads the session key without creating one.
func requestSessionKey(r *http.Request) string {
	if r == nil {
		return ""
	}
	if v, ok := r.Context().Value(sessionKeyCtx{}).(string); ok && v != "" {
		return v
	}
	if ck, err := r.Cookie("rtx5_wt_sid"); err == nil && strings.TrimSpace(ck.Value) != "" {
		return strings.TrimSpace(ck.Value)
	}
	return strings.TrimSpace(r.Header.Get("X-RTX5-Session"))
}

// withSessionKey pins the session key on the request, so every later lookup in the same
// request sees the same session even when the cookie was only just issued.
func withSessionKey(r *http.Request, sessionKey string) *http.Request {
	if r == nil || sessionKey == "" {
		return r
	}
	return r.WithContext(context.WithValue(r.Context(), sessionKeyCtx{}, sessionKey))
}

// activeLinks returns every link; the default link first.
func (c *WebTerminalServer) activeLinks() []*brokerLink {
	c.linksMu.RLock()
	defer c.linksMu.RUnlock()
	out := make([]*brokerLink, 0, len(c.links))
	if d := c.links[c.defaultLinkKey]; d != nil {
		out = append(out, d)
	}
	for k, l := range c.links {
		if k != c.defaultLinkKey {
			out = append(out, l)
		}
	}
	return out
}

// pruneIdle closes the tunnels of other brokers' links that nobody used for linkIdleTimeout
// (they dial again on the next request) and drops session choices older than
// sessionBindingTTL. A link leaves the map only when no session choice refers to it.
func (c *WebTerminalServer) pruneIdle(now time.Time) {
	var closing []*brokerLink
	c.linksMu.Lock()
	referenced := make(map[string]bool, len(c.links))
	for sid, b := range c.sessionBrokers {
		if now.Sub(b.at) > sessionBindingTTL {
			delete(c.sessionBrokers, sid)
			continue
		}
		referenced[b.key] = true
	}
	for k, l := range c.links {
		if k == c.defaultLinkKey || l.hasStreamSubscribers() {
			continue
		}
		if now.Sub(time.Unix(0, l.lastUsed.Load())) > linkIdleTimeout {
			if !referenced[k] {
				delete(c.links, k)
			}
			closing = append(closing, l)
		}
	}
	c.linksMu.Unlock()
	for _, l := range closing {
		l.closeAll()
	}
}

// isIdle reports whether the link had no use for linkIdleTimeout (the keep-alive loop skips it).
func (l *brokerLink) isIdle(now time.Time) bool {
	return now.Sub(time.Unix(0, l.lastUsed.Load())) > linkIdleTimeout
}

var errNoBrokerTarget = errors.New("no broker target configured for this session")

// linkIdentity returns the broker id, name and TCP target a page sees for link l.
func (c *WebTerminalServer) linkIdentity(l *brokerLink) (id, name, target string) {
	if l == nil {
		c.linksMu.RLock()
		defer c.linksMu.RUnlock()
		return c.defaultBrokerID, c.defaultBrokerName, ""
	}
	return l.id, l.displayName(), l.target
}
