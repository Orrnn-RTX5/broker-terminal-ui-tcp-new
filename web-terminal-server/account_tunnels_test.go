package main

import (
	"encoding/binary"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

// fakeBroker is a local stand-in for the :4443 access server: it accepts trader tunnels, records every
// 0x3B a tunnel receives and lets a test push ticks / trade events down a chosen tunnel.
type fakeBroker struct {
	addr  string
	ln    net.Listener
	greet atomic.Pointer[string] // when set, every new tunnel gets a tick of this symbol before anything else (guest snapshot on connect)

	mu    sync.Mutex
	conns []*fakeConn
}

type fakeConn struct {
	sess   *rtx5tcp.MuxSession
	role   uint8
	login  atomic.Int64 // login of the last 0x3B (-999 = none yet)
	subs   atomic.Int64 // number of 0x3B received
	mu     sync.Mutex
	tokens []string
}

func (c *fakeConn) lastToken() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.tokens) == 0 {
		return ""
	}
	return c.tokens[len(c.tokens)-1]
}

func startFakeBroker(t *testing.T) *fakeBroker {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fb := &fakeBroker{ln: ln, addr: ln.Addr().String()}
	go func() {
		for {
			raw, err := ln.Accept()
			if err != nil {
				return
			}
			go func(raw net.Conn) {
				tc, err := rtx5tcp.AcceptTunnel(raw, 5*time.Second)
				if err != nil {
					return
				}
				fc := &fakeConn{role: tc.PeerRole()}
				fc.login.Store(-999)
				sess := rtx5tcp.NewMuxSession(tc, true, nil, func(_ *rtx5tcp.MuxSession, ft uint8, _ uint32, _ uint8, payload []byte) {
					if ft != rtx5tcp.FrameBinaryAccountSub {
						return
					}
					sub, err := rtx5tcp.DecodeBinaryAccountSub(payload)
					if err != nil {
						return
					}
					fc.mu.Lock()
					fc.tokens = append(fc.tokens, sub.AuthToken)
					fc.mu.Unlock()
					fc.login.Store(sub.AccountLogin)
					fc.subs.Add(1)
				})
				fc.sess = sess
				fb.mu.Lock()
				fb.conns = append(fb.conns, fc)
				fb.mu.Unlock()
				if g := fb.greet.Load(); g != nil {
					_ = sess.SendControl(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.FlagFIN,
						rtx5tcp.EncodeBinaryTickBatch([]rtx5tcp.BinaryTick{{Symbol: *g, Bid: 1, Ask: 2, TimestampMs: time.Now().UnixMilli()}}))
				}
				_ = sess.ServeLoop()
			}(raw)
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		fb.mu.Lock()
		defer fb.mu.Unlock()
		for _, c := range fb.conns {
			_ = c.sess.Close()
		}
	})
	return fb
}

func (fb *fakeBroker) connCount() int {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	return len(fb.conns)
}

func (fb *fakeBroker) conn(i int) *fakeConn {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	if i >= len(fb.conns) {
		return nil
	}
	return fb.conns[i]
}

// connFor waits for a live tunnel whose last 0x3B was for login.
func (fb *fakeBroker) connFor(t *testing.T, login int64) *fakeConn {
	t.Helper()
	return fb.connForRole(t, rtx5tcp.RoleTraderTerminalClient, login)
}

func (fb *fakeBroker) connForRole(t *testing.T, role uint8, login int64) *fakeConn {
	t.Helper()
	var found *fakeConn
	waitFor(t, "tunnel subscribed for login", func() bool {
		fb.mu.Lock()
		defer fb.mu.Unlock()
		for _, c := range fb.conns {
			if c.role == role && c.login.Load() == login && liveSession(c.sess) {
				found = c
				return true
			}
		}
		return false
	})
	return found
}

func pushTick(t *testing.T, c *fakeConn, symbol string) {
	t.Helper()
	payload := rtx5tcp.EncodeBinaryTickBatch([]rtx5tcp.BinaryTick{{Symbol: symbol, Bid: 1.1, Ask: 1.2, TimestampMs: time.Now().UnixMilli()}})
	if err := c.sess.SendControl(rtx5tcp.FrameBinaryTickBatch, rtx5tcp.FlagFIN, payload); err != nil {
		t.Fatalf("push tick %s: %v", symbol, err)
	}
}

