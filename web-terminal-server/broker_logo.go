package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	rtx5tcp "rtx5-tcp-protocol"
)

const (
	brokerLogoFreshTTL     = 5 * time.Second
	brokerLogoFetchTimeout = 4 * time.Second
	brokerLogoDirWaitCap   = 750 * time.Millisecond
	brokerLogoMaxBytes     = 8 * 1024 * 1024 // 8 MiB safety cap
)

type cachedBrokerLogo struct {
	data        []byte
	contentType string
	upstreamTag string
	version     string
	source      string
	fetchedAt   time.Time
	found       bool
}

var pngMagicBytes = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

func extractBrokerLogoID(normPath string) (string, bool) {
	var rest string
	switch {
	case strings.HasPrefix(normPath, "/api/v1/brokers/"):
		rest = strings.TrimPrefix(normPath, "/api/v1/brokers/")
	case strings.HasPrefix(normPath, "/api/v2/brokers/"):
		rest = strings.TrimPrefix(normPath, "/api/v2/brokers/")
	default:
		return "", false
	}
	if !strings.HasSuffix(rest, "/logo") {
		return "", false
	}
	rawID := strings.TrimSuffix(rest, "/logo")
	if rawID == "" || strings.Contains(rawID, "/") {
		return "", false
	}
	decoded, err := url.PathUnescape(rawID)
	if err != nil {
		decoded = rawID
	}
	decoded = strings.TrimSpace(decoded)
	if decoded == "" || strings.Contains(decoded, "/") || strings.Contains(decoded, "\\") || strings.Contains(decoded, "..") {
		return "", false
	}
	return decoded, true
}

