// Package clientcore implements the shared Native Windows Desktop Client Engine for:
//   - RTX5-SuperAdmin64.exe (connects to SuperAdminIP:9100 via RoleSuperAdminClient)
//   - RTX5-Admin64.exe      (connects to BrokerServerIP:4443 via RoleBrokerAdminClient + :9100 Discovery)
//   - RTX5-Manager64.exe    (connects to BrokerServerIP:4443 via RoleBrokerManagerClient + :9100 Discovery)
//   - RTX5-Terminal64.exe   (connects to BrokerServerIP:4443 via RoleTraderTerminalClient + :9100 Discovery)
//
// Zero public HTTP/WS ports, zero domains, zero SSL certs, zero Nginx, zero Electron bloat:
//   1. Verifies native Win32 C rtx5_guard.dll BEFORE execution.
//   2. Maintains a persistent, auto-reconnecting Multiplexed Encrypted Binary TCP tunnel
//      (Magic: RTX\x05, X25519 Ephemeral ECDH + HKDF-SHA256 + Monotonic-Nonce AES-256-GCM).
//   3. Hosts an ephemeral 127.0.0.1-only loopback micro-bridge that serves the embedded React 19 UI
//      inside a standalone native chromeless desktop window (--app mode) and multiplexes 100% of
//      REST, SSE, and 22+ real-time WebSockets across the single Binary TCP socket!
package clientcore

