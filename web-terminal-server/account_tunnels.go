package main

// Per-account (and per-manager/admin) market tunnels.
//
// The :4443 server applies the quote gate (which symbols, how many) per tunnel, and the last 0x3B
// subscription on a tunnel decides it. A brokerLink therefore keeps:
//
//   - the shared guest tunnel (activeMux, brokerLink.binHub): the public market feed and the REST/order
//     proxy tunnel. No tab's 0x3B is ever sent onto it, and it is the ONLY tunnel that feeds the guest hub
//     (the manager/admin REST tunnels do not feed any hub).
//   - one accountTunnel per (role, login, sha256(token)): its own tunnel dialled with the matching role
//     (trader terminal / broker manager / broker admin; the access server treats all three alike for market
//     frames and 0x3A), shared by every tab that subscribes with the same login and token, with its own
//     market cache and subscriber set (accountTunnel.hub). A forged token has a different key, so it gets its
//     own tunnel and can neither overwrite a real subscription nor reach a real account's hub.
//
// Every /__rtx5_binary_stream tab (webBinaryStreamSub) takes market frames from exactly one source: the hub
// of its tunnel while that tunnel is "committed", otherwise the guest hub.
//
// Committed (protocol-free barrier): the access server sends a guest snapshot on connect and may send guest
// ticks before it has applied a 0x3B, and it blocks the tunnel's pump while it applies one. So after every
// 0x3B written on a tunnel (first dial, every redial) a ping is sent on the same mux; the tunnel becomes
// committed only when a market frame arrives AFTER the pong (hub.armedAt is set when the pong is back; the
// access server writes no guest frame after it handled the 0x3B, so no guard time is needed). Every market
// frame before that is dropped unseen (never cached, never fanned out). A tunnel that is not committed (just
// dialled, redialled, token rejected so its pump stays blocked) never holds a tab: its tabs sit on the guest
// source. Commitment is used for moving tabs, for eviction and for the close-after-10 s rule.
//
// 0x3A private events are separate: a tab's claimed login (an account, or -1 for the manager/admin wildcard)
// only becomes its effective login (accountLogin, what delivery filters on) once proven: the gateway verified
// the token, or its own tunnel received a 0x3A for that login (hub.authed).
//
// Locking (outer to inner): brokerLink.srcMu -> brokerLink.acctMu -> accountTunnel.mu -> hub.mu.
// srcMu.Lock serialises every source/binding change; 0x3A delivery takes srcMu.RLock, so a tab moving between
// sources can neither miss nor double-receive an event. srcMu is never taken per tick: the tick path takes
// only hub.mu (write for the cache, read for the fan-out of non-blocking channel sends, no I/O). The commit
// reconcile runs on its own goroutine, never on the mux reader. A tab leaves its old hub under that hub's
// write lock and joins the new hub (snapshot queued first) under the new hub's write lock, so after the move
// nothing more arrives from the old source.

import (
	"bytes"
	"crypto/sha256"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

const (
	// A tunnel no tab uses and that saw no 0x3B for this long is closed.
	accountTunnelIdleTimeout = 2 * time.Minute
	accountTunnelDialTimeout = 4 * time.Second
	// A tunnel that was never committed this long after its creation is closed.
	accountTunnelCommitTimeout = 10 * time.Second
	accountTunnelPingTimeout   = 3 * time.Second
	// A keep-alive ping on a live tunnel that fails (write error) or whose pong is missing this long closes the
	// tunnel, so the redial path runs. A silent market is NOT a dead tunnel: only the ping decides.
	tunnelLivenessPingTimeout = 5 * time.Second
	// Order / manager / admin sessions close only after this many consecutive failed keep-alive pings (an
	// in-flight reply must survive one >3 s stall); guest and account market tunnels close on the first.
	sessionPingFailLimit = 2
	// A tunnel that has stayed uncommitted this long with no authenticating 0x3A is closed (the claim backoff
	// then takes over).
	accountTunnelStuckTimeout = 5 * time.Minute
	// Default of maxUncommittedTunnelsPerIP; RTX5_WEB_MAX_UNCOMMITTED_TUNNELS_PER_IP overrides it.
	defaultMaxUncommittedTunnelsPerIP = 32
	// Re-creation of a tunnel closed under a live claim backs off 10 s, 20 s, ... up to 60 s.
	accountRetryMin = 10 * time.Second
	accountRetryMax = 60 * time.Second
	// A session's subscription is forgotten this long after its last stream closed.
	sessionBindingIdleTTL = 10 * time.Minute
)

// Variables so tests can shrink them.
var (
	// A live tunnel that is not committed gets its latest 0x3B and a fresh barrier (a lost pong, or a post-commit
	// snapshot that was missed). Consecutive re-arms that do not commit back off along this list (the last
	// value repeats); a commit or a new dial resets it.
	accountRearmDelays          = []time.Duration{3 * time.Second, 6 * time.Second, 12 * time.Second, 30 * time.Second, 60 * time.Second}
	maxAccountTunnelsPerLink    = 256
	maxAccountTunnelsPerSession = 2
	maxUncommittedTunnelsPerIP  = defaultMaxUncommittedTunnelsPerIP
	// Peers whose X-Forwarded-For / X-Real-IP is believed (RTX5_WEB_TRUSTED_PROXY_CIDRS); empty = never.
	trustedProxyNets []*net.IPNet
	// How long a committed tunnel may receive no market frame before an identical 0x3B re-POST is written again
	// (renews the quote subscription on the access server). The de-dup of identical payloads stays otherwise.
	accountSubRenewQuiet = 30 * time.Second
	// The keep-alive ping; a variable so tests can fail it.
	keepAlivePing = func(s *rtx5tcp.MuxSession, timeout time.Duration) (float64, error) {
		return s.MeasurePingRTT(timeout)
	}
	// The barrier ping; a variable so tests can lose a pong.
	barrierPing = func(s *rtx5tcp.MuxSession) error {
		_, err := s.MeasurePingRTT(accountTunnelPingTimeout)
		return err
	}
)

// parseTrustedProxyCIDRs parses a comma-separated list of CIDRs / single IPs. It returns the networks and the
// entries that are not valid (skipped).
func parseTrustedProxyCIDRs(list string) (nets []*net.IPNet, invalid []string) {
	for _, part := range strings.Split(list, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		cidr := part
		if !strings.Contains(cidr, "/") {
			if ip := net.ParseIP(cidr); ip != nil {
				if ip.To4() != nil {
					cidr += "/32"
				} else {
					cidr += "/128"
				}
			}
		}
		if _, n, err := net.ParseCIDR(cidr); err == nil {
			nets = append(nets, n)
		} else {
			invalid = append(invalid, part)
		}
	}
	return nets, invalid
}

// configureAccountTunnelLimits reads the per-address cap and the trusted proxies from the environment (call
// once at startup, before serving).
func configureAccountTunnelLimits() {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("RTX5_WEB_MAX_UNCOMMITTED_TUNNELS_PER_IP"))); err == nil && v > 0 {
		maxUncommittedTunnelsPerIP = v
	}
	nets, invalid := parseTrustedProxyCIDRs(os.Getenv("RTX5_WEB_TRUSTED_PROXY_CIDRS"))
	for _, bad := range invalid {
		log.Printf("[ACCT-TUNNEL] RTX5_WEB_TRUSTED_PROXY_CIDRS: ignoring invalid entry %q", bad)
	}
	trustedProxyNets = nets
}

