package rtx5tcp

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

// Rejection Error Codes surfaced in Super Admin Live Security Center & Red Clone Alerts
const (
	SecOK                   = "OK"
	SecErrInvalidSignature  = "ERR_INVALID_LICENSE_SIG"
	SecErrUnknownLicense    = "ERR_UNKNOWN_LICENSE"
	SecErrLicenseRevoked    = "ERR_LICENSE_REVOKED"
	SecErrLicenseExpired    = "ERR_LICENSE_EXPIRED"
	SecErrIPMismatch        = "ERR_IP_MISMATCH"
	SecErrHWIDMismatch      = "ERR_HWID_MISMATCH"
	SecErrDeviceKeyMismatch = "ERR_DEVICE_KEY_MISMATCH"
	SecErrNonceProofFailed  = "ERR_NONCE_PROOF_FAILED"
	SecErrDuplicateSession  = "ERR_DUPLICATE_ACTIVE_SESSION"
	SecErrBinaryTampered    = "ERR_BINARY_HASH_TAMPERED"
	SecErrDPAPIUnsealFailed = "ERR_DPAPI_MACHINE_SEAL_FAILED"
)

// BrokerLicenseCertificate is the Ed25519-signed broker.lic issued by Super Admin.
// Notice: broker.lic authorizes FIRST activation on AllowedServerIP; once activated,
// Super Admin locks the license to (AllowedServerIP + LockedHWID + DPAPI-Sealed DevicePublicKey).
type BrokerLicenseCertificate struct {
	LicenseID          string `json:"license_id"`
	LicenseKey         string `json:"license_key"`
	BrokerID           string `json:"broker_id"`
	BrokerName         string `json:"broker_name"`
	Plan               string `json:"plan"`
	AllowedServerIP    string `json:"allowed_server_ip"` // Comma-separated IP/CIDR or exact IP; "*" only if admin explicitly unlocks IP
	BrokerPublicTCP    string `json:"broker_public_tcp"` // e.g., "203.0.113.10:4443"
	SuperAdminTCPAddr  string `json:"superadmin_tcp_addr"`
	MaxAccounts        int    `json:"max_accounts"`
	MaxSymbols         int    `json:"max_symbols"`
	MaxManagers        int    `json:"max_managers"`
	IssuedAtUnix       int64  `json:"issued_at_unix"`
	ExpiresAtUnix      int64  `json:"expires_at_unix"`
	GuardDLLSHA256     string `json:"guard_dll_sha256,omitempty"`
	GuardDLLSigHex     string `json:"guard_dll_sig_hex,omitempty"`
	MasterPublicKeyHex string `json:"master_public_key_hex"`
	SignatureHex       string `json:"signature_hex"`
}

func (c *BrokerLicenseCertificate) canonicalPayload() ([]byte, error) {
	cp := *c
	cp.SignatureHex = ""
	return json.Marshal(cp)
}

func SignBrokerLicenseCertificate(priv ed25519.PrivateKey, cert *BrokerLicenseCertificate) error {
	pub := priv.Public().(ed25519.PublicKey)
	cert.MasterPublicKeyHex = hex.EncodeToString(pub)
	payload, err := cert.canonicalPayload()
	if err != nil {
		return err
	}
	sig := ed25519.Sign(priv, payload)
	cert.SignatureHex = hex.EncodeToString(sig)
	return nil
}

func VerifyBrokerLicenseCertificate(cert *BrokerLicenseCertificate, expectedMasterPub ed25519.PublicKey) error {
	if cert == nil {
		return errors.New("nil license certificate")
	}
	pub := expectedMasterPub
	if len(pub) == 0 {
		decoded, err := hex.DecodeString(cert.MasterPublicKeyHex)
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			return errors.New("invalid master public key in certificate")
		}
		pub = ed25519.PublicKey(decoded)
	} else if !strings.EqualFold(cert.MasterPublicKeyHex, hex.EncodeToString(pub)) {
		return errors.New("certificate master public key does not match Super Admin authority")
	}
	sig, err := hex.DecodeString(cert.SignatureHex)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return errors.New("invalid license signature format")
	}
	payload, err := cert.canonicalPayload()
	if err != nil {
		return err
	}
	if !ed25519.Verify(pub, payload, sig) {
		return errors.New("Ed25519 license signature verification failed")
	}
	if cert.ExpiresAtUnix > 0 && time.Now().Unix() > cert.ExpiresAtUnix {
		return errors.New("license certificate has expired")
	}
	return nil
}

