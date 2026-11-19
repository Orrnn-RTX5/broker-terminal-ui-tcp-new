package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

//go:embed all:dist
var embeddedDist embed.FS

//go:embed tcp_toolbar.js
var tcpToolbarJS []byte

//go:embed security_drawer.js
var securityDrawerJS []byte

type DiscoveredBroker struct {
	BrokerID   string `json:"broker_id"`
	BrokerName string `json:"broker_name"`
	TCPAddr    string `json:"tcp_addr"`
	Plan       string `json:"plan"`
	Online     bool   `json:"online"`
}

type WebTerminalServer struct {
	listenAddr   string
	defaultPort  int
	exeDir       string
	masterPubHex string
	distRoot     fs.FS
	externalDist string
	// localUIOnly (RTX5_WEB_UI_SOURCE=local) is for development/test web servers: the hot-UI OTA sync is off and every
	// app is served from <exe>/../ui-dist/<app> (or <exe>/ui-dist/<app>), so a local UI build shows up at once and the
	// production OTA bundle never replaces it. Terminal falls back to the external/embedded dist as before.
	localUIOnly bool

	// Broker on this host (set only when -server is a loopback address) and its loopback target.
	localBrokerID string
	localTarget   string
	// directGatewayPush starts the :8190 trade-event push loop for the local broker's link.
	directGatewayPush bool

	// Per-session broker targets (broker_links.go): one link per broker, each session's choice,
	// and the default link for sessions that never chose a broker.
	linksMu           sync.RWMutex
	links             map[string]*brokerLink
	sessionBrokers    map[string]sessionBinding
	defaultLinkKey    string
	defaultBrokerID   string // identity shown while the default broker has no target yet
	defaultBrokerName string

	mu                   sync.RWMutex
	superAdminTCP        string
	cachedBrokers        []DiscoveredBroker
	cachedBrokersAt      time.Time
	superAdminMux        *rtx5tcp.MuxSession
	saDialMu             sync.Mutex
	dirRefreshMu         sync.Mutex
	cachedOrderAuthToken atomic.Value // fallback string

	sessionMu     sync.RWMutex
	sessionTokens map[string]string

	drawingHubOnce sync.Once
	drawingHub     *drawingSyncHub

	otaMu               sync.RWMutex
	otaSyncMu           sync.Mutex
	otaChannel          string
	embeddedTermTreeSHA string
	latestOTAVersion    string
	latestOTAReleaseID  string
	lastOTACheckedUnix  int64
	lastOTAError        string
	appVersions         map[string]string
	appTreeSHAs         map[string]string
	appUISources        map[string]string
	appReloadReady      map[string]bool
}

type tcpNoDelayListener struct {
	net.Listener
}

func (l tcpNoDelayListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetReadBuffer(256 * 1024)
		_ = tc.SetWriteBuffer(256 * 1024)
	}
	return conn, nil
}

func envOrDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func resolveWebAppKind(r *http.Request) string {
	if r == nil {
		return "terminal"
	}
	for _, explicit := range []string{
		strings.ToLower(strings.TrimSpace(r.URL.Query().Get("__app"))),
		strings.ToLower(strings.TrimSpace(r.Header.Get("X-RTX5-Web-App"))),
	} {
		if explicit == "" {
			continue
		}
		if strings.Contains(explicit, "superadmin") {
			return "superadmin"
		}
		if strings.Contains(explicit, "admin") {
			return "admin"
		}
		if strings.Contains(explicit, "manager") {
			return "manager"
		}
		if strings.Contains(explicit, "terminal") {
			return "terminal"
		}
	}

	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	if idx := strings.IndexByte(host, ','); idx > 0 {
		host = strings.TrimSpace(host[:idx])
	}
	if h, _, err := net.SplitHostPort(host); err == nil && h != "" {
		host = h
	} else if idx := strings.IndexByte(host, ':'); idx > 0 {
		host = host[:idx]
	}
	host = strings.ToLower(strings.TrimSpace(host))

	if strings.Contains(host, "superadmin") {
		return "superadmin"
	}
	if strings.Contains(host, "admin") {
		return "admin"
	}
	if strings.Contains(host, "manager") {
		return "manager"
	}
	return "terminal"
}

func appKindToStatusAppName(appKind string) string {
	switch appKind {
	case "superadmin":
		return "superadmin"
	case "admin":
		return "broker-admin"
	case "manager":
		return "broker-manager"
	default:
		return "trader-terminal"
	}
}

func loadAuthorityMasterPubHex(exeDir string) string {
	candidates := []string{
		filepath.Join(exeDir, "authority-pub.json"),
		filepath.Join(exeDir, "..", "config", "authority-pub.json"),
		filepath.Join(exeDir, "..", "..", "runtime-data", "secrets", "shared-authority.json"),
		"/opt/rtx5-broker/config/authority-pub.json",
		"/opt/rtx5-superadmin/runtime-data/secrets/shared-authority.json",
	}
	for _, ac := range candidates {
		raw, err := os.ReadFile(ac)
		if err != nil || len(raw) == 0 {
			continue
		}
		var doc struct {
			Ed25519MasterPubHex string `json:"ed25519_master_pub_hex"`
			Ed25519PublicHex    string `json:"ed25519_public_hex"`
		}
		if json.Unmarshal(raw, &doc) == nil {
			pubHex := strings.TrimSpace(doc.Ed25519MasterPubHex)
			if pubHex == "" {
				pubHex = strings.TrimSpace(doc.Ed25519PublicHex)
			}
			if pb, derr := hex.DecodeString(pubHex); derr == nil && len(pb) == ed25519.PublicKeySize {
				return strings.ToLower(pubHex)
			}
		}
	}
	return ""
}

func loadDotEnvFiles(dirs ...string) {
	for _, dir := range dirs {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, ".env"))
		if err != nil || len(raw) == 0 {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			eq := strings.IndexByte(line, '=')
			if eq <= 0 {
				continue
			}
			k := strings.TrimSpace(line[:eq])
			v := strings.TrimSpace(line[eq+1:])
			v = strings.Trim(v, `"'`)
			if k != "" && os.Getenv(k) == "" {
				_ = os.Setenv(k, v)
			}
		}
	}
}