func ipTrusted(ip net.IP) bool {
	for _, n := range trustedProxyNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

type accountKey struct {
	role  uint8
	login int64 // 0 = manager/admin wildcard subscription
	tok   [sha256.Size]byte
}

func makeAccountKey(role uint8, login int64, token string) accountKey {
	return accountKey{role: role, login: login, tok: sha256.Sum256([]byte(token))}
}

// roleForAppKind maps the page's app kind to the tunnel role its market tunnel is dialled with.
func roleForAppKind(appKind string) uint8 {
	switch appKind {
	case "manager":
		return rtx5tcp.RoleBrokerManagerClient
	case "admin":
		return rtx5tcp.RoleBrokerAdminClient
	}
	return rtx5tcp.RoleTraderTerminalClient
}

// parseClientIP parses an address as it appears in RemoteAddr or a forwarded header: with or without a port,
// IPv6 with or without brackets. An IPv4-mapped IPv6 address (::ffff:1.2.3.4) becomes the IPv4 address.
func parseClientIP(s string) net.IP {
	s = strings.TrimSpace(s)
	if h, _, err := net.SplitHostPort(s); err == nil {
		s = h
	}
	s = strings.Trim(s, "[]")
	ip := net.ParseIP(s)
	if ip == nil {
		return nil
	}
	if v4 := ip.To4(); v4 != nil {
		return v4
	}
	return ip
}

// clientKeyOf is the canonical key of a client address for per-address limits: the IPv4 address, or the /64
// of an IPv6 address (one subscriber commonly owns a whole /64).
func clientKeyOf(ip net.IP) string {
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// remoteIP is the client address key of the request. It is the direct peer, unless the peer is one of the
// configured trusted proxies: then the client is the right-most X-Forwarded-For entry (across all header
// lines, last line first) that is not itself a trusted proxy, falling back to X-Real-IP. X-Real-IP is only as
// good as the proxy that sets it: it is believed only because the peer is a trusted proxy, and a proxy that
// forwards a client-supplied X-Real-IP unchanged makes it forgeable. The headers are never believed from any
// other peer.
func remoteIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	pip := parseClientIP(r.RemoteAddr)
	if pip == nil {
		return r.RemoteAddr
	}
	if !ipTrusted(pip) {
		return clientKeyOf(pip)
	}
	var entries []string
	for _, line := range r.Header.Values("X-Forwarded-For") {
		entries = append(entries, strings.Split(line, ",")...)
	}
	for i := len(entries) - 1; i >= 0; i-- {
		ip := parseClientIP(entries[i])
		if ip == nil {
			break // garbage: do not guess
		}
		if !ipTrusted(ip) {
			return clientKeyOf(ip)
		}
	}
	if ip := parseClientIP(r.Header.Get("X-Real-IP")); ip != nil {
		return clientKeyOf(ip)
	}
	return clientKeyOf(pip)
}

// sessionAcct is what a browser session last subscribed with.
type sessionAcct struct {
	login    int64 // claimed: account login, or -1 for the wildcard
	key      accountKey
	verified bool
	payload  []byte // the 0x3B, to re-create a closed tunnel
	ip       string
	seen     time.Time
}

type retryState struct {
	next  time.Time
	delay time.Duration
}

type accountTunnel struct {
	key       accountKey
	login     int64 // key.login
	creator   string
	creatorIP string
	link      *brokerLink
	hub       *webBinaryMarketHub

	cur           atomic.Pointer[rtx5tcp.MuxSession] // current live tunnel, nil while down
	lastActive    atomic.Int64                       // unix nanos: last 0x3B or last time a tab used it
	born          atomic.Int64
	everCommitted atomic.Bool
	pinging       atomic.Bool
	lastBarrier   atomic.Int64 // unix nanos of the last 0x3B + barrier attempt
	rearms        atomic.Int32 // consecutive re-arms that did not commit (indexes accountRearmDelays)
	// unix nanos since when the tunnel has been uncommitted (0 while committed).
	uncommittedSince atomic.Int64
	lastMarket       atomic.Int64 // unix nanos: last market frame accepted from the tunnel (committed or arming)
	lastRenew        atomic.Int64 // unix nanos: last identical 0x3B written again by renewSub

	mu      sync.Mutex // sub, dialing, closed
	sub     []byte     // latest 0x3B payload, re-sent after every dial
	dialing bool
	closed  bool

	sendMu      sync.Mutex // serialises 0x3B + barrier so the freshest payload is written last
	sentSess    *rtx5tcp.MuxSession
	sentPayload []byte // what sendMu's last successful write put on sentSess
}

func (t *accountTunnel) live() bool   { return liveSession(t.cur.Load()) }
func (t *accountTunnel) usable() bool { return t.live() && t.hub.committed.Load() }
func (t *accountTunnel) touch()       { t.lastActive.Store(time.Now().UnixNano()) }

// markUncommitted records when the tunnel stopped being committed (first transition wins).
func (t *accountTunnel) markUncommitted() {
	t.uncommittedSince.CompareAndSwap(0, time.Now().UnixNano())
}

// rearmDelay is how long after the last barrier attempt the next re-arm is due.
func (t *accountTunnel) rearmDelay() time.Duration {
	n := int(t.rearms.Load())
	if n >= len(accountRearmDelays) {
		n = len(accountRearmDelays) - 1
	}
	return accountRearmDelays[n]
}

// sendLatest writes the latest 0x3B on the tunnel (when it is up) and then runs the barrier: a ping on the
// same mux. Once the pong is back, market frames arriving after the pong commit the tunnel. A tunnel that
// is down gets it after its dial. Runs on its own goroutine, never on a handler or a reader.
func (t *accountTunnel) sendLatest() {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	sess := t.cur.Load()
	if !liveSession(sess) {
		return
	}
	t.mu.Lock()
	payload := t.sub
	t.mu.Unlock()
	if len(payload) == 0 {
		return
	}
	if t.sentSess == sess && bytes.Equal(t.sentPayload, payload) {
		return // already written on this tunnel; do not uncommit it for nothing
	}
	// A new 0x3B uncommits the tunnel: its tabs go back to the guest source until it commits again.
	t.hub.armedAt.Store(0)
	if t.hub.committed.CompareAndSwap(true, false) {
		t.markUncommitted()
		go t.link.reconcileTunnel(t)
	}
	if err := sess.SendControl(rtx5tcp.FrameBinaryAccountSub, rtx5tcp.FlagFIN, payload); err != nil {
		return
	}
	t.sentSess, t.sentPayload = sess, payload
	t.lastBarrier.Store(time.Now().UnixNano())
	if err := barrierPing(sess); err != nil || t.cur.Load() != sess {
		return // keepAccountTunnelsWarm re-arms
	}
	// The access server writes no guest frame after it handled the 0x3B, so a market frame received from
	// here on is post-gate: it commits the tunnel (no guard time).
	t.hub.armedAt.Store(time.Now().UnixNano())
}

// resend writes the latest 0x3B again (a fresh barrier follows). For a tunnel whose barrier was lost or whose
// post-commit snapshot was missed; on :4443 a re-sent 0x3B for an uncommitted pump is a normal non-renewal.
func (t *accountTunnel) resend() {
	t.sendMu.Lock()
	if t.hub.committed.Load() { // it committed while this re-arm was queued: never uncommit it
		t.sendMu.Unlock()
		return
	}
	t.sentSess = nil
	t.sendMu.Unlock()
	t.sendLatest()
}

// renewDue reports whether an identical 0x3B re-POST must be written again: the tunnel is up and committed and
// has received no market frame (and no renewal / barrier) for accountSubRenewQuiet.
func (t *accountTunnel) renewDue(now time.Time) bool {
	if !t.live() || !t.hub.committed.Load() {
		return false
	}
	last := max(t.lastMarket.Load(), t.lastRenew.Load(), t.lastBarrier.Load())
	return now.UnixNano()-last >= int64(accountSubRenewQuiet)
}

// renewSub writes the latest 0x3B again on a committed tunnel without a barrier and without uncommitting it
// (the payload is unchanged, so the gate stays the same and tabs stay on the tunnel's hub).
func (t *accountTunnel) renewSub() {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	sess := t.cur.Load()
	if !liveSession(sess) || !t.hub.committed.Load() {
		return
	}
	t.mu.Lock()
	payload := t.sub
	t.mu.Unlock()
	if len(payload) == 0 {
		return
	}
	// Only the exact payload already written on this session may be re-sent here. A changed t.sub (a tab just
	// posted a new payload and sendLatest is on its way) must go through sendLatest's uncommit + barrier, so
	// renewSub leaves it to that and never writes it (and never sets sentPayload, which would make sendLatest skip).
	if t.sentSess != sess || !bytes.Equal(t.sentPayload, payload) {
		return
	}
	t.lastRenew.Store(time.Now().UnixNano())
	if err := sess.SendControl(rtx5tcp.FrameBinaryAccountSub, rtx5tcp.FlagFIN, payload); err != nil {
		return
	}
	t.sentSess, t.sentPayload = sess, payload
}

// pingOrClose runs a keep-alive ping on s and closes the session when it fails (write error) or its pong does
// not arrive within timeout, so the owner's existing redial path runs. Close is idempotent.
func pingOrClose(s *rtx5tcp.MuxSession, timeout time.Duration) (float64, error) {
	rtt, err := keepAlivePing(s, timeout)
	if err != nil {
		_ = s.Close()
	}
	return rtt, err
}

// pingStrikes counts consecutive failed keep-alive pings of one long-lived session (order / manager / admin).
// Those sessions carry in-flight replies, so one 3 s stall must not close them: only `limit` failures in a row
// do, and any successful ping resets the count. The count is per session pointer (a redialed session starts at 0).
type pingStrikes struct {
	mu   sync.Mutex
	sess *rtx5tcp.MuxSession
	n    int
}

func (p *pingStrikes) ping(s *rtx5tcp.MuxSession, timeout time.Duration, limit int) (float64, error) {
	rtt, err := keepAlivePing(s, timeout)
	p.mu.Lock()
	if p.sess != s {
		p.sess, p.n = s, 0
	}
	closeNow := false
	if err == nil {
		p.n = 0
	} else if p.n++; p.n >= limit {
		closeNow = true
		p.sess, p.n = nil, 0
	}
	p.mu.Unlock()
	if closeNow {
		_ = s.Close()
	}
	return rtt, err
}

// detach marks the tunnel closed and returns its session for the caller to Close outside any lock.
func (t *accountTunnel) detach() *rtx5tcp.MuxSession {
	t.mu.Lock()
	t.closed = true
	t.mu.Unlock()
	return t.cur.Swap(nil)
}

func (t *accountTunnel) close() {
	if s := t.detach(); s != nil {
		_ = s.Close()
	}
}

func closeSessions(list []*rtx5tcp.MuxSession) {
	for _, s := range list {
		if s != nil {
			_ = s.Close()
		}
	}
}

func isMarketFrame(ft uint8) bool {
	switch ft {
	case rtx5tcp.FrameBinaryTickBatch, rtx5tcp.FrameBinaryCandleBatch, rtx5tcp.FrameBinaryDepthBatch, rtx5tcp.FrameLPDepthBatch:
		return true
	}
	return false
}

// onFrame handles a control frame of this tunnel's current session.
func (t *accountTunnel) onFrame(s *rtx5tcp.MuxSession, frameType uint8, payload []byte) {
	if s != t.cur.Load() { // a frame of a tunnel that was replaced or closed
		return
	}
	first := false
	if isMarketFrame(frameType) && !t.hub.committed.Load() {
		if t.hub.armedAt.Load() == 0 {
			return // before the barrier: possibly pre-gate (guest snapshot / guest tick); never cached or sent
		}
		first = true
	}
	if isMarketFrame(frameType) {
		t.lastMarket.Store(time.Now().UnixNano())
	}
	t.hub.handleControlFrame(frameType, payload)
	if first && t.hub.armedAt.Load() != 0 && t.hub.committed.CompareAndSwap(false, true) {
		t.everCommitted.Store(true)
		t.rearms.Store(0)
		t.uncommittedSince.Store(0)
		go t.link.reconcileTunnel(t) // off the mux reader; the first frame is already in the hub's cache
	}
}

func (l *brokerLink) lookupAcct(key accountKey) *accountTunnel {
	l.acctMu.RLock()
	t := l.acct[key]
	l.acctMu.RUnlock()
	return t
}

// oldestUncommittedLocked picks an eviction victim: the least recently used tunnel that is not committed,
// optionally only those of one session / one client address. Caller holds acctMu.
func (l *brokerLink) oldestUncommittedLocked(creator, ip string) *accountTunnel {
	var victim *accountTunnel
	for _, x := range l.acct {
		if x.hub.committed.Load() || (creator != "" && x.creator != creator) || (ip != "" && x.creatorIP != ip) {
			continue
		}
		if victim == nil || x.lastActive.Load() < victim.lastActive.Load() {
			victim = x
		}
	}
	return victim
}

// getOrCreateAccountTunnel returns the tunnel for key, making it when needed. Limits (per session, per client
// address for uncommitted tunnels, per link) evict uncommitted tunnels first; it returns nil for a retired
// link, and when a limit is hit and every candidate is committed (then the tab stays on the guest source).
func (l *brokerLink) getOrCreateAccountTunnel(key accountKey, creator, ip string) *accountTunnel {
	if t := l.lookupAcct(key); t != nil {
		return t
	}
	var evicted []*accountTunnel
	var created *accountTunnel
	refused := ""
	evict := func(v *accountTunnel) {
		delete(l.acct, v.key)
		evicted = append(evicted, v)
	}
	l.acctMu.Lock()
	switch {
	case l.acctClosed:
	case l.acct[key] != nil:
		created = l.acct[key]
	default:
		ok := true
		if creator != "" {
			n := 0
			for _, x := range l.acct {
				if x.creator == creator {
					n++
				}
			}
			if n >= maxAccountTunnelsPerSession {
				if v := l.oldestUncommittedLocked(creator, ""); v != nil {
					evict(v)
				} else {
					ok, refused = false, "per-session tunnel limit reached and all are committed"
				}
			}
		}
		if ok && ip != "" {
			n := 0
			for _, x := range l.acct {
				if x.creatorIP == ip && !x.hub.committed.Load() {
					n++
				}
			}
			if n >= maxUncommittedTunnelsPerIP {
				if v := l.oldestUncommittedLocked("", ip); v != nil {
					evict(v)
				}
			}
		}
		if ok && len(l.acct) >= maxAccountTunnelsPerLink {
			if v := l.oldestUncommittedLocked("", ""); v != nil {
				evict(v)
			} else {
				ok, refused = false, "link tunnel cap reached and every tunnel is committed"
			}
		}
		if ok {
			t := &accountTunnel{key: key, login: key.login, creator: creator, creatorIP: ip, link: l, hub: newWebBinaryMarketHub()}
			t.hub.acctOwner = t
			t.hub.tradeSink = l.binHub
			t.hub.onAuth = func(firstPayload []byte) {
				go func() {
					l.reconcileTunnel(t)
					if len(firstPayload) > 0 {
						l.binHub.broadcastTradeEvent(firstPayload)
					}
				}()
			} // async so MuxSession.ServeLoop() is never blocked; delivers first 0x3A right after binding
			t.born.Store(time.Now().UnixNano())
			t.uncommittedSince.Store(t.born.Load())
			t.touch()
			if l.acct == nil {
				l.acct = make(map[accountKey]*accountTunnel)
			}
			l.acct[key] = t
			created = t
		}
	}
	l.acctMu.Unlock()
	if len(evicted) > 0 {
		l.dropTunnels(evicted)
	}
	if refused != "" {
		l.logRefused(key, refused)
	}
	return created
}

// logRefused logs (at most every 10 s per link) that a real subscription could not get its own tunnel.
func (l *brokerLink) logRefused(key accountKey, why string) {
	now := time.Now().UnixNano()
	last := l.lastRefuse.Load()
	if now-last < int64(10*time.Second) || !l.lastRefuse.CompareAndSwap(last, now) {
		return
	}
	log.Printf("[ACCT-TUNNEL] broker %s: no new market tunnel for role=%d login=%d: %s (tab stays on the guest feed)", l.id, key.role, key.login, why)
}

// setAccountSub records the tab's 0x3B as the tunnel's latest subscription, makes sure the tunnel is (being)
// dialled and writes the subscription when it is up. It never blocks on the network. The same subscription
// again (another tab, a re-POST) writes nothing and so never uncommits the tunnel.
func (l *brokerLink) setAccountSub(clientKey, ip string, key accountKey, payload []byte) {
	if len(payload) == 0 {
		return
	}
	t := l.getOrCreateAccountTunnel(key, clientKey, ip)
	if t == nil {
		return
	}
	t.mu.Lock()
	same := bytes.Equal(t.sub, payload)
	t.sub = payload
	t.mu.Unlock()
	t.touch()
	l.ensureAccountTunnel(t)
	if !same {
		go t.sendLatest()
	} else if t.renewDue(time.Now()) {
		go t.renewSub() // identical 0x3B on a tunnel that went quiet: renew it instead of skipping
	}
}

// ensureAccountTunnel dials the tunnel in the background when it is down.
func (l *brokerLink) ensureAccountTunnel(t *accountTunnel) {
	t.mu.Lock()
	if t.closed || t.dialing || t.live() {
		t.mu.Unlock()
		return
	}
	t.dialing = true
	t.mu.Unlock()
	go l.dialAccountTunnel(t)
}

func (l *brokerLink) dialAccountTunnel(t *accountTunnel) {
	defer func() {
		t.mu.Lock()
		t.dialing = false
		t.mu.Unlock()
	}()
	tc, err := rtx5tcp.DialTunnel(l.target, t.key.role, accountTunnelDialTimeout)
	if err != nil {
		return
	}
	sess := rtx5tcp.NewMuxSession(tc, false, nil, func(s *rtx5tcp.MuxSession, frameType uint8, _ uint32, _ uint8, payload []byte) {
		t.onFrame(s, frameType, payload)
	})
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		_ = sess.Close()
		return
	}
	// Only this hub's own feeding tunnel clears this hub's cache; a fresh tunnel is not committed.
	t.hub.committed.Store(false)
	t.hub.armedAt.Store(0)
	t.hub.authed.Store(false)
	t.hub.clearMarketCache()
	t.markUncommitted()
	t.rearms.Store(0)
	t.lastBarrier.Store(time.Now().UnixNano()) // the dial's own sendLatest follows: no duplicate re-arm
	t.cur.Store(sess)
	t.mu.Unlock()
	go func() {
		_ = sess.ServeLoop()
		l.accountTunnelDown(t, sess)
	}()
	t.sendLatest()
}