import (
	"bytes"
	"crypto/ed25519"
	_ "embed"
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
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing/fstest"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

//go:embed security_drawer.js
var securityDrawerJS []byte

//go:embed tcp_toolbar.js
var tcpToolbarJS []byte

type AppKind string

const (
	KindSuperAdmin AppKind = "superadmin"
	KindAdmin      AppKind = "broker-admin"
	KindManager    AppKind = "broker-manager"
	KindTerminal   AppKind = "trader-terminal"
	KindMobile     AppKind = "mobile"
)

type AppConfig struct {
	Kind                  AppKind
	WindowTitle           string
	PeerRole              uint8
	DefaultTargetTCP      string // e.g., "127.0.0.1:9100" or "127.0.0.1:4443"
	DefaultSuperAdminTCP  string // e.g., "127.0.0.1:9100" for Broker directory discovery
	DefaultLocalAddr      string // e.g., "127.0.0.1:18400" (falls back to 127.0.0.1:0 if busy)
	DefaultBrokerID       string
	DefaultBrokerName     string
	EmbeddedDist          fs.FS
	HeadlessBridge        bool
	DataDir               string
}

type DiscoveredBroker struct {
	BrokerID   string `json:"broker_id"`
	BrokerName string `json:"broker_name"`
	TCPAddr    string `json:"tcp_addr"`
	Plan       string `json:"plan"`
	Online     bool   `json:"online"`
}

type DesktopClient struct {
	cfg             AppConfig
	dataDir         string
	distRoot        fs.FS
	localOrigin     string
	localHost       string
	localPort       int
	fastOrderOrigin string
	fastOrderPort   int

	guard        *rtx5tcp.NativeGuard
	hwidHex      string
	masterPubHex string
	ota          *clientOTAEngine
	binHub       *clientBinaryMarketHub

	mu                       sync.RWMutex
	targetTCPAddr            string
	superAdminTCP            string
	activeBrokerID           string
	activeBrokerName         string
	otaChannel               string
	cachedBrokers            []DiscoveredBroker
	cachedBrokersAt          time.Time
	activeMux                *rtx5tcp.MuxSession
	orderMux                 *rtx5tcp.MuxSession
	lastRTTMs                float64
	avgRTTMs                 float64
	uiCmd                    *exec.Cmd
	dialMu                   sync.Mutex
	orderDialMu              sync.Mutex
	dirRefreshMu             sync.Mutex
	orderFastLaneUnsupported atomic.Bool
	cachedOrderAuthToken     atomic.Value // stores string
}

// tcpNoDelayListener wraps the local 127.0.0.1 loopback net.Listener so every
// accepted WebView2 / Chromium TCP connection disables Nagle (TCP_NODELAY) and
// expands kernel socket buffers to 256 KiB, eliminating 15-40 ms loopback delays.
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

func Run(cfg AppConfig) {
	defaultOTAChannel := normalizeOTAChannel(os.Getenv("RTX5_OTA_CHANNEL"))
	targetVal := cfg.DefaultTargetTCP
	saVal := cfg.DefaultSuperAdminTCP
	localVal := cfg.DefaultLocalAddr
	brokerIDVal := cfg.DefaultBrokerID
	brokerNameVal := cfg.DefaultBrokerName
	otaChannelVal := defaultOTAChannel
	headlessVal := cfg.HeadlessBridge || cfg.Kind == KindMobile || os.Getenv("RTX5_HEADLESS") == "1"
	guardPathVal := ""

	targetFlag := &targetVal
	saFlag := &saVal
	localFlag := &localVal
	brokerIDFlag := &brokerIDVal
	brokerNameFlag := &brokerNameVal
	otaChannelFlag := &otaChannelVal
	headlessFlag := &headlessVal
	guardPathFlag := &guardPathVal

	if cfg.Kind != KindMobile || runtime.GOOS == "windows" {
		targetFlag = flag.String("server", cfg.DefaultTargetTCP, "Target Encrypted Binary TCP Server (IP:Port)")
		saFlag = flag.String("superadmin", cfg.DefaultSuperAdminTCP, "Super Admin Encrypted Binary TCP Hub (:9100) for Broker Discovery")
		localFlag = flag.String("local-addr", cfg.DefaultLocalAddr, "127.0.0.1 loopback UI bridge address")
		brokerIDFlag = flag.String("broker-id", cfg.DefaultBrokerID, "Initial Broker ID")
		brokerNameFlag = flag.String("broker-name", cfg.DefaultBrokerName, "Initial Broker Name / Server label")
		otaChannelFlag = flag.String("ota-channel", defaultOTAChannel, "OTA release channel (alpha, beta, production)")
		headlessFlag = flag.Bool("headless", headlessVal, "Run local encrypted TCP bridge without launching desktop GUI window")
		guardPathFlag = flag.String("guard-dll", "", "Optional path to rtx5_guard.dll")
		flag.Parse()
	}

	exePath, err := os.Executable()
	exeDir := ""
	if err == nil && exePath != "" {
		exeDir = filepath.Dir(exePath)
	}
	dataDir := strings.TrimSpace(os.Getenv("RTX5_MOBILE_DATA_DIR"))
	if dataDir == "" {
		dataDir = strings.TrimSpace(cfg.DataDir)
	}
	if dataDir == "" {
		dataDir = exeDir
	}
	if exeDir == "" {
		exeDir = dataDir
	}
	_ = os.MkdirAll(dataDir, 0755)

	// Load client-config.json from dataDir (or adjacent to .exe) if present
	cfgFilePath := filepath.Join(dataDir, "client-config.json")
	if _, serr := os.Stat(cfgFilePath); serr != nil {
		cfgFilePath = filepath.Join(exeDir, "client-config.json")
	}
	if rawCfg, rerr := os.ReadFile(cfgFilePath); rerr == nil && len(rawCfg) > 0 {
		var fileCfg struct {
			ServerTCP     string `json:"server_tcp"`
			SuperAdminTCP string `json:"superadmin_tcp"`
			BrokerID      string `json:"broker_id"`
			BrokerName    string `json:"broker_name"`
			OTAChannel    string `json:"ota_channel"`
		}
		if json.Unmarshal(rawCfg, &fileCfg) == nil {
			if fileCfg.ServerTCP != "" && *targetFlag == cfg.DefaultTargetTCP {
				*targetFlag = fileCfg.ServerTCP
			}
			if fileCfg.SuperAdminTCP != "" && *saFlag == cfg.DefaultSuperAdminTCP {
				*saFlag = fileCfg.SuperAdminTCP
			}
			if fileCfg.BrokerID != "" && *brokerIDFlag == cfg.DefaultBrokerID {
				*brokerIDFlag = fileCfg.BrokerID
			}
			if fileCfg.BrokerName != "" && *brokerNameFlag == cfg.DefaultBrokerName {
				*brokerNameFlag = fileCfg.BrokerName
			}
			if fileCfg.OTAChannel != "" && *otaChannelFlag == defaultOTAChannel {
				*otaChannelFlag = normalizeOTAChannel(fileCfg.OTAChannel)
			}
		}
	}
	*otaChannelFlag = normalizeOTAChannel(*otaChannelFlag)

	// Verify & Load Native Win32 C Security Guard DLL (rtx5_guard.dll)
	dllPath := *guardPathFlag
	if dllPath == "" {
		candidates := []string{
			filepath.Join(exeDir, "rtx5_guard.dll"),
			filepath.Join(exeDir, "..", "rtx5_guard.dll"),
		}
		for _, c := range candidates {
			if _, serr := os.Stat(c); serr == nil {
				dllPath = c
				break
			}
		}
	}
	if dllPath == "" {
		if extracted, eerr := ensureEmbeddedGuardDLL(); eerr == nil && extracted != "" {
			dllPath = extracted
		}
	}

	var masterPub ed25519.PublicKey
	var dllSigHex string
	parseAuthorityJSON := func(raw []byte) bool {
		var doc struct {
			Ed25519MasterPubHex string `json:"ed25519_master_pub_hex"`
			Ed25519PublicHex    string `json:"ed25519_public_hex"`
			GuardDLLSigHex      string `json:"guard_dll_sig_hex"`
			GuardDLLEdSigHex    string `json:"guard_dll_ed25519_sig_hex"`
		}
		if json.Unmarshal(raw, &doc) != nil {
			return false
		}
		pubHex := strings.TrimSpace(doc.Ed25519MasterPubHex)
		if pubHex == "" {
			pubHex = strings.TrimSpace(doc.Ed25519PublicHex)
		}
		sigHex := strings.TrimSpace(doc.GuardDLLSigHex)
		if sigHex == "" {
			sigHex = strings.TrimSpace(doc.GuardDLLEdSigHex)
		}
		if pb, derr := hex.DecodeString(pubHex); derr == nil && len(pb) == ed25519.PublicKeySize {
			masterPub = ed25519.PublicKey(pb)
			dllSigHex = sigHex
			return true
		}
		return false
	}
	authCandidates := []string{
		filepath.Join(exeDir, "authority-pub.json"),
		filepath.Join(exeDir, "..", "..", "runtime-data", "secrets", "shared-authority.json"),
	}
	for _, ac := range authCandidates {
		if raw, rerr := os.ReadFile(ac); rerr == nil && parseAuthorityJSON(raw) {
			break
		}
	}
	if len(masterPub) == 0 && len(embeddedAuthorityPubJSON) > 0 {
		parseAuthorityJSON(embeddedAuthorityPubJSON)
	}

	guard, err := rtx5tcp.LoadVerifiedNativeGuard(dllPath, masterPub, dllSigHex)
	if err != nil {
		fatalStartupError("[FATAL-SECURITY] rtx5_guard.dll integrity check failed: %v", err)
	}
	hwidHex, _, err := guard.CollectHardwareFingerprint()
	if err != nil {
		fatalStartupError("[FATAL-SECURITY] Hardware fingerprint check failed: %v", err)
	}

	var subFS fs.FS
	if cfg.EmbeddedDist != nil {
		sfs, serr := fs.Sub(cfg.EmbeddedDist, "dist")
		if serr == nil {
			subFS = sfs
		}
	}
	if subFS == nil {
		subFS = fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("<!doctype html><html><body>RTX5 Encrypted Binary TCP Bridge Active</body></html>")},
		}
	}

	// Bind strictly to 127.0.0.1 loopback (never exposed on LAN/WAN!)
	ln, err := net.Listen("tcp", *localFlag)
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatalf("Failed to bind loopback desktop bridge: %v", err)
		}
	}
	tcpAddr := ln.Addr().(*net.TCPAddr)
	ln = tcpNoDelayListener{Listener: ln}
	localOrigin := fmt.Sprintf("http://127.0.0.1:%d", tcpAddr.Port)

	// Bind a dedicated 2nd loopback port strictly for 128-byte binary order execution
	// so Chromium's 6-connection-per-origin HTTP/1.1 pool on localOrigin (held by
	// /__rtx5_binary_stream + /positions + /account/deals + /journal) NEVER blocks One-Click orders!
	fastOrderOrigin := localOrigin
	fastOrderPort := tcpAddr.Port
	var fastLn net.Listener
	rawFastLn, ferr := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", tcpAddr.Port+10))
	if ferr != nil {
		rawFastLn, ferr = net.Listen("tcp", "127.0.0.1:0")
	}
	if ferr == nil && rawFastLn != nil {
		fastAddr := rawFastLn.Addr().(*net.TCPAddr)
		fastLn = tcpNoDelayListener{Listener: rawFastLn}
		fastOrderOrigin = fmt.Sprintf("http://127.0.0.1:%d", fastAddr.Port)
		fastOrderPort = fastAddr.Port
	}

	dc := &DesktopClient{
		cfg:              cfg,
		dataDir:          dataDir,
		distRoot:         subFS,
		localOrigin:      localOrigin,
		localHost:        "127.0.0.1",
		localPort:        tcpAddr.Port,
		fastOrderOrigin:  fastOrderOrigin,
		fastOrderPort:    fastOrderPort,
		guard:            guard,
		hwidHex:          hwidHex,
		masterPubHex:     hex.EncodeToString(masterPub),
		targetTCPAddr:    strings.TrimSpace(*targetFlag),
		superAdminTCP:    strings.TrimSpace(*saFlag),
		activeBrokerID:   strings.TrimSpace(*brokerIDFlag),
		activeBrokerName: strings.TrimSpace(*brokerNameFlag),
		otaChannel:       normalizeOTAChannel(*otaChannelFlag),
		binHub:           newClientBinaryMarketHub(),
	}
	dc.initOTAEngine(exePath, dc.masterPubHex)

	// Refresh Broker directory cache asynchronously on startup (never blocking UI launch on :9100 dial!)
	if cfg.Kind != KindSuperAdmin {
		go dc.refreshBrokerDirectory(true)
	}

	// Warm initial Encrypted Binary TCP connection + background Ping RTT + Ed25519 OTA poller
	go dc.backgroundReconnectLoop()
	go dc.runBackgroundOTALoop()

	log.Printf("[%s] Guard DLL Verified (%.12s..) | Local Loopback Bridge: %s (FastOrder: %s) ===> Binary TCP (Magic: RTX\\x05): %s",
		cfg.WindowTitle, guard.DLLSHA256(), localOrigin, fastOrderOrigin, dc.getTargetTCP())

	httpSrv := &http.Server{
		Handler:           http.HandlerFunc(dc.serveHTTP),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       180 * time.Second,
	}
	go func() {
		if serr := httpSrv.Serve(ln); serr != nil && serr != http.ErrServerClosed {
			log.Fatalf("Local desktop bridge stopped: %v", serr)
		}
	}()

	if fastLn != nil {
		fastOrderSrv := &http.Server{
			Handler:           http.HandlerFunc(dc.serveFastOrderHTTP),
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       180 * time.Second,
		}
		go func() {
			if serr := fastOrderSrv.Serve(fastLn); serr != nil && serr != http.ErrServerClosed {
				log.Printf("Fast binary order loopback bridge stopped: %v", serr)
			}
		}()
	}

	if cfg.Kind == KindMobile && runtime.GOOS != "windows" {
		select {}
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	if !*headlessFlag {
		// Launch native Win32 window + embedded WebView2 controller directly inside this .exe process (just like MT5 terminal64.exe)
		if dc.runNativeWin32Window(localOrigin, string(cfg.Kind), exeDir, sigCh) {
			return
		}
		// Fallback only if WebView2 runtime is missing on bare server OS
		uiCmd := launchStandaloneAppWindow(localOrigin, string(cfg.Kind), exeDir)
		dc.mu.Lock()
		dc.uiCmd = uiCmd
		dc.mu.Unlock()
		if uiCmd != nil {
			startTime := time.Now()
			doneCh := make(chan error, 1)
			go func() {
				doneCh <- uiCmd.Wait()
			}()
			select {
			case <-sigCh:
				_ = uiCmd.Process.Kill()
			case <-doneCh:
				// If browser delegated to an existing process (< 3s), keep loopback server alive until SIGINT/SIGTERM
				if time.Since(startTime) < 3*time.Second {
					<-sigCh
				}
			}
			return
		}
	}

	<-sigCh
}