func headerGetFold(hdrs map[string][]string, name string) string {
	for k, vals := range hdrs {
		if strings.EqualFold(k, name) {
			for _, v := range vals {
				if trimmed := strings.TrimSpace(v); trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return ""
}

// unwrapLargestPNGFromICO extracts the highest-resolution embedded PNG image
// from a Windows .ico container (such as 256x256 PNG-in-ICO uploads) so every
// browser and HTML5 canvas pixel reader decodes it cleanly at full resolution.
func unwrapLargestPNGFromICO(data []byte) ([]byte, bool) {
	if len(data) < 6 {
		return nil, false
	}
	if binary.LittleEndian.Uint16(data[0:2]) != 0 || binary.LittleEndian.Uint16(data[2:4]) != 1 {
		return nil, false
	}
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	if count <= 0 || count > 64 || len(data) < 6+count*16 {
		return nil, false
	}

	var best []byte
	bestArea := -1
	for i := 0; i < count; i++ {
		off := 6 + i*16
		w := int(data[off])
		if w == 0 {
			w = 256
		}
		h := int(data[off+1])
		if h == 0 {
			h = 256
		}
		imgSize := int(binary.LittleEndian.Uint32(data[off+8 : off+12]))
		imgOffset := int(binary.LittleEndian.Uint32(data[off+12 : off+16]))
		if imgSize < len(pngMagicBytes) || imgOffset < 6+count*16 || imgOffset+imgSize > len(data) {
			continue
		}
		slice := data[imgOffset : imgOffset+imgSize]
		if !bytes.HasPrefix(slice, pngMagicBytes) {
			continue
		}
		area := w * h
		if area > bestArea || (area == bestArea && len(slice) > len(best)) {
			bestArea = area
			best = slice
		}
	}
	if len(best) == 0 {
		return nil, false
	}
	out := make([]byte, len(best))
	copy(out, best)
	return out, true
}

func normalizeBrokerLogoPayload(rawCT string, rawBody []byte) (string, []byte, bool) {
	if len(rawBody) == 0 || len(rawBody) > brokerLogoMaxBytes {
		return "", nil, false
	}
	ct := strings.TrimSpace(rawCT)
	baseCT := strings.ToLower(strings.TrimSpace(strings.Split(ct, ";")[0]))

	if baseCT == "image/vnd.microsoft.icon" || baseCT == "image/x-icon" ||
		(len(rawBody) >= 4 && rawBody[0] == 0 && rawBody[1] == 0 && rawBody[2] == 1 && rawBody[3] == 0) {
		if pngBytes, ok := unwrapLargestPNGFromICO(rawBody); ok {
			return "image/png", pngBytes, true
		}
		if baseCT == "" || baseCT == "application/octet-stream" {
			ct = "image/x-icon"
		}
		return ct, append([]byte(nil), rawBody...), true
	}

	if strings.HasPrefix(baseCT, "image/") {
		return ct, append([]byte(nil), rawBody...), true
	}

	trimmed := bytes.TrimSpace(rawBody)
	lowerPrefix := strings.ToLower(string(trimmed[:min(len(trimmed), 256)]))
	if strings.HasPrefix(lowerPrefix, "<svg") || (strings.HasPrefix(lowerPrefix, "<?xml") && strings.Contains(lowerPrefix, "<svg")) {
		return "image/svg+xml; charset=utf-8", append([]byte(nil), rawBody...), true
	}

	if baseCT == "" || baseCT == "application/octet-stream" {
		detected := strings.ToLower(http.DetectContentType(rawBody))
		if strings.HasPrefix(detected, "image/") {
			return detected, append([]byte(nil), rawBody...), true
		}
	}

	return "", nil, false
}

func computeBrokerLogoVersion(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:6])
}

func normalizeDirectoryLogoVersion(ver, updatedAt string) string {
	v := strings.TrimSpace(ver)
	if v == "" {
		v = strings.TrimSpace(updatedAt)
	}
	v = strings.TrimPrefix(v, "W/")
	v = strings.Trim(v, `"`)
	return strings.TrimSpace(v)
}

func requestHasMatchingETag(ifNoneMatch, version string) bool {
	if strings.TrimSpace(ifNoneMatch) == "" || strings.TrimSpace(version) == "" {
		return false
	}
	want := `"` + version + `"`
	for _, part := range strings.Split(ifNoneMatch, ",") {
		p := strings.TrimSpace(part)
		if p == "*" || p == want || p == "W/"+want || strings.Trim(strings.TrimPrefix(p, "W/"), `"`) == version {
			return true
		}
	}
	return false
}

func (c *WebTerminalServer) getCachedBrokerLogoEntry(brokerID string) *cachedBrokerLogo {
	key := strings.ToLower(strings.TrimSpace(brokerID))
	if key == "" {
		return nil
	}
	c.logoMu.RLock()
	defer c.logoMu.RUnlock()
	if c.logoCache == nil {
		return nil
	}
	return c.logoCache[key]
}

func (c *WebTerminalServer) setCachedBrokerLogoEntry(brokerID string, entry *cachedBrokerLogo) {
	key := strings.ToLower(strings.TrimSpace(brokerID))
	if key == "" {
		return
	}
	c.logoMu.Lock()
	if c.logoCache == nil {
		c.logoCache = make(map[string]*cachedBrokerLogo)
	}
	c.logoCache[key] = entry
	c.logoMu.Unlock()
}

func (c *WebTerminalServer) resolveLinkForBrokerID(fallbackLink *brokerLink, brokerID string) *brokerLink {
	bid := strings.TrimSpace(brokerID)
	if bid == "" {
		return fallbackLink
	}
	c.linksMu.RLock()
	existing := c.links[linkKey(bid, "")]
	c.linksMu.RUnlock()
	if existing != nil {
		return existing
	}
	if fallbackLink != nil && strings.EqualFold(strings.TrimSpace(fallbackLink.id), bid) {
		return fallbackLink
	}
	c.mu.RLock()
	var matched *DiscoveredBroker
	for i := range c.cachedBrokers {
		if strings.EqualFold(strings.TrimSpace(c.cachedBrokers[i].BrokerID), bid) && strings.TrimSpace(c.cachedBrokers[i].TCPAddr) != "" {
			b := c.cachedBrokers[i]
			matched = &b
			break
		}
	}
	c.mu.RUnlock()
	if matched != nil {
		if l := c.ensureLink(matched.BrokerID, matched.BrokerName, matched.TCPAddr); l != nil {
			return l
		}
	}
	return fallbackLink
}

// getOrDialSuperAdminForLogo reuses an active SuperAdmin tunnel or dials one with
// a short per-candidate cap respecting ctx so an unreachable SuperAdmin hub never
// starves the Broker Gateway (:4443) secondary logo source.
func (c *WebTerminalServer) getOrDialSuperAdminForLogo(ctx context.Context, link *brokerLink) (*rtx5tcp.MuxSession, error) {
	// One shared dial path: the session it creates feeds the Super Admin market hub (control handler), ends the
	// feed's tabs when it dies, and honours ctx for the lock wait and every dial.
	return c.getOrDialSuperAdminSessionFor(ctx, link, false)
}

func (c *WebTerminalServer) fetchDynamicBrokerLogo(ctx context.Context, link *brokerLink, brokerID string, forceRefresh bool) (*cachedBrokerLogo, bool) {
	bid := strings.TrimSpace(brokerID)
	if bid == "" {
		return nil, false
	}

	cached := c.getCachedBrokerLogoEntry(bid)
	if !forceRefresh && cached != nil && time.Since(cached.fetchedAt) < brokerLogoFreshTTL {
		if cached.found && len(cached.data) > 0 {
			return cached, true
		}
		return nil, false
	}

	logoPath := "/api/v1/brokers/" + url.PathEscape(bid) + "/logo"
	targetLink := c.resolveLinkForBrokerID(link, bid)

	// 1. Primary source: Super Admin Control Plane (:9100 -> control-plane)
	superAdminReturnedNotFound := false
	if c.superAdminTCP != "" || c.superAdminMux != nil || targetLink != nil {
		saTimeout := 2200 * time.Millisecond
		if deadline, ok := ctx.Deadline(); ok {
			if rem := time.Until(deadline); rem > 0 && rem < saTimeout {
				saTimeout = rem
			}
		}
		saCtx, saCancel := context.WithTimeout(ctx, saTimeout)
		sess, serr := c.getOrDialSuperAdminForLogo(saCtx, targetLink)
		saCancel()
		if serr == nil && sess != nil {
			hdrs := map[string][]string{
				"Origin": {"http://127.0.0.1:18400"},
			}
			if cached != nil && cached.found && cached.source == "superadmin" && cached.upstreamTag != "" {
				hdrs["If-None-Match"] = []string{cached.upstreamTag}
			}
			rpcTimeout := 2200 * time.Millisecond
			if deadline, ok := ctx.Deadline(); ok {
				if rem := time.Until(deadline); rem > 0 && rem < rpcTimeout {
					rpcTimeout = rem
				}
			}
			code, respHdrs, body, rerr := sess.RoundTripRPC("control-plane", http.MethodGet, logoPath, hdrs, nil, rpcTimeout)
			if rerr == nil {
				switch code {
				case http.StatusNotModified:
					if cached != nil && cached.found && len(cached.data) > 0 {
						refreshed := *cached
						refreshed.fetchedAt = time.Now()
						if tag := headerGetFold(respHdrs, "ETag"); tag != "" {
							refreshed.upstreamTag = tag
						}
						c.setCachedBrokerLogoEntry(bid, &refreshed)
						return &refreshed, true
					}
				case http.StatusOK:
					if ct, payload, ok := normalizeBrokerLogoPayload(headerGetFold(respHdrs, "Content-Type"), body); ok {
						entry := &cachedBrokerLogo{
							data:        payload,
							contentType: ct,
							upstreamTag: headerGetFold(respHdrs, "ETag"),
							version:     computeBrokerLogoVersion(payload),
							source:      "superadmin",
							fetchedAt:   time.Now(),
							found:       true,
						}
						c.setCachedBrokerLogoEntry(bid, entry)
						return entry, true
					}
				case http.StatusNotFound, http.StatusNoContent:
					superAdminReturnedNotFound = true
				}
			}
		}
	}

	// 2. Secondary source: Broker Gateway (:4443 -> gateway)
	if targetLink != nil && ctx.Err() == nil {
		if sess, err := targetLink.getOrDialSession(); err == nil && sess != nil {
			hdrs := map[string][]string{
				"Origin": {"http://127.0.0.1:18403"},
			}
			if cached != nil && cached.found && cached.source == "gateway" && cached.upstreamTag != "" {
				hdrs["If-None-Match"] = []string{cached.upstreamTag}
			}
			timeout := 2500 * time.Millisecond
			if deadline, ok := ctx.Deadline(); ok {
				if rem := time.Until(deadline); rem > 0 && rem < timeout {
					timeout = rem
				}
			}
			for _, gwPath := range []string{logoPath, "/api/v2/brokers/" + url.PathEscape(bid) + "/logo"} {
				code, respHdrs, body, rerr := sess.RoundTripRPC("gateway", http.MethodGet, gwPath, hdrs, nil, timeout)
				if rerr != nil {
					break
				}
				switch code {
				case http.StatusNotModified:
					if cached != nil && cached.found && len(cached.data) > 0 {
						refreshed := *cached
						refreshed.fetchedAt = time.Now()
						c.setCachedBrokerLogoEntry(bid, &refreshed)
						return &refreshed, true
					}
				case http.StatusOK:
					if ct, payload, ok := normalizeBrokerLogoPayload(headerGetFold(respHdrs, "Content-Type"), body); ok {
						entry := &cachedBrokerLogo{
							data:        payload,
							contentType: ct,
							upstreamTag: headerGetFold(respHdrs, "ETag"),
							version:     computeBrokerLogoVersion(payload),
							source:      "gateway",
							fetchedAt:   time.Now(),
							found:       true,
						}
						c.setCachedBrokerLogoEntry(bid, entry)
						return entry, true
					}
				case http.StatusNotFound:
					continue
				}
				break
			}
		}
	}

	// If upstream had a transient hiccup (not an explicit 404), preserve the last known good logo briefly.
	if !superAdminReturnedNotFound && cached != nil && cached.found && len(cached.data) > 0 {
		refreshed := *cached
		refreshed.fetchedAt = time.Now()
		c.setCachedBrokerLogoEntry(bid, &refreshed)
		return &refreshed, true
	}

	c.setCachedBrokerLogoEntry(bid, &cachedBrokerLogo{
		fetchedAt: time.Now(),
		found:     false,
	})
	return nil, false
}

func (c *WebTerminalServer) getOrRefreshBrokerLogoVersion(ctx context.Context, link *brokerLink, brokerID, dirVersion, dirUpdatedAt string) string {
	bid := strings.TrimSpace(brokerID)
	if bid == "" {
		return ""
	}
	cached := c.getCachedBrokerLogoEntry(bid)
	if cached != nil && time.Since(cached.fetchedAt) < brokerLogoFreshTTL {
		if cached.found && cached.version != "" {
			return cached.version
		}
		return normalizeDirectoryLogoVersion(dirVersion, dirUpdatedAt)
	}

	if c.superAdminTCP == "" && c.superAdminMux == nil && link == nil {
		return normalizeDirectoryLogoVersion(dirVersion, dirUpdatedAt)
	}

	done := make(chan string, 1)
	go func() {
		fetchCtx, cancel := context.WithTimeout(context.Background(), brokerLogoFetchTimeout)
		defer cancel()
		if entry, ok := c.fetchDynamicBrokerLogo(fetchCtx, link, bid, false); ok && entry != nil && entry.version != "" {
			done <- entry.version
			return
		}
		done <- ""
	}()

	waitCap := brokerLogoDirWaitCap
	if cached != nil && cached.found && cached.version != "" {
		// Already have a previous version — allow a brief window to catch an immediate SuperAdmin change, then return promptly.
		waitCap = 350 * time.Millisecond
	}
	select {
	case v := <-done:
		if v != "" {
			return v
		}
	case <-time.After(waitCap):
	case <-ctx.Done():
	}

	if cached != nil && cached.found && cached.version != "" {
		return cached.version
	}
	return normalizeDirectoryLogoVersion(dirVersion, dirUpdatedAt)
}

func (c *WebTerminalServer) warmBrokerDirectoryLogos(list []DiscoveredBroker) {
	if len(list) == 0 {
		return
	}
	maxWarm := len(list)
	if maxWarm > 16 {
		maxWarm = 16
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i := 0; i < maxWarm; i++ {
		bid := strings.TrimSpace(list[i].BrokerID)
		if bid == "" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), brokerLogoFetchTimeout)
			defer cancel()
			_, _ = c.fetchDynamicBrokerLogo(ctx, nil, id, false)
		}(bid)
	}
	wg.Wait()
}

