package main

import (
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"unicode"
)

type webOriginPolicy struct {
	configured    bool
	exactHosts    map[string]struct{}
	suffixDomains []string
	publicHost    string
}

var defaultWebOriginPolicy = &webOriginPolicy{}

var currentWebOriginPolicy atomic.Pointer[webOriginPolicy]

func loadWebOriginPolicy() *webOriginPolicy {
	if p := currentWebOriginPolicy.Load(); p != nil {
		return p
	}
	return defaultWebOriginPolicy
}

// initWebOriginPolicyFromEnv parses RTX5_WEB_ALLOWED_ORIGIN_HOSTS and RTX5_WEB_PUBLIC_HOST once
// at startup (after loadDotEnvFiles) into an immutable webOriginPolicy.
func initWebOriginPolicyFromEnv() {
	allowedRaw := os.Getenv("RTX5_WEB_ALLOWED_ORIGIN_HOSTS")
	publicRaw := os.Getenv("RTX5_WEB_PUBLIC_HOST")
	policy, invalidAllowed, validPublic := buildWebOriginPolicy(allowedRaw, publicRaw)
	if len(invalidAllowed) > 0 {
		log.Printf("[WEB-ORIGIN] RTX5_WEB_ALLOWED_ORIGIN_HOSTS: skipped %d invalid entries: %q", len(invalidAllowed), invalidAllowed)
	}
	if !validPublic {
		log.Printf("[WEB-ORIGIN] RTX5_WEB_PUBLIC_HOST: ignoring invalid bare hostname %q", strings.TrimSpace(publicRaw))
	}
	currentWebOriginPolicy.Store(policy)
}

func setWebOriginPolicyForTest(allowedRaw, publicRaw string) (restore func(), invalidAllowed []string, validPublic bool) {
	policy, invalid, okPub := buildWebOriginPolicy(allowedRaw, publicRaw)
	prev := currentWebOriginPolicy.Swap(policy)
	return func() {
		currentWebOriginPolicy.Store(prev)
	}, invalid, okPub
}

func buildWebOriginPolicy(allowedRaw, publicRaw string) (*webOriginPolicy, []string, bool) {
	configured, exact, suffixes, invalid := parseAllowedOriginHosts(allowedRaw)
	pubHost, validPub := parsePublicHost(publicRaw)
	return &webOriginPolicy{
		configured:    configured,
		exactHosts:    exact,
		suffixDomains: suffixes,
		publicHost:    pubHost,
	}, invalid, validPub
}

func parseAllowedOriginHosts(raw string) (configured bool, exact map[string]struct{}, suffixes []string, invalid []string) {
	if strings.TrimSpace(raw) == "" {
		return false, nil, nil, nil
	}
	configured = true
	var seenSuffix map[string]struct{}
	for _, part := range strings.Split(raw, ",") {
		trimmed := strings.TrimSpace(part)
		entry := strings.ToLower(trimmed)
		if entry == "" {
			invalid = append(invalid, trimmed)
			continue
		}
		if strings.Contains(entry, "://") ||
			strings.ContainsAny(entry, "/@?#\\") ||
			strings.IndexFunc(entry, unicode.IsSpace) >= 0 {
			invalid = append(invalid, trimmed)
			continue
		}
		if strings.ContainsRune(entry, ':') {
			if len(entry) >= 2 && entry[0] == '[' && entry[len(entry)-1] == ']' {
				if ip := net.ParseIP(entry[1 : len(entry)-1]); ip != nil && ip.To4() == nil {
					if exact == nil {
						exact = make(map[string]struct{})
					}
					exact[entry[1:len(entry)-1]] = struct{}{}
					continue
				}
			}
			invalid = append(invalid, trimmed)
			continue
		}

		isSuffix := false
		if strings.HasPrefix(entry, "*.") {
			isSuffix = true
			entry = entry[2:]
		} else if strings.HasPrefix(entry, ".") {
			isSuffix = true
			entry = entry[1:]
		}
		if entry == "" ||
			strings.ContainsAny(entry, "*[]") ||
			strings.HasPrefix(entry, ".") ||
			strings.HasSuffix(entry, ".") ||
			strings.Contains(entry, "..") {
			invalid = append(invalid, trimmed)
			continue
		}

		if isSuffix {
			if net.ParseIP(entry) != nil {
				invalid = append(invalid, trimmed)
				continue
			}
			if seenSuffix == nil {
				seenSuffix = make(map[string]struct{})
			}
			if _, ok := seenSuffix[entry]; !ok {
				seenSuffix[entry] = struct{}{}
				suffixes = append(suffixes, entry)
			}
			continue
		}

		if exact == nil {
			exact = make(map[string]struct{})
		}
		exact[entry] = struct{}{}
	}
	return configured, exact, suffixes, invalid
}

func parsePublicHost(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", true
	}
	if !isValidBareHostname(s) {
		return "", false
	}
	return strings.ToLower(s), true
}