func (c *DesktopClient) getTargetTCP() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.targetTCPAddr
}

func (c *DesktopClient) getOrDialSession() (*rtx5tcp.MuxSession, error) {
	c.mu.RLock()
	sess := c.activeMux
	c.mu.RUnlock()
	if sess != nil {
		select {
		case <-sess.Done():
		default:
			return sess, nil
		}
	}

	c.dialMu.Lock()
	defer c.dialMu.Unlock()

	c.mu.RLock()
	sess = c.activeMux
	target := c.targetTCPAddr
	c.mu.RUnlock()
	if sess != nil {
		select {
		case <-sess.Done():
		default:
			return sess, nil
		}
	}

	tc, err := rtx5tcp.DialTunnel(target, c.cfg.PeerRole, 8*time.Second)
	if err != nil && c.cfg.Kind == KindSuperAdmin {
		for _, fallback := range []string{c.superAdminTCP, "51.195.188.172:9100", "127.0.0.1:9100"} {
			fallback = strings.TrimSpace(fallback)
			if fallback == "" || strings.EqualFold(fallback, target) {
				continue
			}
			if ftc, ferr := rtx5tcp.DialTunnel(fallback, c.cfg.PeerRole, 5*time.Second); ferr == nil {
				tc = ftc
				err = nil
				target = fallback
				c.mu.Lock()
				c.targetTCPAddr = fallback
				c.superAdminTCP = fallback
				c.mu.Unlock()
				break
			}
		}
	}
	if err != nil {
		return nil, err
	}
	newSess := rtx5tcp.NewMuxSession(tc, false, nil, c.handleServerControlFrame)
	c.mu.Lock()
	c.activeMux = newSess
	c.mu.Unlock()

	go func(s *rtx5tcp.MuxSession, addr string) {
		_ = s.ServeLoop()
		c.mu.Lock()
		if c.activeMux == s {
			c.activeMux = nil
		}
		c.mu.Unlock()
	}(newSess, target)

	go c.rebindBinaryAccountSub(newSess)

	return newSess, nil
}