func (c *WebTerminalServer) serveDynamicBrokerLogo(w http.ResponseWriter, r *http.Request, link *brokerLink, brokerID string) {
	q := r.URL.Query()
	requestedVersion := strings.TrimSpace(q.Get("v"))
	forceRefresh := strings.Contains(strings.ToLower(r.Header.Get("Cache-Control")), "no-cache") ||
		strings.Contains(strings.ToLower(r.Header.Get("Pragma")), "no-cache") ||
		q.Get("refresh") == "1"

	if !forceRefresh && requestedVersion != "" {
		if cached := c.getCachedBrokerLogoEntry(brokerID); cached == nil || !cached.found || cached.version != requestedVersion {
			forceRefresh = true
		}
	}

	if entry, ok := c.fetchDynamicBrokerLogo(r.Context(), link, brokerID, forceRefresh); ok && entry != nil && len(entry.data) > 0 {
		w.Header().Set("Content-Type", entry.contentType)
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		if w.Header().Get("Access-Control-Allow-Origin") == "" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		if w.Header().Get("Vary") == "" {
			w.Header().Set("Vary", "Origin")
		}
		if entry.version != "" {
			w.Header().Set("ETag", `"`+entry.version+`"`)
		}
		if entry.source != "" {
			w.Header().Set("X-RTX5-Broker-Logo-Source", entry.source)
		}
		if requestHasMatchingETag(r.Header.Get("If-None-Match"), entry.version) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(entry.data)
		}
		return
	}

	c.serveEmbeddedBrokerLogo(w, r)
}