// AuthChallengePacket is sent by Super Admin (:9100) right after X25519 tunnel establishment
// and repeated on every 30-second heartbeat challenge.
type AuthChallengePacket struct {
	ChallengeNonceHex string `json:"challenge_nonce_hex"` // 32-byte CSPRNG nonce (64 hex chars)
	ServerUnixTime    int64  `json:"server_unix_time"`
	HubInstanceID     string `json:"hub_instance_id"`
}

func NewAuthChallengePacket(hubID string) (*AuthChallengePacket, error) {
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	return &AuthChallengePacket{
		ChallengeNonceHex: hex.EncodeToString(nonce[:]),
		ServerUnixTime:    time.Now().Unix(),
		HubInstanceID:     hubID,
	}, nil
}

// ConnectedClientInfo describes an active desktop client (.exe) connected to Broker TCP (:4443).
type ConnectedClientInfo struct {
	SessionID       string `json:"session_id"`
	AppName         string `json:"app_name"`
	Role            string `json:"role"`
	RemoteAddr      string `json:"remote_addr"`
	ConnectedAtUnix int64  `json:"connected_at_unix"`
}

// BrokerTelemetrySnapshot carries real-time Broker operational & security metrics on every heartbeat.
type BrokerTelemetrySnapshot struct {
	Accounts         int                   `json:"accounts"`
	ActiveAccounts   int                   `json:"active_accounts"`
	ActiveManagers   int                   `json:"active_managers"`
	Instruments      int                   `json:"instruments"`
	OpenPositions    int                   `json:"open_positions"`
	PendingOrders    int                   `json:"pending_orders"`
	Deals            int64                 `json:"deals"`
	Volume           float64               `json:"volume"`
	TotalBalance     float64               `json:"total_balance"`
	TotalEquity      float64               `json:"total_equity"`
	FloatingProfit   float64               `json:"floating_profit"`
	QuotesReceived   uint64                `json:"quotes_received"`
	StreamingSymbols int                   `json:"streaming_symbols"`
	UptimeSeconds    int64                 `json:"uptime_seconds"`
	ConnectedUIs     int                   `json:"connected_uis"`
	ConnectedClients []ConnectedClientInfo `json:"connected_clients,omitempty"`
	LocalNICIPs      string                `json:"local_nic_ips"`
	BrokerTCPAddr    string                `json:"broker_tcp_addr"`
}

// AuthProofPacket is sent by the Broker in response to AuthChallengePacket or HeartbeatChallenge.
type AuthProofPacket struct {
	Certificate       BrokerLicenseCertificate `json:"certificate"`
	ChallengeNonceHex string                   `json:"challenge_nonce_hex"`
	BrokerUnixTime    int64                    `json:"broker_unix_time"`
	HWIDHex           string                   `json:"hwid_hex"`
	HardwareSummary   string                   `json:"hardware_summary"`
	ExeSHA256Hex      string                   `json:"exe_sha256_hex"`
	GuardDLLSHA256Hex string                   `json:"guard_dll_sha256_hex"`
	DevicePubKeyHex   string                   `json:"device_pub_key_hex"`
	DPAPISealStatus   string                   `json:"dpapi_seal_status"` // "SEALED_NEW", "UNSEALED_OK", or "FAILED"
	ProofSigHex       string                   `json:"proof_sig_hex"`     // Ed25519 signature by DPAPI-sealed DevicePrivateKey
	Telemetry         BrokerTelemetrySnapshot  `json:"telemetry"`
}