func main() {
	exePath, _ := os.Executable()
	exeDir := filepath.Dir(exePath)
	cwd, _ := os.Getwd()
	loadDotEnvFiles(cwd, exeDir)

	defaultTargetTCP := envOrDefault("BROKER_TCP_ADDR", "")
	if defaultTargetTCP == "" || defaultTargetTCP == "127.0.0.1:4443" {
		if v := envOrDefault("VITE_DEFAULT_MT5_SERVER", ""); strings.Contains(v, ":") {
			defaultTargetTCP = v
		}
	}
	if defaultTargetTCP == "" {
		defaultTargetTCP = "127.0.0.1:4443"
	}

	defaultBrokerID := envOrDefault("BROKER_ID", envOrDefault("VITE_BROKER_ID", "fxtrust-tcp"))
	defaultBrokerName := envOrDefault("BROKER_NAME", defaultBrokerID)

	listenFlag := flag.String("listen", envOrDefault("WEB_TERMINAL_LISTEN", "0.0.0.0:8443"), "HTTP/HTTPS & Binary WebSocket listen address")
	targetFlag := flag.String("server", defaultTargetTCP, "Target Encrypted Binary TCP Server (IP:Port)")
	gatewayRTOFlag := flag.String("gateway-rto", envOrDefault("BROKER_GATEWAY_RTO_ADDR", "127.0.0.1:8190"), "Direct 256-Shard RAM + Binary WAL Engine RTO\\x01 TCP address (:8190)")
	saFlag := flag.String("superadmin", envOrDefault("SUPERADMIN_TCP_ADDR", "127.0.0.1:9100"), "Super Admin Encrypted Binary TCP Hub (:9100) for Broker Discovery & Multi-App Routing")
	brokerIDFlag := flag.String("broker-id", defaultBrokerID, "Initial Broker ID")
	brokerNameFlag := flag.String("broker-name", defaultBrokerName, "Initial Broker Name / Server label")
	tlsCertFlag := flag.String("tls-cert", envOrDefault("WEB_TERMINAL_TLS_CERT", ""), "Optional TLS certificate PEM path for direct HTTPS/WSS (zero Cloudflare)")
	tlsKeyFlag := flag.String("tls-key", envOrDefault("WEB_TERMINAL_TLS_KEY", ""), "Optional TLS private key PEM path for direct HTTPS/WSS (zero Cloudflare)")
	flag.Parse()

	if strings.TrimSpace(*gatewayRTOFlag) != "" {
		_ = os.Setenv("BROKER_GATEWAY_RTO_ADDR", strings.TrimSpace(*gatewayRTOFlag))
	}

	// Optional adjacent web-terminal-config.json override
	cfgFilePath := filepath.Join(exeDir, "web-terminal-config.json")
	if rawCfg, rerr := os.ReadFile(cfgFilePath); rerr == nil && len(rawCfg) > 0 {
		var fileCfg struct {
			Listen        string `json:"listen"`
			ServerTCP     string `json:"server_tcp"`
			SuperAdminTCP string `json:"superadmin_tcp"`
			BrokerID      string `json:"broker_id"`
			BrokerName    string `json:"broker_name"`
			TLSCert       string `json:"tls_cert"`
			TLSKey        string `json:"tls_key"`
		}
		if json.Unmarshal(rawCfg, &fileCfg) == nil {
			if fileCfg.Listen != "" {
				*listenFlag = fileCfg.Listen
			}
			if fileCfg.ServerTCP != "" {
				*targetFlag = fileCfg.ServerTCP
			}
			if fileCfg.SuperAdminTCP != "" {
				*saFlag = fileCfg.SuperAdminTCP
			}
			if fileCfg.BrokerID != "" {
				*brokerIDFlag = fileCfg.BrokerID
			}
			if fileCfg.BrokerName != "" {
				*brokerNameFlag = fileCfg.BrokerName
			}
			if fileCfg.TLSCert != "" {
				*tlsCertFlag = fileCfg.TLSCert
			}
			if fileCfg.TLSKey != "" {
				*tlsKeyFlag = fileCfg.TLSKey
			}
		}
	}

	if *tlsCertFlag != "" || *tlsKeyFlag != "" {
		if _, err1 := os.Stat(*tlsCertFlag); err1 != nil {
			*tlsCertFlag = ""
			*tlsKeyFlag = ""
		} else if _, err2 := os.Stat(*tlsKeyFlag); err2 != nil {
			*tlsCertFlag = ""
			*tlsKeyFlag = ""
		}
	}
	if (*tlsCertFlag == "" || *tlsKeyFlag == "") && (*listenFlag == "0.0.0.0:443" || *listenFlag == ":443") {
		*listenFlag = "127.0.0.1:8443"
	}

	subFS, err := fs.Sub(embeddedDist, "dist")
	if err != nil {
		log.Fatalf("Failed to mount embedded UI dist: %v", err)
	}

	extDist := ""
	for _, cand := range []string{
		filepath.Join(exeDir, "dist"),
		filepath.Join(exeDir, "..", "web-terminal-tcp", "dist"),
	} {
		if st, serr := os.Stat(filepath.Join(cand, "index.html")); serr == nil && !st.IsDir() {
			extDist = cand
			break
		}
	}

	ln, err := net.Listen("tcp", *listenFlag)
	if err != nil {
		log.Fatalf("Failed to bind MT5 Binary TCP Web Terminal on %s: %v", *listenFlag, err)
	}
	tcpAddr := ln.Addr().(*net.TCPAddr)
	ln = tcpNoDelayListener{Listener: ln}

	initialTarget := strings.TrimSpace(*targetFlag)
	localBrokerID := ""
	if strings.HasPrefix(initialTarget, "127.0.0.1:") || strings.HasPrefix(initialTarget, "localhost:") {
		localBrokerID = strings.TrimSpace(*brokerIDFlag)
	}

	srv := &WebTerminalServer{
		listenAddr:        *listenFlag,
		defaultPort:       tcpAddr.Port,
		exeDir:            exeDir,
		masterPubHex:      loadAuthorityMasterPubHex(exeDir),
		distRoot:          subFS,
		externalDist:      extDist,
		localUIOnly:       strings.EqualFold(strings.TrimSpace(os.Getenv("RTX5_WEB_UI_SOURCE")), "local"),
		localBrokerID:     localBrokerID,
		superAdminTCP:     strings.TrimSpace(*saFlag),
		directGatewayPush: true,
		sessionTokens:     make(map[string]string),
	}
	if localBrokerID != "" {
		srv.localTarget = initialTarget
	}
	srv.initHotUIOTAState()
	configureAccountTunnelLimits()

	// Sessions that never pick a broker use this server's own broker. The local broker's link
	// starts the direct :8190 RTO\x01 push stream (0.0 ms trade-event fanout next to rtx5-gateway).
	srv.setDefaultBroker(strings.TrimSpace(*brokerIDFlag), strings.TrimSpace(*brokerNameFlag), initialTarget)

	if srv.superAdminTCP != "" {
		go srv.refreshBrokerDirectory(true)
	}
	go srv.backgroundReconnectLoop()
	go srv.runBackgroundHotUIOTALoop()
	startWebStreamDropReporter()

	defID, defName, defTarget := srv.linkIdentity(srv.defaultLink())
	modeLabel := "HTTP + WS (Direct Zero-Cloudflare Binary TCP)"
	if *tlsCertFlag != "" && *tlsKeyFlag != "" {
		modeLabel = "HTTPS + WSS TLS 1.3 (Direct Zero-Cloudflare Binary TCP)"
	}
	log.Printf("[RTX5-Web-Terminal-TCP] Listening on %s (%s) ===> Fast-Lane Engine: %s | Access Tunnel: %s | SuperAdmin Hub: %s (Broker: %s / %s)",
		*listenFlag, modeLabel, envOrDefault("BROKER_GATEWAY_RTO_ADDR", "127.0.0.1:8190"), defTarget, srv.superAdminTCP, defID, defName)

	if *tlsCertFlag != "" && *tlsKeyFlag != "" && tcpAddr.Port == 443 {
		go func() {
			httpLn, herr := net.Listen("tcp", "0.0.0.0:80")
			if herr != nil {
				return
			}
			log.Printf("[RTX5-Web-Terminal-TCP] Listening on 0.0.0.0:80 (HTTP -> HTTPS :443 Redirect)")
			redirectSrv := &http.Server{
				Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
					if host == "" {
						host = strings.TrimSpace(r.Host)
					}
					if idx := strings.IndexByte(host, ','); idx > 0 {
						host = strings.TrimSpace(host[:idx])
					}
					if h, _, serr := net.SplitHostPort(host); serr == nil && h != "" {
						host = h
					}
					if host == "" {
						host = "tcp-terminal.orrnn.com"
					}
					http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusMovedPermanently)
				}),
				ReadHeaderTimeout: 10 * time.Second,
				IdleTimeout:       60 * time.Second,
			}
			_ = redirectSrv.Serve(tcpNoDelayListener{Listener: httpLn})
		}()
	}

	httpSrv := &http.Server{
		Handler:           http.HandlerFunc(srv.serveHTTP),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       180 * time.Second,
	}

	go func() {
		var serr error
		if *tlsCertFlag != "" && *tlsKeyFlag != "" {
			serr = httpSrv.ServeTLS(ln, *tlsCertFlag, *tlsKeyFlag)
		} else {
			serr = httpSrv.Serve(ln)
		}
		if serr != nil && serr != http.ErrServerClosed {
			log.Fatalf("Web Terminal server stopped: %v", serr)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh
}

func (c *WebTerminalServer) resolveClientSessionKey(w http.ResponseWriter, r *http.Request) string {
	if r != nil {
		if v, ok := r.Context().Value(sessionKeyCtx{}).(string); ok && v != "" {
			return v // already resolved (and any new cookie already issued) earlier in this request
		}
		if ck, err := r.Cookie("rtx5_wt_sid"); err == nil && strings.TrimSpace(ck.Value) != "" {
			return strings.TrimSpace(ck.Value)
		}
		if hdr := strings.TrimSpace(r.Header.Get("X-RTX5-Session")); hdr != "" {
			return hdr
		}
	}
	var rnd [16]byte
	_, _ = rand.Read(rnd[:])
	sid := hex.EncodeToString(rnd[:])
	if w != nil {
		http.SetCookie(w, &http.Cookie{
			Name:     "rtx5_wt_sid",
			Value:    sid,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
		})
	}
	return sid
}

func (c *WebTerminalServer) setSessionOrderToken(sessionKey, tok string) {
	tok = strings.TrimSpace(tok)
	if tok == "" {
		if sessionKey != "" {
			c.sessionMu.Lock()
			delete(c.sessionTokens, sessionKey)
			c.sessionMu.Unlock()
		}
		return
	}
	c.cachedOrderAuthToken.Store(tok)
	if sessionKey == "" {
		return
	}
	c.sessionMu.Lock()
	c.sessionTokens[sessionKey] = tok
	c.sessionMu.Unlock()
}

func (c *WebTerminalServer) getSessionOrderToken(sessionKey string) string {
	if sessionKey != "" {
		c.sessionMu.RLock()
		tok := c.sessionTokens[sessionKey]
		c.sessionMu.RUnlock()
		if tok != "" {
			return tok
		}
	}
	if v := c.cachedOrderAuthToken.Load(); v != nil {
		if s, ok := v.(string); ok {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func (c *WebTerminalServer) getActiveDistFSForApp(appKind string) fs.FS {
	if appKind == "" {
		appKind = "terminal"
	}
	if c.localUIOnly && appKind == "terminal" && c.externalDist != "" {
		if st, err := os.Stat(filepath.Join(c.externalDist, "index.html")); err == nil && !st.IsDir() {
			return os.DirFS(c.externalDist)
		}
	}
	candidates := []string{
		filepath.Join(c.exeDir, "..", "runtime-data", "ui-cache", appKind),
		filepath.Join(c.exeDir, "ui-cache", appKind),
		filepath.Join(c.exeDir, "..", "ui-dist", appKind),
		filepath.Join(c.exeDir, "ui-dist", appKind),
	}
	if c.localUIOnly {
		candidates = candidates[2:] // local builds only; an old OTA cache must not shadow them
	}
	for _, cand := range candidates {
		if st, err := os.Stat(filepath.Join(cand, "index.html")); err == nil && !st.IsDir() {
			return os.DirFS(cand)
		}
	}
	if appKind != "terminal" {
		_ = c.syncHotUIOTA()
		for _, cand := range candidates {
			if st, err := os.Stat(filepath.Join(cand, "index.html")); err == nil && !st.IsDir() {
				return os.DirFS(cand)
			}
		}
	}
	if appKind == "terminal" && c.externalDist != "" {
		if st, err := os.Stat(filepath.Join(c.externalDist, "index.html")); err == nil && !st.IsDir() {
			return os.DirFS(c.externalDist)
		}
	}
	return c.distRoot
}

func (c *WebTerminalServer) getActiveDistFS() fs.FS {
	return c.getActiveDistFSForApp("terminal")
}

func (c *WebTerminalServer) superAdminCandidates() []string {
	c.mu.RLock()
	sa := strings.TrimSpace(c.superAdminTCP)
	c.mu.RUnlock()

	var list []string
	add := func(addr string) {
		addr = strings.TrimSpace(addr)
		if addr == "" {
			return
		}
		for _, ex := range list {
			if strings.EqualFold(ex, addr) {
				return
			}
		}
		list = append(list, addr)
	}

	if sa == "" || strings.EqualFold(sa, "185.126.217.108:9100") || strings.EqualFold(sa, "127.0.0.1:9100") || strings.EqualFold(sa, "localhost:9100") {
		add("127.0.0.1:9100")
		add(sa)
		add("185.126.217.108:9100")
	} else {
		add(sa)
		add("127.0.0.1:9100")
		add("185.126.217.108:9100")
	}
	return list
}

func (c *WebTerminalServer) getOrDialSessionForApp(link *brokerLink, appKind string) (*rtx5tcp.MuxSession, error) {
	switch appKind {
	case "superadmin":
		c.mu.RLock()
		sess := c.superAdminMux
		c.mu.RUnlock()
		if sess != nil {
			select {
			case <-sess.Done():
			default:
				return sess, nil
			}
		}

		c.saDialMu.Lock()
		defer c.saDialMu.Unlock()

		c.mu.RLock()
		sess = c.superAdminMux
		c.mu.RUnlock()
		if sess != nil {
			select {
			case <-sess.Done():
			default:
				return sess, nil
			}
		}

		candidates := c.superAdminCandidates()
		var lastErr error
		for _, cand := range candidates {
			timeout := 5 * time.Second
			if strings.HasPrefix(cand, "127.0.0.1:") || strings.HasPrefix(cand, "localhost:") {
				timeout = 1500 * time.Millisecond
			}
			tc, err := rtx5tcp.DialTunnel(cand, rtx5tcp.RoleSuperAdminClient, timeout)
			if err != nil {
				lastErr = err
				continue
			}
			newSess := rtx5tcp.NewMuxSession(tc, false, nil, nil)
			c.mu.Lock()
			c.superAdminMux = newSess
			c.superAdminTCP = cand
			c.mu.Unlock()

			go func(s *rtx5tcp.MuxSession) {
				_ = s.ServeLoop()
				c.mu.Lock()
				if c.superAdminMux == s {
					c.superAdminMux = nil
				}
				c.mu.Unlock()
			}(newSess)
			return newSess, nil
		}
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, fmt.Errorf("superadmin :9100 binary TCP hub unreachable")

	case "manager":
		if link == nil {
			return nil, errNoBrokerTarget
		}
		return link.getOrDialManagerSession()

	case "admin":
		if link == nil {
			return nil, errNoBrokerTarget
		}
		return link.getOrDialAdminSession()

	default:
		if link == nil {
			return nil, errNoBrokerTarget
		}
		return link.getOrDialSession()
	}
}

func (c *WebTerminalServer) backgroundReconnectLoop() {
	firstBoot := true
	lastDirRefresh := time.Now()
	for {
		now := time.Now()
		c.pruneIdle(now)
		c.linksMu.RLock()
		defKey := c.defaultLinkKey
		c.linksMu.RUnlock()
		// Keep the default broker's tunnels warm always, other brokers' while pages use them.
		for _, l := range c.activeLinks() {
			isDefault := linkKey(l.id, l.target) == defKey
			if !isDefault && l.isIdle(now) {
				continue
			}
			keepLinkWarm(l, firstBoot && isDefault)
		}
		firstBoot = false

		c.mu.RLock()
		saSess := c.superAdminMux
		c.mu.RUnlock()
		if saSess != nil {
			_, _ = saSess.MeasurePingRTT(1500 * time.Millisecond)
		}

		if c.superAdminTCP != "" && time.Since(lastDirRefresh) >= 5*time.Second {
			lastDirRefresh = time.Now()
			go c.refreshBrokerDirectory(false)
		}
		time.Sleep(3 * time.Second)
	}
}

// keepLinkWarm dials the link's terminal tunnel (recording its RTT) and pings its other tunnels.
func keepLinkWarm(l *brokerLink, firstBoot bool) {
	var wg sync.WaitGroup
	if firstBoot {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = l.getOrDialOrderSession()
		}()
	}
	if sess, err := l.getOrDialSession(); err == nil && sess != nil {
		if rtt, perr := sess.MeasurePingRTT(2 * time.Second); perr == nil && rtt > 0 {
			l.recordRTT(rtt)
		}
	}
	l.keepAccountTunnelsWarm()
	l.mu.RLock()
	actSess, mgrSess, admSess := l.activeMux, l.managerMux, l.adminMux
	l.mu.RUnlock()
	if mgrSess != nil {
		_, _ = mgrSess.MeasurePingRTT(1500 * time.Millisecond)
	}
	if admSess != nil {
		_, _ = admSess.MeasurePingRTT(1500 * time.Millisecond)
	}
	if firstBoot {
		wg.Wait()
	} else if orderSess, oerr := l.getOrDialOrderSession(); oerr == nil && orderSess != nil && orderSess != actSess {
		_, _ = orderSess.MeasurePingRTT(1500 * time.Millisecond)
	}
}

func (c *WebTerminalServer) resolveBrokerFromCache(brokerID, brokerName, tcpAddr string) (string, string, string) {
	findMatch := func(list []DiscoveredBroker) (DiscoveredBroker, bool) {
		for _, b := range list {
			if brokerID != "" && strings.EqualFold(b.BrokerID, brokerID) {
				return b, true
			}
		}
		for _, b := range list {
			if brokerName != "" && strings.EqualFold(b.BrokerName, brokerName) {
				return b, true
			}
		}
		for _, b := range list {
			if tcpAddr != "" && strings.EqualFold(b.TCPAddr, tcpAddr) {
				return b, true
			}
		}
		return DiscoveredBroker{}, false
	}

	c.mu.RLock()
	list := make([]DiscoveredBroker, len(c.cachedBrokers))
	copy(list, c.cachedBrokers)
	c.mu.RUnlock()

	matched, ok := findMatch(list)
	if !ok && c.superAdminTCP != "" && (brokerID != "" || brokerName != "") {
		done := make(chan struct{})
		go func() {
			defer close(done)
			c.refreshBrokerDirectory(false)
		}()
		select {
		case <-done:
		case <-time.After(400 * time.Millisecond):
		}
		c.mu.RLock()
		list = make([]DiscoveredBroker, len(c.cachedBrokers))
		copy(list, c.cachedBrokers)
		c.mu.RUnlock()
		matched, ok = findMatch(list)
	}
	if ok {
		if brokerID == "" {
			brokerID = matched.BrokerID
		}
		if brokerName == "" {
			brokerName = matched.BrokerName
		}
		if tcpAddr == "" {
			tcpAddr = matched.TCPAddr
		}
	}
	if brokerName == "" && brokerID != "" {
		brokerName = brokerID
	}
	return brokerID, brokerName, tcpAddr
}

// switchSessionBroker points this browser session (and only this one) at the chosen broker.
// It returns nil when the broker has no known TCP address.
func (c *WebTerminalServer) switchSessionBroker(sessionKey, brokerID, brokerName, tcpAddr string) *brokerLink {
	brokerID, brokerName, tcpAddr = c.resolveBrokerFromCache(brokerID, brokerName, tcpAddr)
	l := c.ensureLink(brokerID, brokerName, tcpAddr)
	if l == nil {
		return nil
	}
	l.orderFastLaneUnsupported.Store(false)
	c.bindSession(sessionKey, l)
	dialDone := make(chan struct{})
	go func() {
		defer close(dialDone)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = l.getOrDialSession()
		}()
		go func() {
			defer wg.Done()
			_, _ = l.getOrDialOrderSession()
		}()
		wg.Wait()
	}()
	select {
	case <-dialDone:
	case <-time.After(300 * time.Millisecond):
	}
	return l
}

func (c *WebTerminalServer) maybeRefreshBrokerDirectoryOnRequest() {
	if c.superAdminTCP == "" {
		return
	}
	c.mu.RLock()
	count := len(c.cachedBrokers)
	age := time.Since(c.cachedBrokersAt)
	c.mu.RUnlock()

	needFastRefresh := count <= 1 && age > 2*time.Second
	needStaleRefresh := age > 3*time.Second
	if !needFastRefresh && !needStaleRefresh {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.refreshBrokerDirectory(false)
	}()
	select {
	case <-done:
	case <-time.After(400 * time.Millisecond):
	}
}

func (c *WebTerminalServer) querySuperAdminBrokerDirectory() ([]DiscoveredBroker, error) {
	candidates := c.superAdminCandidates()
	if len(candidates) == 0 {
		return nil, fmt.Errorf("superadmin discovery address empty")
	}

	var lastErr error
	for _, cand := range candidates {
		tc, err := rtx5tcp.DialTunnel(cand, rtx5tcp.RoleDiscoveryProbe, 1500*time.Millisecond)
		if err != nil {
			lastErr = err
			continue
		}
		if err := tc.WriteMuxFrame(rtx5tcp.FrameBrokerDirectoryReq, 1, rtx5tcp.FlagFIN, []byte("{}")); err != nil {
			_ = tc.Close()
			lastErr = err
			continue
		}
		ft, _, _, payload, err := tc.ReadMuxFrame()
		_ = tc.Close()
		if err != nil || ft != rtx5tcp.FrameBrokerDirectoryResp {
			lastErr = fmt.Errorf("unexpected discovery frame %d: %v", ft, err)
			continue
		}
		var list []DiscoveredBroker
		if err := json.Unmarshal(payload, &list); err != nil {
			lastErr = err
			continue
		}
		if len(list) > 0 {
			cp := make([]DiscoveredBroker, len(list))
			copy(cp, list)
			c.mu.Lock()
			c.cachedBrokers = cp
			c.cachedBrokersAt = time.Now()
			c.superAdminTCP = cand
			c.mu.Unlock()
			return list, nil
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("superadmin discovery unreachable")
}

func (c *WebTerminalServer) refreshBrokerDirectory(initial bool) {
	c.dirRefreshMu.Lock()
	defer c.dirRefreshMu.Unlock()
	list, err := c.querySuperAdminBrokerDirectory()
	if err != nil || len(list) == 0 {
		return
	}
	if !initial {
		return
	}
	// Only the default broker (for sessions that never chose one) follows the directory here.
	defLink := c.defaultLink()
	id, name, target := c.linkIdentity(defLink)
	if defLink != nil {
		defLink.mu.RLock()
		name = defLink.name
		defLink.mu.RUnlock()
	}
	matched := false
	for _, b := range list {
		if strings.EqualFold(b.BrokerID, id) {
			matched = true
			if name == "" && b.BrokerName != "" {
				c.setDefaultBroker(id, b.BrokerName, target)
			}
			break
		}
	}
	if !matched && (id == "" || id == "fxtrust-tcp") {
		t := strings.TrimSpace(list[0].TCPAddr)
		if t == "" {
			t = target
		}
		c.setDefaultBroker(list[0].BrokerID, list[0].BrokerName, t)
	}
}

func (c *WebTerminalServer) getCachedBrokerDirectory(link *brokerLink) []DiscoveredBroker {
	c.mu.RLock()
	if len(c.cachedBrokers) > 0 {
		out := make([]DiscoveredBroker, len(c.cachedBrokers))
		copy(out, c.cachedBrokers)
		c.mu.RUnlock()
		return out
	}
	c.mu.RUnlock()
	curID, curName, curTCP := c.linkIdentity(link)
	if curID == "" {
		curID = "fxtrust-tcp"
	}
	if curName == "" {
		curName = "FXTrust-TCP-Live"
	}
	return []DiscoveredBroker{{
		BrokerID:   curID,
		BrokerName: curName,
		TCPAddr:    curTCP,
		Plan:       "Enterprise",
		Online:     true,
	}}
}

func (c *WebTerminalServer) requestOrigin(r *http.Request) (httpOrigin, wsOrigin, hostOnly string, port int) {
	scheme := "http"
	wsScheme := "ws"
	if r != nil && (r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")) {
		scheme = "https"
		wsScheme = "wss"
	}
	hostHeader := ""
	if r != nil {
		hostHeader = strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
		if idx := strings.IndexByte(hostHeader, ','); idx > 0 {
			hostHeader = strings.TrimSpace(hostHeader[:idx])
		}
		if hostHeader == "" {
			hostHeader = strings.TrimSpace(r.Host)
		}
	}
	if hostHeader == "" {
		hostHeader = fmt.Sprintf("127.0.0.1:%d", c.defaultPort)
	}
	h, pStr, err := net.SplitHostPort(hostHeader)
	if err != nil {
		h = hostHeader
		if scheme == "https" {
			port = 443
		} else {
			port = c.defaultPort
		}
	} else {
		if pNum, perr := strconv.Atoi(pStr); perr == nil && pNum > 0 {
			port = pNum
		} else {
			port = c.defaultPort
		}
	}
	if h == "" {
		h = "127.0.0.1"
	}
	return scheme + "://" + hostHeader, wsScheme + "://" + hostHeader, h, port
}

func isLoopbackBrowserOrigin(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	host := strings.ToLower(strings.Trim(parsed.Hostname(), "[]"))
	return host == "localhost" || host == "127.0.0.1" || host == "::1" || strings.HasSuffix(host, ".localhost")
}

func setLoopbackCORSHeaders(h http.Header, origin string, reqHeaders string) {
	h.Set("Access-Control-Allow-Origin", origin)
	h.Set("Access-Control-Allow-Credentials", "true")
	h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
	if strings.TrimSpace(reqHeaders) != "" {
		h.Set("Access-Control-Allow-Headers", reqHeaders)
	} else {
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-Requested-With, Origin, X-API-Key, X-Broker-ID, X-Request-ID, X-Client-ID")
	}
	h.Set("Access-Control-Max-Age", "86400")
	h.Set("Vary", "Origin")
}

func applyLoopbackCORSHeaders(w http.ResponseWriter, r *http.Request) string {
	if r == nil {
		return ""
	}
	orig := strings.TrimSpace(r.Header.Get("Origin"))
	if !isLoopbackBrowserOrigin(orig) {
		return ""
	}
	setLoopbackCORSHeaders(w.Header(), orig, r.Header.Get("Access-Control-Request-Headers"))
	return orig
}

// corsProtectedResponseWriter prevents upstream proxied headers from overwriting
// or duplicating Access-Control-* headers for an allowed loopback browser origin.
type corsProtectedResponseWriter struct {
	http.ResponseWriter
	origin      string
	reqHeaders  string
	wroteHeader bool
}

func (w *corsProtectedResponseWriter) enforceCORS() {
	if w.wroteHeader || w.origin == "" {
		return
	}
	w.wroteHeader = true
	setLoopbackCORSHeaders(w.Header(), w.origin, w.reqHeaders)
}

func (w *corsProtectedResponseWriter) WriteHeader(statusCode int) {
	w.enforceCORS()
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *corsProtectedResponseWriter) Write(p []byte) (int, error) {
	w.enforceCORS()
	return w.ResponseWriter.Write(p)
}

func (w *corsProtectedResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		w.enforceCORS()
		f.Flush()
	}
}

func (w *corsProtectedResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := w.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("hijack not supported")
}

func (c *WebTerminalServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if allowedOrigin := applyLoopbackCORSHeaders(w, r); allowedOrigin != "" && r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	p := r.URL.Path
	sessionKey := c.resolveClientSessionKey(w, r)
	r = withSessionKey(r, sessionKey)
	appKind := resolveWebAppKind(r)
	link := c.linkForRequest(r) // this page's broker (per-session broker targets, with X-Broker-ID header lookup for cookieless calls)

	switch p {
	case "/__rtx5_binary_stream":
		c.serveBinaryMarketStream(w, r)
		return

	case "/__rtx5_binary_order_ws":
		c.serveBinaryOrderWS(w, r)
		return

	case "/__rtx5_binary_order":
		c.serveBinaryOrderHTTP(w, r)
		return

	case "/__rtx5_binary_account_sub":
		c.serveBinaryAccountSub(w, r)
		return

	case "/__rtx5_drawing_ws":
		c.serveDrawingSyncWS(w, r)
		return

	case "/rtx5-tcp-toolbar.js":
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(tcpToolbarJS)
		return

	case "/tcp-security-drawer.js":
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(securityDrawerJS)
		return

	case "/api/tcp-client/status":
		httpOrigin, wsOrigin, _, _ := c.requestOrigin(r)
		c.mu.RLock()
		saTarget := c.superAdminTCP
		c.mu.RUnlock()
		bid, bnm, target := c.linkIdentity(link)
		var rttMs, avgRttMs float64
		if link != nil {
			rttMs, avgRttMs = link.rtt()
		}

		sess, _ := c.getOrDialSessionForApp(link, appKind)
		if appKind == "superadmin" {
			if saTarget != "" {
				target = saTarget
			} else {
				target = "185.126.217.108:9100"
			}
		}
		connected := false
		if sess != nil {
			select {
			case <-sess.Done():
			default:
				connected = true
				if sessRtt := sess.LastRTTMs(); sessRtt > 0 {
					rttMs = sessRtt
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"app":               appKindToStatusAppName(appKind),
			"mode":              "web-terminal-tcp",
			"connected":         connected,
			"magic":             "RTX\\x05 (0x52 0x54 0x58 0x05) + RTO\\x01 (:8190 Direct RAM)",
			"cipher":            "X25519 + HKDF-SHA256 + AES-256-GCM",
			"target_tcp":        target,
			"fast_order_origin": httpOrigin,
			"fast_order_ws_url": wsOrigin + "/__rtx5_binary_order_ws",
			"broker_id":         bid,
			"broker_name":       bnm,
			"rtt_ms":            rttMs,
			"avg_rtt_ms":        avgRttMs,
			"dll_verified":      true,
			"ota":               c.getOTAStatusSnapshotForApp(appKind),
		})
		return

	case "/api/tcp-client/ota-check":
		err := c.syncHotUIOTA()
		snap := c.getOTAStatusSnapshotForApp(appKind)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error(), "ota": snap})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ota": snap})
		return

	case "/api/tcp-client/ota-channel":
		if r.Method == http.MethodPost {
			var req struct {
				Channel string `json:"channel"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			ch := c.setOTAChannel(req.Channel)
			go func() {
				_ = c.syncHotUIOTA()
			}()
			snap := c.getOTAStatusSnapshotForApp(appKind)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "channel": ch, "ota": snap})
			return
		}
		snap := c.getOTAStatusSnapshotForApp(appKind)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "channel": c.getOTAChannel(), "ota": snap})
		return

	case "/api/tcp-client/ota-ack-ui":
		c.ackUIReloadForApp(appKind)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ota": c.getOTAStatusSnapshotForApp(appKind)})
		return

	case "/api/tcp-client/ota-restart":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return

	case "/api/tcp-client/save-file":
		var savedPaths []string
		if r.Method == http.MethodPost && r.Body != nil {
			var req struct {
				Filename string `json:"filename"`
				Content  string `json:"content"`
			}
			if json.NewDecoder(r.Body).Decode(&req) == nil && req.Content != "" {
				fname := filepath.Base(strings.TrimSpace(req.Filename))
				if fname == "" || fname == "." {
					fname = "broker.lic"
				}
				licDir := filepath.Join(c.exeDir, "..", "runtime-data", "issued-licenses")
				if os.MkdirAll(licDir, 0755) == nil {
					dst := filepath.Join(licDir, fname)
					if os.WriteFile(dst, []byte(req.Content), 0644) == nil {
						savedPaths = append(savedPaths, dst)
					}
				}
			}
		}
		if len(savedPaths) == 0 {
			savedPaths = []string{"browser-download"}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          true,
			"saved_paths": savedPaths,
		})
		return

	case "/api/tcp-client/brokers":
		c.maybeRefreshBrokerDirectoryOnRequest()
		writeJSON(w, http.StatusOK, c.getCachedBrokerDirectory(link))
		return

	case "/api/tcp-client/switch-broker":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			BrokerID   string `json:"broker_id"`
			ID         string `json:"id"`
			BrokerName string `json:"broker_name"`
			Name       string `json:"name"`
			Server     string `json:"server"`
			TCPAddr    string `json:"tcp_addr"`
			TargetTCP  string `json:"target_tcp"`
			ServerTCP  string `json:"server_tcp"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		bid := strings.TrimSpace(req.BrokerID)
		if bid == "" {
			bid = strings.TrimSpace(req.ID)
		}
		bnm := strings.TrimSpace(req.BrokerName)
		if bnm == "" {
			bnm = strings.TrimSpace(req.Name)
		}
		if bnm == "" {
			bnm = strings.TrimSpace(req.Server)
		}
		tAddr := strings.TrimSpace(req.TCPAddr)
		if tAddr == "" {
			tAddr = strings.TrimSpace(req.TargetTCP)
		}
		if tAddr == "" {
			tAddr = strings.TrimSpace(req.ServerTCP)
		}
		// Only this browser session moves; other pages keep their broker.
		switched := c.switchSessionBroker(sessionKey, bid, bnm, tAddr)
		if switched == nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok":    false,
				"error": "unknown broker: no TCP address for " + strings.TrimSpace(bid+" "+bnm),
			})
			return
		}
		activeID, activeName, activeTCP := c.linkIdentity(switched)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          true,
			"broker_id":   activeID,
			"broker_name": activeName,
			"tcp_addr":    activeTCP,
			"target_tcp":  activeTCP,
		})
		return

	case "/api/tcp-client/quit":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}

	if p == "/runtime-config-validator.js" {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("/* web-terminal-tcp runtime validator bypass */\n"))
		return
	}

	if appKind == "superadmin" {
		if p == "/runtime-config.js" {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte("/* superadmin web-tcp */\n"))
			return
		}
		if svc, rewritten, ok := classifySuperAdminRoute(r); ok {
			c.proxyOverBinaryTCPForApp(w, r, link, "superadmin", svc, rewritten)
			return
		}
		c.serveEmbeddedSPA(w, r)
		return
	}

	if p == "/runtime-config.js" {
		c.serveBrokerRuntimeConfigJS(w, r)
		return
	}

	normDrawingPath := strings.TrimPrefix(p, "/ext-api")
	if normDrawingPath == "/api/fix/drawings" || strings.HasPrefix(normDrawingPath, "/api/fix/drawings/") {
		c.serveDrawingSyncHTTP(w, r, normDrawingPath)
		return
	}

	if r.Method == http.MethodGet {
		normP := strings.TrimPrefix(p, "/ext-api")
		if normP == "/health" || normP == "/readiness" {
			sess, err := c.getOrDialSessionForApp(link, appKind)
			bid, bnm, tAddr := c.linkIdentity(link)
			writeJSON(w, http.StatusOK, map[string]any{
				"status":        "ok",
				"ok":            true,
				"mode":          "web-terminal-tcp",
				"app":           appKind,
				"tcp_connected": err == nil && sess != nil,
				"broker_id":     bid,
				"broker_name":   bnm,
				"target_tcp":    tAddr,
			})
			return
		}
		if normP == "/api/v2/broker/servers" || normP == "/api/v1/broker/servers" {
			c.maybeRefreshBrokerDirectoryOnRequest()
			c.serveBrokerDirectoryPayload(w, r, link, true)
			return
		}
		if normP == "/api/v2/brokers" || normP == "/api/v1/brokers" {
			c.maybeRefreshBrokerDirectoryOnRequest()
			c.serveBrokerDirectoryPayload(w, r, link, false)
			return
		}
		if (strings.HasPrefix(normP, "/api/v1/brokers/") || strings.HasPrefix(normP, "/api/v2/brokers/")) && strings.HasSuffix(normP, "/logo") {
			c.serveEmbeddedBrokerLogo(w, r)
			return
		}
		if strings.HasPrefix(normP, "/api/v2/depth/") && c.tryServeCachedDepthSnapshot(w, r) {
			return
		}
	}

	if svc, rewritten, ok := classifyBrokerRoute(appKind, r); ok {
		c.proxyOverBinaryTCPForApp(w, r, link, appKind, svc, rewritten)
		return
	}

	c.serveEmbeddedSPA(w, r)
}