// accountTunnelDown moves the tabs of a lost tunnel back to the guest source until it is dialled again.
func (l *brokerLink) accountTunnelDown(t *accountTunnel, sess *rtx5tcp.MuxSession) {
	if !t.cur.CompareAndSwap(sess, nil) {
		return
	}
	t.hub.committed.Store(false)
	t.hub.armedAt.Store(0)
	t.hub.authed.Store(false)
	t.markUncommitted()
	l.reconcileTunnel(t)
}

// keepAccountTunnelsWarm re-dials downed tunnels (re-sending their latest 0x3B), pings live ones like the
// guest tunnel and re-creates tunnels closed under a live claim (with backoff). Called from keepLinkWarm
// every few seconds; never blocks on the network.
func (l *brokerLink) keepAccountTunnelsWarm() {
	l.acctMu.RLock()
	list := make([]*accountTunnel, 0, len(l.acct))
	for _, t := range l.acct {
		list = append(list, t)
	}
	l.acctMu.RUnlock()
	now := time.Now()
	for _, t := range list {
		if !t.live() {
			l.ensureAccountTunnel(t)
			continue
		}
		if !t.hub.committed.Load() && time.Since(time.Unix(0, t.lastBarrier.Load())) >= t.rearmDelay() {
			// Backs off 3 -> 6 -> 12 -> 30 -> 60 s while re-arms do not commit; a commit resets it.
			t.lastBarrier.Store(time.Now().UnixNano())
			t.rearms.Add(1)
			go t.resend()
			continue
		}
		if t.renewDue(now) {
			t.lastRenew.Store(now.UnixNano())
			go t.renewSub()
		}
		if t.pinging.CompareAndSwap(false, true) {
			go func(t *accountTunnel) {
				defer t.pinging.Store(false)
				if s := t.cur.Load(); s != nil {
					_, _ = pingOrClose(s, tunnelLivenessPingTimeout)
				}
			}(t)
		}
	}
	l.recreateClaimedTunnels(now)
}