// BuildChallengeDigest binds the X25519 tunnel transcript + Magic + 32-byte Server ChallengeNonce +
// BrokerID + LicenseKey + HWID + ExeSHA256 + GuardDLLSHA256 + Timestamps into a single 32-byte hash.
// Binding TranscriptHash makes MITM / relay attacks across two TCP connections mathematically impossible!
func BuildChallengeDigest(
	transcript [32]byte,
	challengeNonceHex string,
	brokerID string,
	licenseKey string,
	hwidHex string,
	exeSHA256Hex string,
	dllSHA256Hex string,
	brokerUnix int64,
) [32]byte {
	h := sha256.New()
	h.Write(ProtocolMagic[:])
	h.Write([]byte("RTX5-CHALLENGE-PROOF-V2|"))
	h.Write(transcript[:])
	h.Write([]byte("|"))
	h.Write([]byte(challengeNonceHex))
	h.Write([]byte("|"))
	h.Write([]byte(brokerID))
	h.Write([]byte("|"))
	h.Write([]byte(licenseKey))
	h.Write([]byte("|"))
	h.Write([]byte(strings.ToLower(hwidHex)))
	h.Write([]byte("|"))
	h.Write([]byte(strings.ToLower(exeSHA256Hex)))
	h.Write([]byte("|"))
	h.Write([]byte(strings.ToLower(dllSHA256Hex)))
	h.Write([]byte(fmt.Sprintf("|%d", brokerUnix)))
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func SignChallengeProof(devicePriv ed25519.PrivateKey, transcript [32]byte, pkt *AuthProofPacket) {
	pub := devicePriv.Public().(ed25519.PublicKey)
	pkt.DevicePubKeyHex = hex.EncodeToString(pub)
	digest := BuildChallengeDigest(
		transcript,
		pkt.ChallengeNonceHex,
		pkt.Certificate.BrokerID,
		pkt.Certificate.LicenseKey,
		pkt.HWIDHex,
		pkt.ExeSHA256Hex,
		pkt.GuardDLLSHA256Hex,
		pkt.BrokerUnixTime,
	)
	sig := ed25519.Sign(devicePriv, digest[:])
	pkt.ProofSigHex = hex.EncodeToString(sig)
}

func VerifyChallengeProof(transcript [32]byte, expectedNonceHex string, pkt *AuthProofPacket) error {
	if pkt == nil {
		return errors.New("nil proof packet")
	}
	if !strings.EqualFold(pkt.ChallengeNonceHex, expectedNonceHex) {
		return errors.New("challenge nonce mismatch")
	}
	pubBytes, err := hex.DecodeString(pkt.DevicePubKeyHex)
	if err != nil || len(pubBytes) != ed25519.PublicKeySize {
		return errors.New("invalid device public key")
	}
	sigBytes, err := hex.DecodeString(pkt.ProofSigHex)
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return errors.New("invalid challenge proof signature")
	}
	digest := BuildChallengeDigest(
		transcript,
		pkt.ChallengeNonceHex,
		pkt.Certificate.BrokerID,
		pkt.Certificate.LicenseKey,
		pkt.HWIDHex,
		pkt.ExeSHA256Hex,
		pkt.GuardDLLSHA256Hex,
		pkt.BrokerUnixTime,
	)
	if !ed25519.Verify(ed25519.PublicKey(pubBytes), digest[:], sigBytes) {
		return errors.New("Ed25519 challenge-nonce device proof signature invalid")
	}
	return nil
}

// ExecutionLease is a 60-second short-lived Ed25519-signed execution token returned by Super Admin (:9100).
// Without a valid, non-expired ExecutionLease signed by Super Admin, Broker (:4443) blocks logins & orders!
type ExecutionLease struct {
	Accepted      bool   `json:"accepted"`
	Code          string `json:"code"` // SecOK or SecErr*
	Message       string `json:"message"`
	LeaseID       string `json:"lease_id,omitempty"`
	BrokerID      string `json:"broker_id,omitempty"`
	BrokerName    string `json:"broker_name,omitempty"`
	Plan          string `json:"plan,omitempty"`
	Status        string `json:"status,omitempty"` // "active", "suspended", "revoked"
	LockedHWID    string `json:"locked_hwid,omitempty"`
	AllowedIP     string `json:"allowed_ip,omitempty"`
	ObservedIP    string `json:"observed_ip,omitempty"`
	MaxAccounts   int    `json:"max_accounts,omitempty"`
	MaxSymbols    int    `json:"max_symbols,omitempty"`
	MaxManagers   int    `json:"max_managers,omitempty"`
	IssuedAtUnix  int64  `json:"issued_at_unix"`
	ExpiresAtUnix int64  `json:"expires_at_unix"`
	SignatureHex  string `json:"signature_hex,omitempty"`
}