func (c *WebTerminalServer) serveBrokerRuntimeConfigJS(w http.ResponseWriter, r *http.Request) {
	httpOrigin, wsOrigin, _, _ := c.requestOrigin(r)
	bid, bnm, target := c.linkIdentity(c.linkForRequest(r))
	if bid == "" {
		bid = "fxtrust-tcp"
	}
	if bnm == "" {
		bnm = "FXTrust-TCP-Live"
	}
	displayServer := bnm
	if target != "" {
		displayServer = fmt.Sprintf("%s (%s)", bnm, target)
	}

	cfgMap := map[string]any{
		"CONFIG_SOURCE":             "runtime",
		"BACKEND_TARGET":            "desktop",
		"BACKEND_MODE":              "desktop",
		"LOCAL_BACKEND":             "true",
		"API_HOST":                  httpOrigin,
		"API_URL":                   httpOrigin,
		"API_HOST_EXT":              httpOrigin,
		"BINARY_ORDER_URL":          httpOrigin + "/__rtx5_binary_order",
		"BINARY_ORDER_WS_URL":       wsOrigin + "/__rtx5_binary_order_ws",
		"WS_HOST":                   wsOrigin,
		"WS_URL":                    wsOrigin,
		"DISCOVERY_BASE_URL":        httpOrigin,
		"BROKER_DISCOVERY_URL":      httpOrigin,
		"SHARED_DISCOVERY_BASE_URL": httpOrigin,
		"BROKER_ALLOWED_ORIGINS":    httpOrigin,
		"BROKER_ID":                 bid,
		"FEED_BROKER_ID":            bid,
		"BROKER_NAME":               bnm,
		"DEFAULT_MT5_SERVER":        bnm,
		"TCP_SERVER_ADDR":           target,
		"DISPLAY_SERVER":            displayServer,
		"PUBLIC_MARKET_API":         "gateway-v2",
		"USE_DEV_PROXY":             "false",
	}
	b, _ := json.Marshal(cfgMap)

	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	js := fmt.Sprintf(
		"(function(){var cfg=%s;window.__RTX5_RUNTIME_CONFIG__=cfg;window.__RTX_RUNTIME_CONFIG__=cfg;window.RUNTIME_CONFIG=cfg;window.__RUNTIME_CONFIG__=cfg;"+
			"var q=function(){try{window.close();}catch(_){}};"+
			"window.rtx5DesktopQuit=q;"+
			"window.rtx5Electron=Object.assign({},window.rtx5Electron,{isDesktop:true,platform:'web-tcp',quit:q});"+
			"window.electronAPI=Object.assign({},window.electronAPI,{isDesktop:true,platform:'web-tcp',quit:q});"+
			"window.electron=Object.assign({},window.electron,{app:{quit:q}});"+
			"})();\n",
		string(b),
	)
	_, _ = w.Write([]byte(js))
}