// recreateClaimedTunnels re-creates the tunnel of every tab whose claim is set but whose tunnel was closed
// (pruned, evicted), without needing a new POST: first attempt accountRetryMin after it is seen missing, then
// doubling up to accountRetryMax. The backoff is forgotten once the tunnel exists again.
func (l *brokerLink) recreateClaimedTunnels(now time.Time) {
	type want struct {
		clientKey, ip string
		key           accountKey
		payload       []byte
	}
	var wants []want
	l.srcMu.Lock()
	seen := make(map[accountKey]bool)
	for s := range l.allSubs {
		if s.claimLogin == 0 || seen[s.acctKey] {
			continue
		}
		seen[s.acctKey] = true
		b, ok := l.bindings[s.clientKey]
		if !ok || b.key != s.acctKey || len(b.payload) == 0 {
			continue
		}
		if tn := l.lookupAcct(s.acctKey); tn != nil {
			if tn.everCommitted.Load() {
				delete(l.retry, s.acctKey) // the backoff is forgotten only once the tunnel has committed
			}
			continue
		}
		st, ok := l.retry[s.acctKey]
		if !ok {
			if l.retry == nil {
				l.retry = make(map[accountKey]retryState)
			}
			l.retry[s.acctKey] = retryState{next: now.Add(accountRetryMin), delay: accountRetryMin}
			continue
		}
		if now.Before(st.next) {
			continue
		}
		st.delay = min(2*st.delay, accountRetryMax)
		st.next = now.Add(st.delay)
		l.retry[s.acctKey] = st
		wants = append(wants, want{s.clientKey, b.ip, s.acctKey, b.payload})
	}
	for k := range l.retry {
		if !seen[k] {
			delete(l.retry, k)
		}
	}
	l.srcMu.Unlock()
	for _, w := range wants {
		l.setAccountSub(w.clientKey, w.ip, w.key, w.payload)
	}
}