func (c *DesktopClient) backgroundReconnectLoop() {
	firstBoot := true
	lastDirRefresh := time.Now()
	for {
		warmOrderFastLane := c.cfg.Kind == KindTerminal || c.cfg.Kind == KindManager || c.cfg.Kind == KindMobile
		var wg sync.WaitGroup
		if firstBoot && warmOrderFastLane {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, _ = c.getOrDialOrderSession()
			}()
		}

		if sess, err := c.getOrDialSession(); err == nil && sess != nil {
			if rtt, perr := sess.MeasurePingRTT(2 * time.Second); perr == nil && rtt > 0 {
				c.mu.Lock()
				c.lastRTTMs = rtt
				if c.avgRTTMs <= 0 {
					c.avgRTTMs = rtt
				} else {
					c.avgRTTMs = c.avgRTTMs*0.7 + rtt*0.3
				}
				c.mu.Unlock()
			}
		}

		if firstBoot && warmOrderFastLane {
			wg.Wait()
			firstBoot = false
		} else if warmOrderFastLane {
			c.mu.RLock()
			actSess := c.activeMux
			c.mu.RUnlock()
			if orderSess, oerr := c.getOrDialOrderSession(); oerr == nil && orderSess != nil && orderSess != actSess {
				_, _ = orderSess.MeasurePingRTT(1500 * time.Millisecond)
			}
		}

		if c.cfg.Kind != KindSuperAdmin && time.Since(lastDirRefresh) >= 5*time.Second {
			lastDirRefresh = time.Now()
			go c.refreshBrokerDirectory(false)
		}
		time.Sleep(3 * time.Second)
	}
}