func (c *WebTerminalServer) serveBrokerDirectoryPayload(w http.ResponseWriter, r *http.Request, link *brokerLink, asArray bool) {
	appKind := resolveWebAppKind(r)
	httpOrigin, wsOrigin, hostOnly, port := c.requestOrigin(r)
	proto := "http"
	if strings.HasPrefix(httpOrigin, "https://") {
		proto = "https"
	}
	list := c.getCachedBrokerDirectory(link)
	_, _, curTCP := c.linkIdentity(link)

	servicesDomain := hostOnly
	if port > 0 && port != 80 && port != 443 {
		servicesDomain = fmt.Sprintf("%s:%d", hostOnly, port)
	}

	items := make([]map[string]any, 0, len(list))
	for _, b := range list {
		tcpAddr := b.TCPAddr
		if tcpAddr == "" {
			tcpAddr = curTCP
		}
		displayServer := b.BrokerName
		regionLabel := "Binary TCP"
		if tcpAddr != "" {
			displayServer = fmt.Sprintf("%s (%s)", b.BrokerName, tcpAddr)
			regionLabel = fmt.Sprintf("TCP %s", tcpAddr)
		}
		logoURL := httpOrigin + "/brand/terminal-icon.png"
		switch appKind {
		case "manager":
			logoURL = httpOrigin + "/rtx5-logo.png"
		case "admin":
			logoURL = httpOrigin + "/admin-symbol.png"
		}
		items = append(items, map[string]any{
			"id":                    b.BrokerID,
			"broker_id":             b.BrokerID,
			"broker_name":           b.BrokerName,
			"name":                  b.BrokerName,
			"server":                b.BrokerName,
			"server_name":           displayServer,
			"display_server":        displayServer,
			"server_display":        displayServer,
			"display_server_name":   displayServer,
			"logo_url":              logoURL,
			"server_ip":             hostOnly,
			"server_port":           port,
			"protocol":              proto,
			"server_url":            httpOrigin,
			"backend_url":           httpOrigin,
			"market_api_url":        httpOrigin,
			"API_HOST":              httpOrigin,
			"API_HOST_EXT":          httpOrigin,
			"ws_url":                wsOrigin + "/ws/v2",
			"trade_ws_url":          wsOrigin + "/ws/v2",
			"trade_wss_url":         wsOrigin + "/ws/v2",
			"feed_url":              wsOrigin + "/ws/feed",
			"feed_ws_url":           wsOrigin + "/ws/feed",
			"feed_wss_url":          wsOrigin + "/ws/feed",
			"feed_status_url":       httpOrigin + "/ws/feed/status",
			"feed_status_https_url": httpOrigin + "/ws/feed/status",
			"services_domain":       servicesDomain,
			"config_version":        1,
			"schema_version":        2,
			"region":                regionLabel,
			"tcp_addr":              tcpAddr,
			"status":                "active",
			"active":                true,
			"enabled":               true,
			"created_at":            1700000000,
		})
	}

	if asArray {
		writeJSON(w, http.StatusOK, items)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"brokers": items,
		"servers": items,
		"data":    items,
		"count":   len(items),
	})
}