// pruneBindings forgets the subscriptions of sessions that have had no stream for sessionBindingIdleTTL.
func (l *brokerLink) pruneBindings(now time.Time) {
	l.srcMu.Lock()
	defer l.srcMu.Unlock()
	if len(l.bindings) == 0 {
		return
	}
	live := make(map[string]bool, len(l.allSubs))
	for s := range l.allSubs {
		live[s.clientKey] = true
	}
	for k, b := range l.bindings {
		if !live[k] && now.Sub(b.seen) > sessionBindingIdleTTL {
			delete(l.bindings, k)
		}
	}
}

// inUseLocked reports which tunnel keys and hubs a tab still relies on. Caller holds srcMu.
func (l *brokerLink) inUseLocked() (map[accountKey]bool, map[*webBinaryMarketHub]bool) {
	keys := make(map[accountKey]bool)
	hubs := make(map[*webBinaryMarketHub]bool)
	for s := range l.allSubs {
		if s.claimLogin != 0 {
			keys[s.acctKey] = true
		}
		if h := s.src.Load(); h != nil && h.acctOwner != nil {
			hubs[h] = true
		}
	}
	return keys, hubs
}

// dropTunnelsLocked detaches the (already unlisted) tunnels and moves tabs still on them to the guest source.
// It returns the sessions to close once srcMu is released. Caller holds srcMu.
func (l *brokerLink) dropTunnelsLocked(list []*accountTunnel) []*rtx5tcp.MuxSession {
	sessions := make([]*rtx5tcp.MuxSession, 0, len(list))
	for _, t := range list {
		sessions = append(sessions, t.detach())
	}
	for _, t := range list {
		l.reconcileTunnelLocked(t)
	}
	return sessions
}