func isValidBareHostname(s string) bool {
	if len(s) == 0 || len(s) > 253 {
		return false
	}
	if strings.HasPrefix(s, ".") || strings.HasSuffix(s, ".") || strings.Contains(s, "..") {
		return false
	}
	for _, label := range strings.Split(s, ".") {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
		if !isASCIIAlphaNum(label[0]) || !isASCIIAlphaNum(label[len(label)-1]) {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if !isASCIIAlphaNum(c) && c != '-' {
				return false
			}
		}
	}
	return true
}

func isASCIIAlphaNum(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

func isASCIILowerLetter(b byte) bool {
	return b >= 'a' && b <= 'z'
}

func (p *webOriginPolicy) allowsHost(host string) bool {
	if _, ok := p.exactHosts[host]; ok {
		return true
	}
	for _, d := range p.suffixDomains {
		if matchesDomainLabelBoundary(host, d) {
			return true
		}
	}
	return false
}

func isAllowedOriginHost(originHost, reqHost string) bool {
	if originHost == "127.0.0.1" || originHost == "localhost" {
		return true
	}
	if reqHost != "" && originHost == reqHost {
		return true
	}
	policy := loadWebOriginPolicy()
	if policy.configured {
		return policy.allowsHost(originHost)
	}
	if reqHost == "" {
		return false
	}
	parent := derivedOriginParent(reqHost)
	if parent == "" {
		return false
	}
	return matchesDomainLabelBoundary(originHost, parent)
}

func firstCommaToken(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.IndexByte(s, ','); idx >= 0 {
		s = strings.TrimSpace(s[:idx])
	}
	return s
}

func extractRawRequestHost(r *http.Request) string {
	if r == nil {
		return ""
	}
	raw := firstCommaToken(r.Header.Get("X-Forwarded-Host"))
	if raw == "" {
		raw = strings.TrimSpace(r.Host)
	}
	if raw == "" {
		return ""
	}
	if h, _, err := net.SplitHostPort(raw); err == nil {
		raw = h
	}
	if len(raw) >= 2 && raw[0] == '[' && raw[len(raw)-1] == ']' {
		raw = raw[1 : len(raw)-1]
	}
	return strings.TrimSpace(raw)
}

func extractRequestHost(r *http.Request) string {
	return strings.ToLower(extractRawRequestHost(r))
}

func isDigitsAndDotsOnly(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && c != '.' {
			return false
		}
	}
	return true
}

func derivedOriginParent(reqHost string) string {
	if reqHost == "" || strings.ContainsRune(reqHost, ':') || (isDigitsAndDotsOnly(reqHost) && net.ParseIP(reqHost) != nil) {
		return ""
	}
	if strings.HasPrefix(reqHost, ".") || strings.HasSuffix(reqHost, ".") || strings.Contains(reqHost, "..") {
		return ""
	}
	dot := strings.IndexByte(reqHost, '.')
	if dot <= 0 {
		return ""
	}
	parent := reqHost[dot+1:]
	dot2 := strings.IndexByte(parent, '.')
	if dot2 <= 0 || dot2 == len(parent)-1 {
		return ""
	}
	firstLabel := parent[:dot2]
	rest := parent[dot2+1:]
	// Public-suffix guard: refuse 2-label parents like co.uk / com.au where TLD is 2 letters
	// and the first label is a common second-level public label.
	if strings.IndexByte(rest, '.') < 0 &&
		len(rest) == 2 &&
		isASCIILowerLetter(rest[0]) &&
		isASCIILowerLetter(rest[1]) &&
		isPublicSecondLevelLabel(firstLabel) {
		return ""
	}
	return parent
}

func isPublicSecondLevelLabel(label string) bool {
	switch label {
	case "co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob",
		"mil", "nic", "ltd", "plc", "me", "biz", "info", "int", "sch", "nom",
		"gen", "firm", "ind", "gv", "lg", "nhs", "police", "mod":
		return true
	default:
		return false
	}
}

func matchesDomainLabelBoundary(host, domain string) bool {
	if host == domain {
		return true
	}
	if len(host) <= len(domain)+1 {
		return false
	}
	offset := len(host) - len(domain)
	return host[offset-1] == '.' && host[offset:] == domain
}

func httpToHTTPSRedirectHandler(w http.ResponseWriter, r *http.Request) {
	if r == nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	host := extractRawRequestHost(r)
	if host == "" {
		host = loadWebOriginPolicy().publicHost
	}
	if host == "" || strings.ContainsAny(host, "/@?#\\ \t\r\n") {
		http.Error(w, "missing Host header", http.StatusBadRequest)
		return
	}
	if strings.ContainsRune(host, ':') {
		host = "[" + host + "]"
	}
	targetURI := "/"
	if r.URL != nil {
		targetURI = r.URL.RequestURI()
	}
	http.Redirect(w, r, "https://"+host+targetURI, http.StatusMovedPermanently)
}