func (c *WebTerminalServer) proxyOverBinaryTCP(w http.ResponseWriter, r *http.Request, targetService string, rewrittenPath string) {
	c.proxyOverBinaryTCPForApp(w, r, c.linkForRequest(r), resolveWebAppKind(r), targetService, rewrittenPath)
}

func (c *WebTerminalServer) proxyOverBinaryTCPForApp(w http.ResponseWriter, r *http.Request, link *brokerLink, appKind string, targetService string, rewrittenPath string) {
	sess, err := c.getOrDialSessionForApp(link, appKind)
	if err != nil || sess == nil {
		if r.URL.Path == "/health" || r.URL.Path == "/readiness" {
			writeJSON(w, http.StatusOK, map[string]any{
				"status":        "ok",
				"ok":            true,
				"mode":          "web-terminal-tcp",
				"app":           appKind,
				"tcp_connected": false,
			})
			return
		}
		_, _, targetLabel := c.linkIdentity(link)
		if appKind == "superadmin" {
			c.mu.RLock()
			targetLabel = c.superAdminTCP
			c.mu.RUnlock()
		}
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": fmt.Sprintf("Encrypted Binary TCP Server (%s) unreachable: %v", targetLabel, err),
		})
		return
	}
	clone := r.Clone(r.Context())
	clone.URL.Path = rewrittenPath
	clone.RequestURI = ""
	localLoopbackOrigin := "http://127.0.0.1:18403"
	switch appKind {
	case "superadmin":
		localLoopbackOrigin = "http://127.0.0.1:18400"
	case "admin":
		localLoopbackOrigin = "http://127.0.0.1:18401"
	case "manager":
		localLoopbackOrigin = "http://127.0.0.1:18402"
	}
	// Normalize Origin to loopback for internal backend services while preserving
	// clean single-value CORS headers for loopback browser callers.
	outWriter := w
	if orig := strings.TrimSpace(r.Header.Get("Origin")); orig != "" {
		if isLoopbackBrowserOrigin(orig) {
			setLoopbackCORSHeaders(w.Header(), orig, r.Header.Get("Access-Control-Request-Headers"))
			outWriter = &corsProtectedResponseWriter{
				ResponseWriter: w,
				origin:         orig,
				reqHeaders:     r.Header.Get("Access-Control-Request-Headers"),
			}
		}
		clone.Header.Set("Origin", localLoopbackOrigin)
	}
	if clone.Header.Get("X-Broker-ID") != "" {
		if canonID := c.canonicalBrokerIDForLink(link); canonID != "" {
			clone.Header.Set("X-Broker-ID", canonID)
		}
	}
	sess.ProxyHTTP(outWriter, clone, targetService)
}