func (l *brokerLink) dropTunnels(list []*accountTunnel) {
	l.srcMu.Lock()
	sessions := l.dropTunnelsLocked(list)
	l.srcMu.Unlock()
	closeSessions(sessions)
}

// pruneAccountTunnels closes tunnels no tab uses that saw no 0x3B for accountTunnelIdleTimeout, and tunnels
// that were never committed within accountTunnelCommitTimeout of their creation, and tunnels uncommitted for
// more than accountTunnelStuckTimeout without an authenticating 0x3A (expired / revoked token). Holding srcMu keeps a tab
// from binding while the decision is made.
func (l *brokerLink) pruneAccountTunnels(now time.Time) {
	l.acctMu.RLock()
	n := len(l.acct)
	l.acctMu.RUnlock()
	if n == 0 {
		return
	}
	l.srcMu.Lock()
	keys, hubs := l.inUseLocked()
	var closing []*accountTunnel
	l.acctMu.Lock()
	for key, t := range l.acct {
		inUse := keys[key] || hubs[t.hub]
		if inUse {
			t.touch()
		}
		neverCommitted := !t.everCommitted.Load() && !t.hub.committed.Load() && now.Sub(time.Unix(0, t.born.Load())) > accountTunnelCommitTimeout
		idle := !inUse && now.Sub(time.Unix(0, t.lastActive.Load())) > accountTunnelIdleTimeout
		stuck := false
		if since := t.uncommittedSince.Load(); since != 0 && !t.hub.committed.Load() && !t.hub.authed.Load() {
			stuck = now.Sub(time.Unix(0, since)) > accountTunnelStuckTimeout
		}
		if neverCommitted || idle || stuck {
			delete(l.acct, key)
			closing = append(closing, t)
		}
	}
	l.acctMu.Unlock()
	sessions := l.dropTunnelsLocked(closing)
	l.srcMu.Unlock()
	closeSessions(sessions)
}

// releaseUnusedOwnedLocked drops the tunnels this browser session made for an earlier subscription once no tab
// uses them any more (it switched account). Caller holds srcMu.
func (l *brokerLink) releaseUnusedOwnedLocked(clientKey string, keep accountKey) []*rtx5tcp.MuxSession {
	l.acctMu.RLock()
	owns := false
	for k, t := range l.acct {
		if t.creator == clientKey && k != keep {
			owns = true
			break
		}
	}
	l.acctMu.RUnlock()
	if !owns {
		return nil
	}
	keys, hubs := l.inUseLocked()
	var drop []*accountTunnel
	l.acctMu.Lock()
	for k, t := range l.acct {
		if t.creator == clientKey && k != keep && !keys[k] && !hubs[t.hub] {
			delete(l.acct, k)
			drop = append(drop, t)
		}
	}
	l.acctMu.Unlock()
	return l.dropTunnelsLocked(drop)
}