func tradeEventPayload(login int64, marker byte) []byte {
	p := make([]byte, 22)
	p[0] = rtx5tcp.BinaryTradeEventVersion
	p[1] = rtx5tcp.BinaryTradeEventPositions
	binary.LittleEndian.PutUint64(p[2:10], uint64(login))
	p[21] = marker
	return p
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type acctEnv struct {
	ip   string // remote address the POSTs come from
	srv  *WebTerminalServer
	link *brokerLink
	fb   *fakeBroker
}

func newAcctEnv(t *testing.T) *acctEnv {
	t.Helper()
	// Keep the 0x3B handler's gateway verification off any real :8190.
	prev := rtx5tcp.GetDefaultBinaryOrderGatewayAddr()
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().String()
	_ = ln.Close()
	rtx5tcp.SetDefaultBinaryOrderGatewayAddr(dead)
	t.Cleanup(func() { rtx5tcp.SetDefaultBinaryOrderGatewayAddr(prev) })

	fb := startFakeBroker(t)
	srv := &WebTerminalServer{sessionTokens: make(map[string]string)}
	l := srv.setDefaultBroker("fakebroker", "fakebroker", fb.addr)
	if l == nil {
		t.Fatal("no link")
	}
	t.Cleanup(l.closeAll)
	if _, err := l.getOrDialSession(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "guest tunnel accepted", func() bool { return fb.connCount() == 1 })
	return &acctEnv{ip: "192.0.2.1:4000", srv: srv, link: l, fb: fb}
}

func (e *acctEnv) newSub(key, _ string) *webBinaryStreamSub {
	s := &webBinaryStreamSub{
		clientKey: key,
		prioCh:    make(chan []byte, 512),
		ch:        make(chan []byte, 2048),
	}
	e.link.attachSub(s)
	return s
}

func (e *acctEnv) postSub(t *testing.T, key, appKind string, login int64, token string) {
	t.Helper()
	body := rtx5tcp.EncodeBinaryAccountSub(rtx5tcp.BinaryAccountSub{AccountLogin: login, AuthToken: token})
	req := httptest.NewRequest(http.MethodPost, "/__rtx5_binary_account_sub?__app="+appKind, strings.NewReader(string(body)))
	req.AddCookie(&http.Cookie{Name: "rtx5_wt_sid", Value: key})
	req.RemoteAddr = e.ip
	rec := httptest.NewRecorder()
	e.srv.serveBinaryAccountSub(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("account sub POST = %d", rec.Code)
	}
}

func tickSymbols(pkt []byte) []string {
	if len(pkt) < 4 || pkt[0] != rtx5tcp.FrameBinaryTickBatch {
		return nil
	}
	ticks, err := rtx5tcp.DecodeBinaryTickBatch(pkt[4:])
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(ticks))
	for _, tk := range ticks {
		out = append(out, tk.Symbol)
	}
	return out
}

// collect drains the tab's market queue for d and returns every tick symbol seen, in order.
func collect(s *webBinaryStreamSub, d time.Duration) []string {
	var out []string
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case pkt := <-s.ch:
			out = append(out, tickSymbols(pkt)...)
		case <-timer.C:
			return out
		}
	}
}

func waitSymbol(t *testing.T, s *webBinaryStreamSub, sym string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case pkt := <-s.ch:
			for _, x := range tickSymbols(pkt) {
				if x == sym {
					return
				}
			}
		case <-deadline:
			t.Fatalf("tab never received %s", sym)
		}
	}
}

func contains(list []string, sym string) bool {
	for _, x := range list {
		if x == sym {
			return true
		}
	}
	return false
}

func pushEvent(t *testing.T, c *fakeConn, payload []byte) {
	t.Helper()
	if err := c.sess.SendControl(rtx5tcp.FrameBinaryTradeEvent, rtx5tcp.FlagFIN, payload); err != nil {
		t.Fatalf("push event: %v", err)
	}
}

func (e *acctEnv) tun(appKind string, login int64, token string) *accountTunnel {
	return e.link.lookupAcct(makeAccountKey(roleForAppKind(appKind), login, token))
}

// loginTab subscribes the tab and waits until it sits on its own tunnel (a market tick moved it there).
func (e *acctEnv) loginAs(t *testing.T, s *webBinaryStreamSub, appKind string, login int64, token, accSym string) *fakeConn {
	t.Helper()
	e.postSub(t, s.clientKey, appKind, login, token)
	c := e.fb.connForRole(t, roleForAppKind(appKind), login)
	waitFor(t, "account tunnel up", func() bool {
		tn := e.tun(appKind, login, token)
		return tn != nil && tn.live()
	})
	waitFor(t, "tab moved to its tunnel source", func() bool {
		pushTick(t, c, accSym) // frames before the barrier are dropped, so keep feeding until one counts
		return s.src.Load() == e.tun(appKind, login, token).hub
	})
	return c
}

func (e *acctEnv) loginTab(t *testing.T, s *webBinaryStreamSub, login int64, token, accSym string) *fakeConn {
	return e.loginAs(t, s, "terminal", login, token, accSym)
}

func (s *webBinaryStreamSub) effLogin() int64 { return s.accountLogin.Load() }

// commit feeds the tunnel ticks until it is committed.
func (e *acctEnv) commit(t *testing.T, c *fakeConn, appKind string, login int64, token string) {
	t.Helper()
	waitFor(t, "tunnel committed", func() bool {
		pushTick(t, c, "COMMIT")
		tn := e.tun(appKind, login, token)
		return tn != nil && tn.hub.committed.Load()
	})
}