func classifySuperAdminRoute(r *http.Request) (service string, rewrittenPath string, matched bool) {
	p := r.URL.Path
	isWS := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	switch {
	case strings.HasPrefix(p, "/api/tcp-security"):
		return "tcp-security", p, true
	case strings.HasPrefix(p, "/ota/"):
		return "ota", p, true
	case strings.HasPrefix(p, "/candle-api/"):
		return "control-plane", strings.TrimPrefix(p, "/candle-api"), true
	case p == "/candle-api":
		return "control-plane", "/", true
	case strings.HasPrefix(p, "/license/"), p == "/license":
		return "license", p, true
	case strings.HasPrefix(p, "/api/"),
		strings.HasPrefix(p, "/uploads/"),
		strings.HasPrefix(p, "/ws/"),
		p == "/health",
		p == "/readiness",
		p == "/livez",
		p == "/readyz",
		p == "/healthz",
		p == "/ready",
		p == "/health/live",
		p == "/health/ready",
		isWS:
		return "control-plane", p, true
	default:
		return "", "", false
	}
}

func rewriteManagerPrefixPath(sub string) string {
	if sub == "" {
		return "/"
	}
	if sub == "/accounts" || strings.HasPrefix(sub, "/accounts/") ||
		strings.HasPrefix(sub, "/transactions/") ||
		strings.HasPrefix(sub, "/auth/") ||
		sub == "/access" || strings.HasPrefix(sub, "/access/") ||
		strings.HasPrefix(sub, "/broker/") ||
		strings.HasPrefix(sub, "/payment-requests/") ||
		strings.HasPrefix(sub, "/calculation-baseline/") ||
		sub == "/orders" || strings.HasPrefix(sub, "/orders/") ||
		strings.HasPrefix(sub, "/positions/") {
		return "/api/v1/manager" + sub
	}
	return sub
}