// releaseSupersededLocked closes tunnel t right away when no tab uses it any more because the tab that was on
// it moved to another key (token rotation / account switch). Caller holds srcMu.
func (l *brokerLink) releaseSupersededLocked(t *accountTunnel) {
	for s := range l.allSubs {
		if s.src.Load() == t.hub || (s.claimLogin != 0 && s.acctKey == t.key) {
			return
		}
	}
	l.acctMu.Lock()
	if l.acct[t.key] != t {
		l.acctMu.Unlock()
		return
	}
	delete(l.acct, t.key)
	l.acctMu.Unlock()
	sess := t.detach()
	go closeSessions([]*rtx5tcp.MuxSession{sess})
}

// closeAccountTunnels closes every account tunnel (the link keeps working and may dial new ones).
func (l *brokerLink) closeAccountTunnels() {
	l.acctMu.Lock()
	list := make([]*accountTunnel, 0, len(l.acct))
	for _, t := range l.acct {
		list = append(list, t)
	}
	l.acct = nil
	l.acctMu.Unlock()
	if len(list) > 0 {
		l.dropTunnels(list) // also moves the tabs that sat on those hubs onto the guest source
	}
}

// retire closes everything and stops the link from making new account tunnels: nothing prunes the tunnels of
// a link that left the link map.
func (l *brokerLink) retire() {
	l.acctMu.Lock()
	l.acctClosed = true
	l.acctMu.Unlock()
	l.closeAll()
}

// deliverTradeAll delivers a 0x3A event to every tab of the link whatever hub it is on. Under srcMu.RLock, so
// a source switch cannot interleave with it.
func (l *brokerLink) deliverTradeAll(pkt []byte, eventLogin int64, sum uint64, now int64) {
	l.srcMu.RLock()
	for s := range l.allSubs {
		s.deliverTradeEvent(pkt, eventLogin, sum, now)
	}
	l.srcMu.RUnlock()
}

// resolveLocked returns the hub the tab should take market frames from and its effective login.
// Caller holds srcMu.
func (l *brokerLink) resolveLocked(s *webBinaryStreamSub) (*webBinaryMarketHub, int64) {
	claim := s.claimLogin
	if claim == 0 {
		return l.binHub, 0
	}
	own := l.lookupAcct(s.acctKey)
	src := l.binHub
	if own != nil && own.usable() {
		src = own.hub
	} else if cur := s.src.Load(); cur != nil && cur.acctOwner != nil && cur.acctOwner.key.role == s.acctKey.role &&
		cur.acctOwner.login == s.acctKey.login && cur.acctOwner.usable() {
		src = cur // token rotation: stay on the committed tunnel until the new one commits
	}
	eff := int64(0)
	if s.verified || (own != nil && own.live() && own.hub.authed.Load()) || (src != l.binHub && src.authed.Load()) {
		eff = claim
	}
	return src, eff
}

type hubSnapshot struct {
	ticks  []rtx5tcp.BinaryTick
	depths []rtx5tcp.BinaryDepth
	ver    uint64
}

// copySnapshotLocked copies the hub's latest ticks and depth. Caller holds h.mu (read or write).
func (h *webBinaryMarketHub) copySnapshotLocked() hubSnapshot {
	sn := hubSnapshot{
		ticks:  make([]rtx5tcp.BinaryTick, 0, len(h.latestTicks)),
		depths: make([]rtx5tcp.BinaryDepth, 0, len(h.latestDepth)),
		ver:    h.ver,
	}
	for _, bt := range h.latestTicks {
		sn.ticks = append(sn.ticks, bt)
	}
	for _, bd := range h.latestDepth {
		sn.depths = append(sn.depths, bd)
	}
	return sn
}

func (sn hubSnapshot) encode() [][]byte {
	var pkts [][]byte
	const chunk = 64
	for start := 0; start < len(sn.ticks); start += chunk {
		end := min(start+chunk, len(sn.ticks))
		if pkt := wrapWebBinaryFrame(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.EncodeBinaryTickBatch(sn.ticks[start:end])); len(pkt) > 0 {
			pkts = append(pkts, pkt)
		}
	}
	const depthChunk = 32
	for start := 0; start < len(sn.depths); start += depthChunk {
		end := min(start+depthChunk, len(sn.depths))
		if pkt := wrapWebBinaryFrame(rtx5tcp.FrameBinaryDepthBatch, rtx5tcp.EncodeBinaryDepthBatch(sn.depths[start:end])); len(pkt) > 0 {
			pkts = append(pkts, pkt)
		}
	}
	return pkts
}

// snapshotPackets returns the encoded snapshot and the hub version it was taken at. The encoding is cached
// per hub version and shared (read-only) by every tab moved onto the hub; nothing is encoded under a lock.
func (h *webBinaryMarketHub) snapshotPackets() ([][]byte, uint64) {
	h.mu.RLock()
	if h.snapOK && h.snapVer == h.ver {
		p, v := h.snapPkts, h.ver
		h.mu.RUnlock()
		return p, v
	}
	sn := h.copySnapshotLocked()
	h.mu.RUnlock()
	pkts := sn.encode()
	h.mu.Lock()
	if h.ver == sn.ver {
		h.snapPkts, h.snapVer, h.snapOK = pkts, sn.ver, true
	}
	h.mu.Unlock()
	return pkts, sn.ver
}