func (c *DesktopClient) resolveBrokerFromCache(brokerID, brokerName, tcpAddr string) (string, string, string) {
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
	if !ok && c.cfg.Kind != KindSuperAdmin && c.superAdminTCP != "" && (brokerID != "" || brokerName != "") {
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

func (c *DesktopClient) switchBrokerTarget(brokerID, brokerName, tcpAddr string) {
	brokerID, brokerName, tcpAddr = c.resolveBrokerFromCache(brokerID, brokerName, tcpAddr)
	c.orderFastLaneUnsupported.Store(false)
	c.mu.Lock()
	if tcpAddr != "" {
		c.targetTCPAddr = tcpAddr
	}
	if brokerID != "" {
		c.activeBrokerID = brokerID
	}
	if brokerName != "" {
		c.activeBrokerName = brokerName
	}
	old := c.activeMux
	c.activeMux = nil
	oldOrder := c.orderMux
	c.orderMux = nil
	c.mu.Unlock()

	if old != nil {
		_ = old.Close()
	}
	if oldOrder != nil && oldOrder != old {
		_ = oldOrder.Close()
	}
	if c.binHub != nil {
		c.binHub.clearCache()
	}
	c.persistClientConfig()
	dialDone := make(chan struct{})
	go func() {
		defer close(dialDone)
		if c.cfg.Kind == KindTerminal || c.cfg.Kind == KindManager || c.cfg.Kind == KindMobile {
			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				_, _ = c.getOrDialSession()
			}()
			go func() {
				defer wg.Done()
				_, _ = c.getOrDialOrderSession()
			}()
			wg.Wait()
		} else {
			_, _ = c.getOrDialSession()
		}
	}()
	select {
	case <-dialDone:
	case <-time.After(300 * time.Millisecond):
	}
}

func (c *DesktopClient) persistClientConfig() {
	baseDir := strings.TrimSpace(c.dataDir)
	if baseDir == "" {
		exePath, err := os.Executable()
		if err != nil {
			return
		}
		baseDir = filepath.Dir(exePath)
	}
	cfgFilePath := filepath.Join(baseDir, "client-config.json")
	c.mu.RLock()
	doc := map[string]string{
		"server_tcp":     c.targetTCPAddr,
		"superadmin_tcp": c.superAdminTCP,
		"broker_id":      c.activeBrokerID,
		"broker_name":    c.activeBrokerName,
		"ota_channel":    normalizeOTAChannel(c.otaChannel),
		"protocol":       "RTX5-BINARY-TCP-V2",
		"magic_hex":      "52545805",
	}
	c.mu.RUnlock()
	if raw, merr := json.MarshalIndent(doc, "", "    "); merr == nil {
		_ = os.WriteFile(cfgFilePath, raw, 0644)
	}
}

func (c *DesktopClient) maybeRefreshBrokerDirectoryOnRequest() {
	if c.cfg.Kind == KindSuperAdmin {
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
	waitTimeout := 450 * time.Millisecond
	if count == 0 {
		waitTimeout = 1600 * time.Millisecond
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.refreshBrokerDirectory(false)
	}()
	select {
	case <-done:
	case <-time.After(waitTimeout):
	}
}

// querySuperAdminBrokerDirectory dials SuperAdmin (:9100) over Encrypted Binary TCP (RoleDiscoveryProbe)
// and fetches the live directory of active licensed Brokers (FrameBrokerDirectoryReq -> FrameBrokerDirectoryResp).
func (c *DesktopClient) querySuperAdminBrokerDirectory() ([]DiscoveredBroker, error) {
	c.mu.RLock()
	saAddr := strings.TrimSpace(c.superAdminTCP)
	targetAddr := strings.TrimSpace(c.targetTCPAddr)
	c.mu.RUnlock()

	var candidates []string
	addCandidate := func(addr string) {
		addr = strings.TrimSpace(addr)
		if addr == "" {
			return
		}
		for _, existing := range candidates {
			if strings.EqualFold(existing, addr) {
				return
			}
		}
		candidates = append(candidates, addr)
	}
	addCandidate(saAddr)
	if host, _, err := net.SplitHostPort(targetAddr); err == nil && host != "" {
		addCandidate(net.JoinHostPort(host, "9100"))
	}
	addCandidate("51.195.188.172:9100")
	addCandidate("127.0.0.1:9100")

	var lastErr error
	for _, cand := range candidates {
		tc, err := rtx5tcp.DialTunnel(cand, rtx5tcp.RoleDiscoveryProbe, 1200*time.Millisecond)
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
	return nil, fmt.Errorf("no superadmin broker directory reachable")
}

func (c *DesktopClient) refreshBrokerDirectory(initial bool) {
	if c.cfg.Kind == KindSuperAdmin {
		return
	}
	c.dirRefreshMu.Lock()
	defer c.dirRefreshMu.Unlock()
	list, err := c.querySuperAdminBrokerDirectory()
	if err != nil || len(list) == 0 {
		return
	}
	if !initial {
		return
	}
	c.mu.Lock()
	matched := false
	for _, b := range list {
		if strings.EqualFold(b.BrokerID, c.activeBrokerID) {
			matched = true
			if c.activeBrokerName == "" {
				c.activeBrokerName = b.BrokerName
			}
			break
		}
	}
	// The built-in default broker (or a saved one) is only a starting point. When SuperAdmin's
	// directory does not list it, move to the first online listed broker so the login page
	// shows real brokers instead of a stale default.
	var pick *DiscoveredBroker
	if !matched {
		pick = &list[0]
		for i := range list {
			if list[i].Online {
				pick = &list[i]
				break
			}
		}
	}
	c.mu.Unlock()
	if pick != nil {
		go c.switchBrokerTarget(pick.BrokerID, pick.BrokerName, pick.TCPAddr)
	}
}

func (c *DesktopClient) getCachedBrokerDirectory() []DiscoveredBroker {
	c.mu.RLock()
	if len(c.cachedBrokers) > 0 {
		out := make([]DiscoveredBroker, len(c.cachedBrokers))
		copy(out, c.cachedBrokers)
		c.mu.RUnlock()
		return out
	}
	curID := c.activeBrokerID
	curName := c.activeBrokerName
	curTCP := c.targetTCPAddr
	c.mu.RUnlock()
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

func (c *DesktopClient) getFastOrderWSURL() string {
	return strings.Replace(c.localOrigin, "http://", "ws://", 1) + "/__rtx5_binary_order_ws"
}

func (c *DesktopClient) requestOrigin(r *http.Request) (httpOrigin, wsOrigin, hostOnly string, port int) {
	if r == nil || strings.TrimSpace(r.Host) == "" {
		return c.localOrigin, strings.Replace(c.localOrigin, "http://", "ws://", 1), c.localHost, c.localPort
	}
	scheme := "http"
	wsScheme := "ws"
	if r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
		scheme = "https"
		wsScheme = "wss"
	}
	hostHeader := strings.TrimSpace(r.Host)
	h, pStr, err := net.SplitHostPort(hostHeader)
	if err != nil {
		h = hostHeader
		port = c.localPort
	} else {
		if pNum, perr := strconv.Atoi(pStr); perr == nil && pNum > 0 {
			port = pNum
		} else {
			port = c.localPort
		}
	}
	if h == "" {
		h = c.localHost
	}
	return scheme + "://" + hostHeader, wsScheme + "://" + hostHeader, h, port
}

func (c *DesktopClient) serveFastOrderHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/__rtx5_binary_order_ws":
		c.serveLocalBinaryOrderWS(w, r)
	case "/__rtx5_binary_account_sub":
		c.serveLocalBinaryAccountSub(w, r)
	case "/__rtx5_binary_order":
		c.serveLocalBinaryOrder(w, r)
	default:
		c.serveLocalBinaryOrder(w, r)
	}
}

func (c *DesktopClient) serveHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path

	// 1. Injected Desktop Client Helper Scripts, Native Binary Market Stream & Diagnostics
	switch p {
	case "/__rtx5_binary_stream":
		c.serveLocalBinaryMarketStream(w, r)
		return

	case "/__rtx5_binary_order_ws":
		c.serveLocalBinaryOrderWS(w, r)
		return

	case "/__rtx5_binary_order":
		c.serveLocalBinaryOrder(w, r)
		return

	case "/__rtx5_binary_account_sub":
		c.serveLocalBinaryAccountSub(w, r)
		return

	case "/tcp-security-drawer.js":
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(securityDrawerJS)
		return

	case "/rtx5-tcp-toolbar.js":
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(tcpToolbarJS)
		return

	case "/api/tcp-client/status":
		c.mu.RLock()
		sess := c.activeMux
		target := c.targetTCPAddr
		bid := c.activeBrokerID
		bnm := c.activeBrokerName
		rttMs := c.lastRTTMs
		avgRttMs := c.avgRTTMs
		c.mu.RUnlock()
		connected := false
		if sess != nil {
			select {
			case <-sess.Done():
			default:
				connected = true
				if rttMs <= 0 {
					rttMs = sess.LastRTTMs()
				}
			}
		}
		dllSHA := ""
		if c.guard != nil {
			dllSHA = c.guard.DLLSHA256()
		}
		hwidPref := c.hwidHex
		if len(hwidPref) > 16 {
			hwidPref = hwidPref[:16]
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"app":               c.cfg.Kind,
			"connected":         connected,
			"magic":             "RTX\\x05 (0x52 0x54 0x58 0x05)",
			"cipher":            "X25519 + HKDF-SHA256 + AES-256-GCM",
			"target_tcp":        target,
			"fast_order_origin": c.fastOrderOrigin,
			"fast_order_ws_url": c.getFastOrderWSURL(),
			"broker_id":         bid,
			"broker_name":       bnm,
			"rtt_ms":            rttMs,
			"avg_rtt_ms":        avgRttMs,
			"dll_verified":      true,
			"dll_sha256":        dllSHA,
			"hwid_prefix":       hwidPref,
			"ota":               c.getOTAStatusSnapshot(),
		})
		return

	case "/api/tcp-client/ota-check":
		err := c.checkAndApplyOTA()
		snap := c.getOTAStatusSnapshot()
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
			ch := normalizeOTAChannel(req.Channel)
			c.mu.Lock()
			c.otaChannel = ch
			c.mu.Unlock()
			if c.ota != nil {
				c.ota.mu.Lock()
				c.ota.channel = ch
				c.ota.mu.Unlock()
			}
			c.persistClientConfig()
			go func() {
				_ = c.checkAndApplyOTA()
			}()
		}
		snap := c.getOTAStatusSnapshot()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"channel": snap.Channel,
			"ota":     snap,
		})
		return

	case "/api/tcp-client/ota-ack-ui":
		if c.ota != nil {
			c.ota.mu.Lock()
			c.ota.uiReloadReady = false
			c.ota.mu.Unlock()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return

	case "/api/tcp-client/save-file":
		if r.Method == http.MethodPost {
			var req struct {
				Filename string `json:"filename"`
				Content  string `json:"content"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err == nil && req.Content != "" {
				fname := filepath.Base(strings.TrimSpace(req.Filename))
				if fname == "" || fname == "." {
					fname = "broker.lic"
				}
				var savedPaths []string
				if exePath, eerr := os.Executable(); eerr == nil {
					exeDir := filepath.Dir(exePath)
					p1 := filepath.Join(exeDir, fname)
					if os.WriteFile(p1, []byte(req.Content), 0644) == nil {
						savedPaths = append(savedPaths, p1)
					}
					p2 := filepath.Join(exeDir, "broker.lic")
					if p2 != p1 && os.WriteFile(p2, []byte(req.Content), 0644) == nil {
						savedPaths = append(savedPaths, p2)
					}
				}
				if userHome, herr := os.UserHomeDir(); herr == nil && userHome != "" {
					dlDir := filepath.Join(userHome, "Downloads")
					_ = os.MkdirAll(dlDir, 0755)
					p3 := filepath.Join(dlDir, fname)
					if os.WriteFile(p3, []byte(req.Content), 0644) == nil {
						savedPaths = append(savedPaths, p3)
					}
					p4 := filepath.Join(dlDir, "broker.lic")
					if p4 != p3 && os.WriteFile(p4, []byte(req.Content), 0644) == nil {
						savedPaths = append(savedPaths, p4)
					}
				}
				writeJSON(w, http.StatusOK, map[string]any{"ok": true, "saved_paths": savedPaths})
				return
			}
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false})
		return

	case "/api/tcp-client/ota-restart":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := c.restartIntoUpdatedExe(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return

	case "/api/tcp-client/brokers":
		c.maybeRefreshBrokerDirectoryOnRequest()
		writeJSON(w, http.StatusOK, c.getCachedBrokerDirectory())
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
		c.switchBrokerTarget(bid, bnm, tAddr)
		c.mu.RLock()
		activeID := c.activeBrokerID
		activeName := c.activeBrokerName
		activeTCP := c.targetTCPAddr
		c.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          true,
			"broker_id":   activeID,
			"broker_name": activeName,
			"tcp_addr":    activeTCP,
			"target_tcp":  activeTCP,
		})
		return

	case "/api/tcp-client/quit":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		go func() {
			time.Sleep(100 * time.Millisecond)
			c.mu.RLock()
			cmd := c.uiCmd
			c.mu.RUnlock()
			if cmd != nil && cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			os.Exit(0)
		}()
		return
	}

	// 2. Dynamic /runtime-config.js for Broker Desktop Clients (Admin, Manager, Terminal)
	if c.cfg.Kind != KindSuperAdmin && p == "/runtime-config.js" {
		c.serveBrokerRuntimeConfigJS(w)
		return
	}

	// 3. Broker Directory Discovery, Direct TCP Health Check & Embedded Brand Logo Endpoints for Terminal / Admin / Manager
	if c.cfg.Kind != KindSuperAdmin && r.Method == http.MethodGet {
		normP := strings.TrimPrefix(p, "/ext-api")
		if normP == "/health" {
			if sess, err := c.getOrDialSession(); err == nil && sess != nil {
				c.mu.RLock()
				bid := c.activeBrokerID
				bnm := c.activeBrokerName
				tAddr := c.targetTCPAddr
				c.mu.RUnlock()
				writeJSON(w, http.StatusOK, map[string]any{
					"status":        "ok",
					"tcp_connected": true,
					"broker_id":     bid,
					"broker_name":   bnm,
					"target_tcp":    tAddr,
				})
				return
			}
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"status":        "offline",
				"tcp_connected": false,
			})
			return
		}
		if normP == "/api/v2/broker/servers" || normP == "/api/v1/broker/servers" {
			c.maybeRefreshBrokerDirectoryOnRequest()
			c.serveBrokerDirectoryPayload(w, true)
			return
		}
		if normP == "/api/v2/brokers" || normP == "/api/v1/brokers" {
			c.maybeRefreshBrokerDirectoryOnRequest()
			c.serveBrokerDirectoryPayload(w, false)
			return
		}
		if (strings.HasPrefix(normP, "/api/v1/brokers/") || strings.HasPrefix(normP, "/api/v2/brokers/")) && strings.HasSuffix(normP, "/logo") {
			c.serveEmbeddedBrokerLogo(w, r)
			return
		}
	}

	// 4. Route API, SSE & WebSocket traffic over Multiplexed Encrypted Binary TCP!
	if c.cfg.Kind == KindSuperAdmin {
		if svc, rewritten, ok := classifySuperAdminRoute(r); ok {
			c.proxyOverBinaryTCP(w, r, svc, rewritten)
			return
		}
	} else {
		if svc, rewritten, ok := classifyBrokerRoute(c.cfg.Kind, r); ok {
			c.proxyOverBinaryTCP(w, r, svc, rewritten)
			return
		}
	}

	// 5. Serve Embedded React 19 Static Assets & SPA index.html
	c.serveEmbeddedSPA(w, r)
}

func (c *DesktopClient) serveBrokerRuntimeConfigJS(w http.ResponseWriter) {
	c.mu.RLock()
	bid := c.activeBrokerID
	bnm := c.activeBrokerName
	target := c.targetTCPAddr
	c.mu.RUnlock()
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
	wsOrigin := strings.Replace(c.localOrigin, "http://", "ws://", 1)

	fastOrderURL := c.fastOrderOrigin + "/__rtx5_binary_order"
	if c.fastOrderOrigin == "" {
		fastOrderURL = c.localOrigin + "/__rtx5_binary_order"
	}
	fastOrderWSURL := c.getFastOrderWSURL()

	cfgMap := map[string]any{
		"CONFIG_SOURCE":             "runtime",
		"BACKEND_TARGET":            "desktop",
		"BACKEND_MODE":              "desktop",
		"LOCAL_BACKEND":             "true",
		"API_HOST":                  c.localOrigin,
		"API_URL":                   c.localOrigin,
		"API_HOST_EXT":              c.localOrigin,
		"BINARY_ORDER_URL":          fastOrderURL,
		"BINARY_ORDER_WS_URL":       fastOrderWSURL,
		"WS_HOST":                   wsOrigin,
		"WS_URL":                    wsOrigin,
		"DISCOVERY_BASE_URL":        c.localOrigin,
		"BROKER_DISCOVERY_URL":      c.localOrigin,
		"SHARED_DISCOVERY_BASE_URL": c.localOrigin,
		"BROKER_ALLOWED_ORIGINS":    c.localOrigin,
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
			"var q=function(){try{fetch('/api/tcp-client/quit',{method:'POST',keepalive:true});}catch(_){}try{window.close();}catch(_){}};"+
			"window.rtx5DesktopQuit=q;"+
			"window.rtx5Electron=Object.assign({},window.rtx5Electron,{isDesktop:true,platform:'win32',quit:q});"+
			"window.electronAPI=Object.assign({},window.electronAPI,{isDesktop:true,platform:'win32',quit:q});"+
			"window.electron=Object.assign({},window.electron,{app:{quit:q}});"+
			"})();\n",
		string(b),
	)
	_, _ = w.Write([]byte(js))
}

func (c *DesktopClient) serveBrokerDirectoryPayload(w http.ResponseWriter, asArray bool) {
	wsOrigin := strings.Replace(c.localOrigin, "http://", "ws://", 1)
	list := c.getCachedBrokerDirectory()

	c.mu.RLock()
	curTCP := c.targetTCPAddr
	c.mu.RUnlock()

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
		logoURL := ""
		switch c.cfg.Kind {
		case KindTerminal, KindMobile:
			logoURL = c.localOrigin + "/brand/terminal-icon.png"
		case KindManager:
			logoURL = c.localOrigin + "/rtx5-logo.png"
		case KindAdmin:
			logoURL = c.localOrigin + "/admin-symbol.png"
		}
		items = append(items, map[string]any{
			"id":                  b.BrokerID,
			"broker_id":           b.BrokerID,
			"broker_name":         b.BrokerName,
			"name":                b.BrokerName,
			"server":              b.BrokerName,
			"server_name":         displayServer,
			"display_server":      displayServer,
			"server_display":      displayServer,
			"display_server_name": displayServer,
			"logo_url":            logoURL,
			"server_ip":           c.localHost,
			"server_port":         c.localPort,
			"protocol":            "http",
			"server_url":          c.localOrigin,
			"backend_url":         c.localOrigin,
			"market_api_url":      c.localOrigin,
			"API_HOST":              c.localOrigin,
			"API_HOST_EXT":          c.localOrigin,
			"ws_url":                wsOrigin + "/ws/v2",
			"trade_ws_url":          wsOrigin + "/ws/v2",
			"trade_wss_url":         wsOrigin + "/ws/v2",
			"feed_url":              wsOrigin + "/ws/feed",
			"feed_ws_url":           wsOrigin + "/ws/feed",
			"feed_wss_url":          wsOrigin + "/ws/feed",
			"feed_status_url":       c.localOrigin + "/ws/feed/status",
			"feed_status_https_url": c.localOrigin + "/ws/feed/status",
			"services_domain":       fmt.Sprintf("%s:%d", c.localHost, c.localPort),
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

func (c *DesktopClient) proxyOverBinaryTCP(w http.ResponseWriter, r *http.Request, targetService string, rewrittenPath string) {
	sess, err := c.getOrDialSession()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": fmt.Sprintf("Encrypted Binary TCP Server (%s) unreachable: %v", c.getTargetTCP(), err),
		})
		return
	}
	clone := r.Clone(r.Context())
	clone.URL.Path = rewrittenPath
	clone.RequestURI = ""
	if c.cfg.DefaultLocalAddr != "" {
		if orig := clone.Header.Get("Origin"); strings.HasPrefix(orig, "http://127.0.0.1:") || strings.HasPrefix(orig, "http://localhost:") {
			clone.Header.Set("Origin", "http://"+c.cfg.DefaultLocalAddr)
		}
	}
	sess.ProxyHTTP(w, clone, targetService)
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

func classifyBrokerRoute(kind AppKind, r *http.Request) (service string, rewrittenPath string, matched bool) {
	p := r.URL.Path
	isWS := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")

	// Unwrap /ext-api, /api/manager, /manager, /Manager prefixes cleanly
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
	//   and /api/v2/admin/engine/accounts/* are served by rtx5-manager (:8091)
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
	if (kind == KindAdmin || kind == KindManager) && strings.HasPrefix(p, "/api/v2/auth/") {
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

	// All WebSocket upgrades (including all 18 /On* Manager real-time event channels!)
	if isWS {
		return "manager", p, true
	}

	// MT5-style PascalCase Manager REST & RPC endpoints (/Manager*, /Connect, /Account*, /Group*, /Symbol*, /Order*, /Position*, /Deal*, etc.)
	if len(p) >= 2 && p[0] == '/' && p[1] >= 'A' && p[1] <= 'Z' && !strings.Contains(path.Base(p), ".") {
		return "manager", p, true
	}

	// Non-GET requests without a static file extension are always backend RPCs
	if r.Method != http.MethodGet && r.Method != http.MethodHead && !strings.Contains(path.Base(p), ".") {
		return "manager", p, true
	}

	return "", "", false
}

func (c *DesktopClient) serveEmbeddedBrokerLogo(w http.ResponseWriter, r *http.Request) {
	activeFS := c.getActiveDistFS()
	candidates := []string{
		"brand/terminal-icon.png",
		"brand/rtx5-app-icon.png",
		"titlebar-icon.png",
		"rtx5-logo.png",
		"admin-symbol.png",
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

func (c *DesktopClient) serveEmbeddedSPA(w http.ResponseWriter, r *http.Request) {
	cleanPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if cleanPath == "" || cleanPath == "." {
		c.serveIndexHTML(w)
		return
	}
	if cleanPath == "brand/rtx5-app-icon.png" || cleanPath == "brand/terminal-icon.png" {
		c.serveEmbeddedBrokerLogo(w, r)
		return
	}

	activeFS := c.getActiveDistFS()
	f, err := activeFS.Open(cleanPath)
	if err != nil {
		// If request looks like a missing static asset (.js, .css, .png, .woff2), return 404; otherwise SPA fallback
		ext := strings.ToLower(path.Ext(cleanPath))
		if ext != "" && ext != ".html" {
			http.NotFound(w, r)
			return
		}
		c.serveIndexHTML(w)
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil || st.IsDir() {
		c.serveIndexHTML(w)
		return
	}

	if cleanPath == "index.html" {
		c.serveIndexHTML(w)
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

func (c *DesktopClient) serveIndexHTML(w http.ResponseWriter) {
	activeFS := c.getActiveDistFS()
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
	if c.cfg.Kind == KindSuperAdmin {
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

func launchStandaloneAppWindow(urlStr string, profileName string, exeDir string) *exec.Cmd {
	browserCandidates := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
	}

	baseProfileDir := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if baseProfileDir == "" {
		baseProfileDir = os.TempDir()
	}
	profileDir := filepath.Join(baseProfileDir, "RTX5-Desktop-Profiles", profileName)
	_ = os.MkdirAll(profileDir, 0700)

	for _, bin := range browserCandidates {
		if bin == "" {
			continue
		}
		if _, err := os.Stat(bin); err == nil {
			cmd := exec.Command(
				bin,
				"--app="+urlStr,
				"--new-window",
				"--user-data-dir="+profileDir,
				"--disable-extensions",
				"--disable-component-extensions-with-background-pages",
				"--disable-default-apps",
				"--disable-sync",
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-background-timer-throttling",
				"--disable-renderer-backgrounding",
				"--disable-backgrounding-occluded-windows",
				"--disable-ipc-flooding-protection",
				"--disable-features=Translate,msEdgeSidebarV2,msImplicitSignin,msEdgeFre,msAccountConsistency,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ExtensionsToolbarMenu",
				"--window-size=1480,920",
			)
			cmd.Dir = exeDir
			if err := cmd.Start(); err == nil {
				return cmd
			}
		}
	}

	// Fallback to Windows shell start
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", urlStr).Start()
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