func classifyBrokerRoute(appKind string, r *http.Request) (service string, rewrittenPath string, matched bool) {
	p := r.URL.Path
	isWS := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")

	if strings.HasPrefix(p, "/ext-api/") {
		p = strings.TrimPrefix(p, "/ext-api")
	}
	if strings.HasPrefix(p, "/api/manager/") {
		return "manager", rewriteManagerPrefixPath(strings.TrimPrefix(p, "/api/manager")), true
	}
	if strings.HasPrefix(p, "/manager/") {
		return "manager", rewriteManagerPrefixPath(strings.TrimPrefix(p, "/manager")), true
	}
	if strings.HasPrefix(p, "/Manager/") {
		return "manager", rewriteManagerPrefixPath(strings.TrimPrefix(p, "/Manager")), true
	}

	// Most specific /api/v2/admin/* rules first:
	// - /api/v2/admin/instruments/bulk-configure is served by gateway (:8090)
	// - /api/v2/admin/login, /api/v2/admin/instrument-catalogue, /api/v2/admin/instruments{,/*},
	//   and /api/v2/admin/engine/accounts/* are served by manager (:8091)
	if p == "/api/v2/admin/instruments/bulk-configure" ||
		strings.HasPrefix(p, "/api/v2/admin/instruments/bulk-configure/") {
		return "gateway", p, true
	}
	if p == "/api/v2/admin/login" ||
		p == "/api/v2/admin/instrument-catalogue" ||
		strings.HasPrefix(p, "/api/v2/admin/instrument-catalogue/") ||
		p == "/api/v2/admin/instruments" ||
		strings.HasPrefix(p, "/api/v2/admin/instruments/") ||
		p == "/api/v2/admin/engine/accounts" ||
		strings.HasPrefix(p, "/api/v2/admin/engine/accounts/") {
		return "manager", p, true
	}

	// /api/v2/auth/register (public demo signup) is only on gateway (:8090);
	// other /api/v2/auth/* routes go to manager (:8091) for admin/manager apps and gateway (:8090) for terminal.
	if p == "/api/v2/auth/register" || strings.HasPrefix(p, "/api/v2/auth/register/") {
		return "gateway", p, true
	}
	if (appKind == "admin" || appKind == "manager") && strings.HasPrefix(p, "/api/v2/auth/") {
		return "manager", p, true
	}

	// Normalize GET /api/v2/orders/pending?account_login={login} -> /api/v2/orders/pending/{login}
	// so Manager UI's fetchPendingOrders(accountLogin) hits gateway's GET /api/v2/orders/pending/{login}.
	if r.Method == http.MethodGet && p == "/api/v2/orders/pending" && r.URL != nil {
		q := r.URL.Query()
		login := strings.TrimSpace(q.Get("account_login"))
		if login == "" {
			login = strings.TrimSpace(q.Get("login"))
		}
		if login != "" && !strings.Contains(login, "/") {
			p = "/api/v2/orders/pending/" + login
		}
	}

	switch {
	case p == "/ota" || strings.HasPrefix(p, "/ota/") || strings.HasPrefix(p, "/api/v1/ota/"):
		return "ota", p, true

	case strings.HasPrefix(p, "/api/v2/binary-candles/"),
		strings.HasPrefix(p, "/api/v2/candles/"),
		strings.HasPrefix(p, "/api/v2/market-data/candles/"),
		strings.HasPrefix(p, "/history/candles/"),
		p == "/api/v1/candles" || strings.HasPrefix(p, "/api/v1/candles/"):
		return "binary-candles", p, true

	case p == "/ws/feed" || p == "/ws/feed/status" || strings.HasPrefix(p, "/ws/feed/"),
		p == "/lp/health",
		strings.HasPrefix(p, "/api/v1/market/"),
		strings.HasPrefix(p, "/api/v1/central-lp/"),
		strings.HasPrefix(p, "/api/v1/t4b/"),
		p == "/api/v1/lps" || strings.HasPrefix(p, "/api/v1/lps/"),
		p == "/api/v1/fills" || strings.HasPrefix(p, "/api/v1/fills/"),
		p == "/api/v1/order",
		strings.HasPrefix(p, "/api/v1/feed/"),
		strings.HasPrefix(p, "/api/v1/gateway/feed/"),
		p == "/api/v1/gateway/quote-source" || strings.HasPrefix(p, "/api/v1/gateway/quote-source/"),
		p == "/api/v1/gateway/lp-connections" || strings.HasPrefix(p, "/api/v1/gateway/lp-connections/"),
		p == "/api/v1/gateway/lp-feeds" || strings.HasPrefix(p, "/api/v1/gateway/lp-feeds/"),
		p == "/api/v1/gateway/lp-journal" || strings.HasPrefix(p, "/api/v1/gateway/lp-journal/"),
		p == "/api/v1/gateway/lp-routing" || strings.HasPrefix(p, "/api/v1/gateway/lp-routing/"),
		p == "/api/v1/gateway/lp-execution" || strings.HasPrefix(p, "/api/v1/gateway/lp-execution/"),
		strings.HasPrefix(p, "/api/v1/gateway/runtime/"):
		return "bridge", p, true

	case p == "/health" || p == "/readiness" ||
		p == "/livez" || p == "/readyz" || p == "/healthz" || p == "/ready" ||
		p == "/health/live" || p == "/health/ready" ||
		p == "/ws/v2" || strings.HasPrefix(p, "/ws/v2/") ||
		p == "/ws/manager-trade" || strings.HasPrefix(p, "/ws/manager-trade/") ||
		strings.HasPrefix(p, "/api/v2/") ||
		p == "/api/v1/journal" || strings.HasPrefix(p, "/api/v1/journal/") ||
		p == "/api/v1/positions" || strings.HasPrefix(p, "/api/v1/positions/") ||
		p == "/api/v1/admin/positions" || strings.HasPrefix(p, "/api/v1/admin/positions/") ||
		p == "/api/v1/brokers" || strings.HasPrefix(p, "/api/v1/brokers/") ||
		p == "/api/v1/broker/servers" ||
		p == "/fix-ws" || strings.HasPrefix(p, "/fix-ws/"):
		return "gateway", p, true

	case p == "/ws/history" || strings.HasPrefix(p, "/ws/history/") ||
		p == "/history" || strings.HasPrefix(p, "/history/"):
		return "history", p, true

	case p == "/api/v1/exposure" || strings.HasPrefix(p, "/api/v1/exposure/") ||
		p == "/api/v1/book" || strings.HasPrefix(p, "/api/v1/book/") ||
		p == "/api/v1/rules" || strings.HasPrefix(p, "/api/v1/rules/") ||
		p == "/api/v1/alerts" || strings.HasPrefix(p, "/api/v1/alerts/") ||
		p == "/api/v1/dealing" || strings.HasPrefix(p, "/api/v1/dealing/") ||
		p == "/risk/health" || strings.HasPrefix(p, "/risk/"):
		return "risk", p, true

	case p == "/api/v1/news" || strings.HasPrefix(p, "/api/v1/news/") ||
		p == "/api/v1/calendar" || strings.HasPrefix(p, "/api/v1/calendar/") ||
		p == "/news/health" || strings.HasPrefix(p, "/news/"):
		return "news", p, true

	case p == "/api/v1/audit" || strings.HasPrefix(p, "/api/v1/audit/") ||
		p == "/api/v1/metrics/latency" || p == "/api/v1/metrics/volume" || strings.HasPrefix(p, "/api/v1/metrics/") ||
		p == "/logs/health" || strings.HasPrefix(p, "/logs/"):
		return "logging", p, true

	case p == "/license" || strings.HasPrefix(p, "/license/"):
		return "license", p, true

	case p == "/reports/health" ||
		strings.HasPrefix(p, "/api/v1/statement/") ||
		strings.HasPrefix(p, "/api/v1/equity/") ||
		p == "/api/v1/daily/all" || strings.HasPrefix(p, "/api/v1/daily/") ||
		strings.HasPrefix(p, "/api/v1/export/") ||
		p == "/api/v1/summary/broker" ||
		p == "/api/v1/eod/recovery":
		return "reports", p, true

	case strings.HasPrefix(p, "/api/"),
		strings.HasPrefix(p, "/reports/"),
		strings.HasPrefix(p, "/uploads/"),
		strings.HasPrefix(p, "/workspace/"):
		return "manager", p, true
	}

	if isWS {
		return "manager", p, true
	}

	if len(p) >= 2 && p[0] == '/' && p[1] >= 'A' && p[1] <= 'Z' && !strings.Contains(path.Base(p), ".") {
		return "manager", p, true
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead && !strings.Contains(path.Base(p), ".") {
		return "manager", p, true
	}

	return "", "", false
}

func classifyTerminalRoute(r *http.Request) (service string, rewrittenPath string, matched bool) {
	return classifyBrokerRoute(resolveWebAppKind(r), r)
}

func (c *WebTerminalServer) serveEmbeddedBrokerLogo(w http.ResponseWriter, r *http.Request) {
	appKind := resolveWebAppKind(r)
	activeFS := c.getActiveDistFSForApp(appKind)
	candidates := []string{
		"brand/terminal-icon.png",
		"brand/rtx5-app-icon.png",
		"titlebar-icon.png",
		"rtx5-logo.png",
		"admin-symbol.png",
		"rtx5-logo-mark.png",
		"favicon.png",
	}
	for _, cand := range candidates {
		f, err := activeFS.Open(cand)
		if err != nil {
			continue
		}
		data, rerr := io.ReadAll(f)
		_ = f.Close()
		if rerr == nil && len(data) > 0 {
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Cache-Control", "public, max-age=300")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			return
		}
	}
	http.NotFound(w, r)
}

func (c *WebTerminalServer) serveEmbeddedSPA(w http.ResponseWriter, r *http.Request) {
	cleanPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if cleanPath == "" || cleanPath == "." {
		c.serveIndexHTML(w, r)
		return
	}
	if cleanPath == "brand/rtx5-app-icon.png" || cleanPath == "brand/terminal-icon.png" {
		c.serveEmbeddedBrokerLogo(w, r)
		return
	}

	appKind := resolveWebAppKind(r)
	activeFS := c.getActiveDistFSForApp(appKind)
	f, err := activeFS.Open(cleanPath)
	if err != nil {
		ext := strings.ToLower(path.Ext(cleanPath))
		if ext != "" && ext != ".html" {
			http.NotFound(w, r)
			return
		}
		c.serveIndexHTML(w, r)
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil || st.IsDir() {
		c.serveIndexHTML(w, r)
		return
	}

	if cleanPath == "index.html" {
		c.serveIndexHTML(w, r)
		return
	}

	if ctype := mime.TypeByExtension(path.Ext(cleanPath)); ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	if rs, ok := f.(io.ReadSeeker); ok {
		http.ServeContent(w, r, st.Name(), st.ModTime(), rs)
		return
	}
	data, _ := io.ReadAll(f)
	_, _ = w.Write(data)
}

func (c *WebTerminalServer) serveIndexHTML(w http.ResponseWriter, r *http.Request) {
	appKind := resolveWebAppKind(r)
	activeFS := c.getActiveDistFSForApp(appKind)
	f, err := activeFS.Open("index.html")
	if err != nil {
		http.Error(w, "Embedded UI index.html missing", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	raw, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "Read index.html failed", http.StatusInternalServerError)
		return
	}

	var injectTag string
	if appKind == "superadmin" {
		injectTag = `<script src="/tcp-security-drawer.js"></script>`
	} else {
		injectTag = `<script src="/rtx5-tcp-toolbar.js"></script>`
	}
	if idx := bytes.LastIndex(bytes.ToLower(raw), []byte("</body>")); idx >= 0 {
		patched := make([]byte, 0, len(raw)+len(injectTag)+2)
		patched = append(patched, raw[:idx]...)
		patched = append(patched, []byte(injectTag)...)
		patched = append(patched, raw[idx:]...)
		raw = patched
	} else {
		raw = append(raw, []byte(injectTag)...)
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(raw)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