// moveSubLocked switches the tab's market source to `to`: it leaves the old hub, drops the old source's
// ticks/depth still queued for it (queued 0x22 candle frames are kept: the hub caches no candles, so they
// would be lost), then joins the new hub with that hub's latest ticks/depth queued first. The snapshot is
// encoded outside any hub lock (and shared per hub version); if the cache changed meanwhile (hub.ver) it is
// retried, and after three tries encoded under the write lock. Only the enqueue and the subs insertion happen
// under the destination's write lock, which is what orders the snapshot before the live frames.
// Caller holds srcMu.
func (l *brokerLink) moveSubLocked(s *webBinaryStreamSub, to *webBinaryMarketHub) {
	from := s.src.Load()
	if from == to || s.closed.Load() {
		return
	}
	if from != nil {
		from.mu.Lock()
		delete(from.subs, s)
		from.mu.Unlock()
	}
	var keep [][]byte
drain:
	for {
		select {
		case pkt := <-s.ch:
			if len(pkt) > 0 && pkt[0] == rtx5tcp.FrameBinaryCandleBatch {
				keep = append(keep, pkt)
			}
		default:
			break drain
		}
	}
	for _, pkt := range keep {
		select {
		case s.ch <- pkt:
		default:
			webStreamMarketFramesDropped.Add(1)
			s.needResync.Store(true)
		}
	}
	for attempt := 0; ; attempt++ {
		var pkts [][]byte
		var ver uint64
		if attempt < 3 {
			pkts, ver = to.snapshotPackets()
		}
		to.mu.Lock()
		if attempt < 3 && to.ver != ver {
			to.mu.Unlock()
			continue
		}
		if attempt >= 3 {
			pkts = to.copySnapshotLocked().encode()
		}
		for _, pkt := range pkts {
			select {
			case s.ch <- pkt:
			default:
				webStreamMarketFramesDropped.Add(1)
				s.needResync.Store(true)
			}
		}
		to.subs[s] = struct{}{}
		s.src.Store(to)
		to.mu.Unlock()
		return
	}
}

func (l *brokerLink) reconcileSubLocked(s *webBinaryStreamSub) {
	if s.closed.Load() {
		return
	}
	from := s.src.Load()
	to, eff := l.resolveLocked(s)
	s.accountLogin.Store(eff)
	l.moveSubLocked(s, to)
	// The tab left a tunnel of another key (rotation / account switch): release it as soon as nothing uses it.
	if from != nil && from != to && from.acctOwner != nil && s.claimLogin != 0 && from.acctOwner.key != s.acctKey {
		l.releaseSupersededLocked(from.acctOwner)
	}
}

// reconcileTunnelLocked re-evaluates every tab that uses tunnel t. Caller holds srcMu.
func (l *brokerLink) reconcileTunnelLocked(t *accountTunnel) {
	for s := range l.allSubs {
		if (s.claimLogin != 0 && s.acctKey == t.key) || s.src.Load() == t.hub {
			l.reconcileSubLocked(s)
		}
	}
}

// reconcileTunnel is called when a tunnel committed, was proven by a 0x3A, was uncommitted or went down.
func (l *brokerLink) reconcileTunnel(t *accountTunnel) {
	l.srcMu.Lock()
	defer l.srcMu.Unlock()
	l.reconcileTunnelLocked(t)
}

// bindClientAccount records what the browser session subscribed with (claim 0 = logged out, -1 = wildcard,
// otherwise a login) and re-evaluates its streams.
func (l *brokerLink) bindClientAccount(clientKey string, claim int64, key accountKey, verified bool, payload []byte, ip string) {
	l.srcMu.Lock()
	if l.bindings == nil {
		l.bindings = make(map[string]sessionAcct)
	}
	if claim == 0 {
		delete(l.bindings, clientKey)
	} else {
		l.bindings[clientKey] = sessionAcct{login: claim, key: key, verified: verified, payload: payload, ip: ip, seen: time.Now()}
	}
	for s := range l.allSubs {
		if s.clientKey == clientKey {
			s.claimLogin, s.acctKey, s.verified = claim, key, verified
			l.reconcileSubLocked(s)
		}
	}
	sessions := l.releaseUnusedOwnedLocked(clientKey, key)
	l.srcMu.Unlock()
	closeSessions(sessions)
}

// attachSub registers a new stream and returns the source it starts on with that source's snapshot.
func (l *brokerLink) attachSub(s *webBinaryStreamSub) (ticks []rtx5tcp.BinaryTick, depths []rtx5tcp.BinaryDepth) {
	l.srcMu.Lock()
	defer l.srcMu.Unlock()
	if b, ok := l.bindings[s.clientKey]; ok {
		s.claimLogin, s.acctKey, s.verified = b.login, b.key, b.verified
		b.seen = time.Now()
		l.bindings[s.clientKey] = b
	}
	if l.allSubs == nil {
		l.allSubs = make(map[*webBinaryStreamSub]struct{})
	}
	l.allSubs[s] = struct{}{}
	src, eff := l.resolveLocked(s)
	s.accountLogin.Store(eff)
	src.mu.Lock()
	sn := src.copySnapshotLocked()
	src.subs[s] = struct{}{}
	s.src.Store(src)
	src.mu.Unlock()
	return sn.ticks, sn.depths
}

func (l *brokerLink) detachSub(s *webBinaryStreamSub) {
	l.srcMu.Lock()
	defer l.srcMu.Unlock()
	s.closed.Store(true)
	if src := s.src.Load(); src != nil {
		src.mu.Lock()
		delete(src.subs, s)
		src.mu.Unlock()
	}
	delete(l.allSubs, s)
	if b, ok := l.bindings[s.clientKey]; ok {
		b.seen = time.Now() // the binding now only lives sessionBindingIdleTTL (pruneBindings)
		l.bindings[s.clientKey] = b
	}
}