func (l *ExecutionLease) canonicalPayload() ([]byte, error) {
	cp := *l
	cp.SignatureHex = ""
	return json.Marshal(cp)
}

func SignExecutionLease(masterPriv ed25519.PrivateKey, lease *ExecutionLease) error {
	payload, err := lease.canonicalPayload()
	if err != nil {
		return err
	}
	lease.SignatureHex = hex.EncodeToString(ed25519.Sign(masterPriv, payload))
	return nil
}

func VerifyExecutionLease(masterPub ed25519.PublicKey, lease *ExecutionLease, expectedBrokerID string, expectedHWID string) error {
	if lease == nil {
		return errors.New("no active Super Admin execution lease")
	}
	if !lease.Accepted || lease.Code != SecOK || lease.Status != "active" {
		return fmt.Errorf("Super Admin lease denied (%s): %s", lease.Code, lease.Message)
	}
	if lease.BrokerID != expectedBrokerID {
		return errors.New("execution lease broker_id mismatch")
	}
	if expectedHWID != "" && !strings.EqualFold(lease.LockedHWID, expectedHWID) {
		return errors.New("execution lease HWID mismatch")
	}
	if time.Now().Unix() > lease.ExpiresAtUnix {
		return errors.New("Super Admin 60s execution lease expired")
	}
	sig, err := hex.DecodeString(lease.SignatureHex)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return errors.New("invalid execution lease signature format")
	}
	payload, err := lease.canonicalPayload()
	if err != nil {
		return err
	}
	if !ed25519.Verify(masterPub, payload, sig) {
		return errors.New("execution lease Ed25519 signature invalid")
	}
	return nil
}

// SealedDeviceKeyFile represents the on-disk DPAPI machine-sealed device key blob.
// Even if copied to another PC, CipherBlobB64 is encrypted by Windows LSA DPAPI with HWID+BrokerID entropy!
type SealedDeviceKeyFile struct {
	BrokerID        string `json:"broker_id"`
	DevicePubKeyHex string `json:"device_pub_key_hex"`
	SealedAtUnix    int64  `json:"sealed_at_unix"`
	CipherBlobHex   string `json:"cipher_blob_hex"`
}

// LoadOrCreateDPAPIDeviceKey loads an existing DPAPI-sealed Ed25519 device keypair or creates & seals one on first boot.
// CRITICAL ANTI-CLONE RULE: If sealFilePath ALREADY EXISTS on disk (e.g. Friend #2 copied Friend #1's folder!),
// and Windows DPAPI fails to unseal it on Friend #2's PC, we DO NOT silently generate a new key — we return
// SecErrDPAPIUnsealFailed so both the Broker AND Super Admin detect the folder-copy attack immediately!
func LoadOrCreateDPAPIDeviceKey(guard *NativeGuard, sealFilePath string, brokerID string, hwidHex string) (priv ed25519.PrivateKey, status string, err error) {
	entropy := []byte("RTX5-DPAPI-ENTROPY-V2|" + brokerID + "|" + strings.ToLower(hwidHex))

	if raw, readErr := os.ReadFile(sealFilePath); readErr == nil && len(raw) > 0 {
		var sf SealedDeviceKeyFile
		if jerr := json.Unmarshal(raw, &sf); jerr != nil {
			return nil, SecErrDPAPIUnsealFailed, fmt.Errorf("corrupted machine-seal file: %w", jerr)
		}
		cipherBytes, derr := hex.DecodeString(sf.CipherBlobHex)
		if derr != nil {
			return nil, SecErrDPAPIUnsealFailed, fmt.Errorf("invalid cipher hex in machine-seal file: %w", derr)
		}
		plainSeed, uerr := guard.UnsealMachineSecret(cipherBytes, entropy)
		if uerr != nil || len(plainSeed) != ed25519.SeedSize {
			return nil, SecErrDPAPIUnsealFailed, fmt.Errorf("CLONE BLOCKED: copied machine-seal key cannot be unsealed on this PC/HWID (%v)", uerr)
		}
		priv = ed25519.NewKeyFromSeed(plainSeed)
		for i := range plainSeed {
			plainSeed[i] = 0
		}
		return priv, "UNSEALED_OK", nil
	}

	// First-time clean machine activation: generate fresh Ed25519 Device Keypair & seal via Windows DPAPI
	pub, newPriv, gerr := ed25519.GenerateKey(rand.Reader)
	if gerr != nil {
		return nil, "ERR_KEYGEN", gerr
	}
	seed := newPriv.Seed()
	cipherBlob, serr := guard.SealMachineSecret(seed, entropy)
	for i := range seed {
		seed[i] = 0
	}
	if serr != nil {
		return nil, "ERR_DPAPI_SEAL", serr
	}

	sf := SealedDeviceKeyFile{
		BrokerID:        brokerID,
		DevicePubKeyHex: hex.EncodeToString(pub),
		SealedAtUnix:    time.Now().Unix(),
		CipherBlobHex:   hex.EncodeToString(cipherBlob),
	}
	outBytes, _ := json.MarshalIndent(sf, "", "  ")
	if werr := os.WriteFile(sealFilePath, outBytes, 0600); werr != nil {
		return nil, "ERR_SEAL_WRITE", werr
	}
	return newPriv, "SEALED_NEW", nil
}

// ExtractRemoteIP parses the clean IP address from a net.Addr ("192.168.1.48:54321" -> "192.168.1.48").
func ExtractRemoteIP(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return strings.TrimSpace(addr.String())
	}
	ip := net.ParseIP(host)
	if ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			return ip4.String()
		}
		return ip.String()
	}
	return host
}

// IsIPAllowedByPolicy checks whether observedIP matches allowedSpec (comma-separated exact IPs or CIDRs).
// Note: Loopback (127.0.0.1 / ::1) matches when allowedSpec includes 127.0.0.1, localhost, or the host's own LAN IP on single-box tests.
func IsIPAllowedByPolicy(observedIP string, allowedSpec string, localHostIPs []string) bool {
	spec := strings.TrimSpace(allowedSpec)
	if spec == "" {
		return false
	}
	if spec == "*" {
		return true
	}
	obs := net.ParseIP(strings.TrimSpace(observedIP))
	if obs == nil {
		return false
	}
	obsIsLoopback := obs.IsLoopback()

	for _, part := range strings.Split(spec, ",") {
		token := strings.TrimSpace(part)
		if token == "" {
			continue
		}
		if strings.EqualFold(token, "localhost") && obsIsLoopback {
			return true
		}
		if strings.Contains(token, "/") {
			if _, cidr, err := net.ParseCIDR(token); err == nil && cidr.Contains(obs) {
				return true
			}
			continue
		}
		if allowedIP := net.ParseIP(token); allowedIP != nil {
			if allowedIP.Equal(obs) {
				return true
			}
			// If Broker runs on the same physical PC as Super Admin and dials 127.0.0.1,
			// allow when allowedIP is one of Super Admin's own local NIC IPs!
			if obsIsLoopback {
				for _, lip := range localHostIPs {
					if parsedLocal := net.ParseIP(lip); parsedLocal != nil && allowedIP.Equal(parsedLocal) {
						return true
					}
				}
			}
		}
	}
	return false
}

// LocalHostIPv4List returns all active non-loopback IPv4 addresses on this machine.
func LocalHostIPv4List() []string {
	var out []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ip4 := ipnet.IP.To4(); ip4 != nil {
				out = append(out, ip4.String())
			}
		}
	}
	return out
}
