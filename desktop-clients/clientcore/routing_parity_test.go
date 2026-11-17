package clientcore

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClassifyBrokerRoute_ParityEndpoints(t *testing.T) {
	cases := []struct {
		name        string
		kind        AppKind
		method      string
		path        string
		isWS        bool
		wantService string
		wantRewPath string
		wantMatched bool
	}{
		// ── Gateway (:8090) Parity Endpoints ──
		{
			name:        "admin instruments bulk-configure routes to gateway (not manager)",
			kind:        KindAdmin,
			method:      http.MethodPost,
			path:        "/api/v2/admin/instruments/bulk-configure",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/instruments/bulk-configure",
			wantMatched: true,
		},
		{
			name:        "admin instruments bulk-configure from manager app routes to gateway",
			kind:        KindManager,
			method:      http.MethodPost,
			path:        "/api/v2/admin/instruments/bulk-configure",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/instruments/bulk-configure",
			wantMatched: true,
		},
		{
			name:        "admin funding-chart spec",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v2/admin/funding-chart",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/funding-chart",
			wantMatched: true,
		},
		{
			name:        "admin funding-chart coverage",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v2/admin/funding-chart/coverage",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/funding-chart/coverage",
			wantMatched: true,
		},
		{
			name:        "admin funding-chart apply",
			kind:        KindAdmin,
			method:      http.MethodPost,
			path:        "/api/v2/admin/funding-chart/apply",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/funding-chart/apply",
			wantMatched: true,
		},
		{
			name:        "admin journal-metrics",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v2/admin/journal-metrics",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/journal-metrics",
			wantMatched: true,
		},
		{
			name:        "admin trigger-book-status",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v2/admin/trigger-book-status",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/trigger-book-status",
			wantMatched: true,
		},
		{
			name:        "admin trigger-book degraded clear",
			kind:        KindAdmin,
			method:      http.MethodPost,
			path:        "/api/v2/admin/trigger-book/degraded/clear",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/trigger-book/degraded/clear",
			wantMatched: true,
		},
		{
			name:        "admin bbook-reconciler-status",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v2/admin/bbook-reconciler-status",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/bbook-reconciler-status",
			wantMatched: true,
		},
		{
			name:        "admin bbook-engine/status",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v2/admin/bbook-engine/status",
			wantService: "gateway",
			wantRewPath: "/api/v2/admin/bbook-engine/status",
			wantMatched: true,
		},
		{
			name:        "v1 position modify routes to gateway",
			kind:        KindTerminal,
			method:      http.MethodPut,
			path:        "/api/v1/positions/10452",
			wantService: "gateway",
			wantRewPath: "/api/v1/positions/10452",
			wantMatched: true,
		},
		{
			name:        "v1 admin position modify routes to gateway",
			kind:        KindManager,
			method:      http.MethodPut,
			path:        "/api/v1/admin/positions/10452",
			wantService: "gateway",
			wantRewPath: "/api/v1/admin/positions/10452",
			wantMatched: true,
		},
		{
			name:        "v2 positions close-by",
			kind:        KindTerminal,
			method:      http.MethodPost,
			path:        "/api/v2/positions/close-by",
			wantService: "gateway",
			wantRewPath: "/api/v2/positions/close-by",
			wantMatched: true,
		},
		{
			name:        "v2 bulk market-batches create",
			kind:        KindTerminal,
			method:      http.MethodPost,
			path:        "/api/v2/accounts/10001/market-batches",
			wantService: "gateway",
			wantRewPath: "/api/v2/accounts/10001/market-batches",
			wantMatched: true,
		},
		{
			name:        "v2 bulk market-batches status",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v2/accounts/10001/market-batches/coid-123",
			wantService: "gateway",
			wantRewPath: "/api/v2/accounts/10001/market-batches/coid-123",
			wantMatched: true,
		},
		{
			name:        "v2 bulk market-batches members",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v2/accounts/10001/market-batches/42/members",
			wantService: "gateway",
			wantRewPath: "/api/v2/accounts/10001/market-batches/42/members",
			wantMatched: true,
		},
		{
			name:        "v2 account close-all",
			kind:        KindTerminal,
			method:      http.MethodPost,
			path:        "/api/v2/accounts/10001/close-all",
			wantService: "gateway",
			wantRewPath: "/api/v2/accounts/10001/close-all",
			wantMatched: true,
		},
		{
			name:        "v2 account symbol-capabilities",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v2/account/symbol-capabilities/EURUSD",
			wantService: "gateway",
			wantRewPath: "/api/v2/account/symbol-capabilities/EURUSD",
			wantMatched: true,
		},
		{
			name:        "v2 order-commands lp-evidence",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v2/order-commands/coid-123/lp-evidence",
			wantService: "gateway",
			wantRewPath: "/api/v2/order-commands/coid-123/lp-evidence",
			wantMatched: true,
		},
		{
			name:        "v2 pending orders list with account_login query rewrites to /api/v2/orders/pending/{login}",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/api/v2/orders/pending?account_login=10001",
			wantService: "gateway",
			wantRewPath: "/api/v2/orders/pending/10001",
			wantMatched: true,
		},
		{
			name:        "v2 notifications",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v2/notifications",
			wantService: "gateway",
			wantRewPath: "/api/v2/notifications",
			wantMatched: true,
		},
		{
			name:        "v2 notifications read-all",
			kind:        KindTerminal,
			method:      http.MethodPost,
			path:        "/api/v2/notifications/read-all",
			wantService: "gateway",
			wantRewPath: "/api/v2/notifications/read-all",
			wantMatched: true,
		},
		{
			name:        "v2 depth snapshot",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v2/depth/EURUSD",
			wantService: "gateway",
			wantRewPath: "/api/v2/depth/EURUSD",
			wantMatched: true,
		},
		{
			name:        "v2 broker-config",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v2/broker-config",
			wantService: "gateway",
			wantRewPath: "/api/v2/broker-config",
			wantMatched: true,
		},
		{
			name:        "v2 auth register (demo netting signup)",
			kind:        KindTerminal,
			method:      http.MethodPost,
			path:        "/api/v2/auth/register",
			wantService: "gateway",
			wantRewPath: "/api/v2/auth/register",
			wantMatched: true,
		},
		{
			name:        "v2 auth login on terminal",
			kind:        KindTerminal,
			method:      http.MethodPost,
			path:        "/api/v2/auth/login",
			wantService: "gateway",
			wantRewPath: "/api/v2/auth/login",
			wantMatched: true,
		},
		{
			name:        "livez probe",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/livez",
			wantService: "gateway",
			wantRewPath: "/livez",
			wantMatched: true,
		},
		{
			name:        "readyz probe",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/readyz",
			wantService: "gateway",
			wantRewPath: "/readyz",
			wantMatched: true,
		},
		{
			name:        "healthz probe",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/healthz",
			wantService: "gateway",
			wantRewPath: "/healthz",
			wantMatched: true,
		},

		// ── Manager (:8091) Parity Endpoints ──
		{
			name:        "v2 auth login on manager app",
			kind:        KindManager,
			method:      http.MethodPost,
			path:        "/api/v2/auth/login",
			wantService: "manager",
			wantRewPath: "/api/v2/auth/login",
			wantMatched: true,
		},
		{
			name:        "v2 admin instrument-catalogue",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v2/admin/instrument-catalogue",
			wantService: "manager",
			wantRewPath: "/api/v2/admin/instrument-catalogue",
			wantMatched: true,
		},
		{
			name:        "v2 admin instruments list",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v2/admin/instruments",
			wantService: "manager",
			wantRewPath: "/api/v2/admin/instruments",
			wantMatched: true,
		},
		{
			name:        "v2 admin instruments symbol update",
			kind:        KindAdmin,
			method:      http.MethodPut,
			path:        "/api/v2/admin/instruments/EURUSD",
			wantService: "manager",
			wantRewPath: "/api/v2/admin/instruments/EURUSD",
			wantMatched: true,
		},
		{
			name:        "v2 admin instruments symbol toggle",
			kind:        KindAdmin,
			method:      http.MethodPatch,
			path:        "/api/v2/admin/instruments/EURUSD/toggle",
			wantService: "manager",
			wantRewPath: "/api/v2/admin/instruments/EURUSD/toggle",
			wantMatched: true,
		},
		{
			name:        "v2 admin engine account status routes to manager",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v2/admin/engine/accounts/10001/status",
			wantService: "manager",
			wantRewPath: "/api/v2/admin/engine/accounts/10001/status",
			wantMatched: true,
		},
		{
			name:        "v2 admin engine account freeze routes to manager",
			kind:        KindAdmin,
			method:      http.MethodPost,
			path:        "/api/v2/admin/engine/accounts/10001/freeze",
			wantService: "manager",
			wantRewPath: "/api/v2/admin/engine/accounts/10001/freeze",
			wantMatched: true,
		},
		{
			name:        "v1 manager transactions balance-op",
			kind:        KindManager,
			method:      http.MethodPost,
			path:        "/api/v1/manager/transactions/balance-op",
			wantService: "manager",
			wantRewPath: "/api/v1/manager/transactions/balance-op",
			wantMatched: true,
		},
		{
			name:        "shorthand /api/manager/transactions/balance-op rewrites to v1 manager",
			kind:        KindManager,
			method:      http.MethodPost,
			path:        "/api/manager/transactions/balance-op",
			wantService: "manager",
			wantRewPath: "/api/v1/manager/transactions/balance-op",
			wantMatched: true,
		},
		{
			name:        "v1 manager finance-summary",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/api/v1/manager/accounts/10001/finance-summary",
			wantService: "manager",
			wantRewPath: "/api/v1/manager/accounts/10001/finance-summary",
			wantMatched: true,
		},
		{
			name:        "shorthand /api/manager/accounts/:login/finance-summary rewrites to v1 manager",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/api/manager/accounts/10001/finance-summary",
			wantService: "manager",
			wantRewPath: "/api/v1/manager/accounts/10001/finance-summary",
			wantMatched: true,
		},
		{
			name:        "v1 manager balance-history",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/api/v1/manager/accounts/10001/balance-history",
			wantService: "manager",
			wantRewPath: "/api/v1/manager/accounts/10001/balance-history",
			wantMatched: true,
		},
		{
			name:        "shorthand /api/manager/accounts/:login/balance-history rewrites to v1 manager",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/api/manager/accounts/10001/balance-history",
			wantService: "manager",
			wantRewPath: "/api/v1/manager/accounts/10001/balance-history",
			wantMatched: true,
		},
		{
			name:        "IBAgentSet",
			kind:        KindManager,
			method:      http.MethodPost,
			path:        "/IBAgentSet",
			wantService: "manager",
			wantRewPath: "/IBAgentSet",
			wantMatched: true,
		},
		{
			name:        "IBAgentCommissions",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/IBAgentCommissions",
			wantService: "manager",
			wantRewPath: "/IBAgentCommissions",
			wantMatched: true,
		},
		{
			name:        "OnAccountUpdate websocket",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/OnAccountUpdate",
			isWS:        true,
			wantService: "manager",
			wantRewPath: "/OnAccountUpdate",
			wantMatched: true,
		},
		{
			name:        "reports v1 summary via manager proxy",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/reports/v1/summary",
			wantService: "manager",
			wantRewPath: "/reports/v1/summary",
			wantMatched: true,
		},

		// ── Risk (:8092) ──
		{
			name:        "v1 exposure routes to risk",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/api/v1/exposure",
			wantService: "risk",
			wantRewPath: "/api/v1/exposure",
			wantMatched: true,
		},
		{
			name:        "v1 exposure by symbol routes to risk",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v1/exposure/EURUSD",
			wantService: "risk",
			wantRewPath: "/api/v1/exposure/EURUSD",
			wantMatched: true,
		},
		{
			name:        "v1 risk book",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v1/book",
			wantService: "risk",
			wantRewPath: "/api/v1/book",
			wantMatched: true,
		},
		{
			name:        "v1 risk rules",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v1/rules",
			wantService: "risk",
			wantRewPath: "/api/v1/rules",
			wantMatched: true,
		},
		{
			name:        "v1 dealing queue",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/api/v1/dealing/queue",
			wantService: "risk",
			wantRewPath: "/api/v1/dealing/queue",
			wantMatched: true,
		},

		// ── Bridge (:8094) ──
		{
			name:        "ws/feed",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/ws/feed",
			isWS:        true,
			wantService: "bridge",
			wantRewPath: "/ws/feed",
			wantMatched: true,
		},
		{
			name:        "v1 market quote",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v1/market/quote",
			wantService: "bridge",
			wantRewPath: "/api/v1/market/quote",
			wantMatched: true,
		},
		{
			name:        "v1 t4b diagnostic",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v1/t4b/DiagnosticGet",
			wantService: "bridge",
			wantRewPath: "/api/v1/t4b/DiagnosticGet",
			wantMatched: true,
		},

		// ── Reports (:8095) ──
		{
			name:        "direct v1 statement",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/api/v1/statement/10001",
			wantService: "reports",
			wantRewPath: "/api/v1/statement/10001",
			wantMatched: true,
		},
		{
			name:        "direct v1 daily all",
			kind:        KindManager,
			method:      http.MethodGet,
			path:        "/api/v1/daily/all",
			wantService: "reports",
			wantRewPath: "/api/v1/daily/all",
			wantMatched: true,
		},

		// ── News (:8097) ──
		{
			name:        "v1 news",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v1/news",
			wantService: "news",
			wantRewPath: "/api/v1/news",
			wantMatched: true,
		},
		{
			name:        "v1 calendar today",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/api/v1/calendar/today",
			wantService: "news",
			wantRewPath: "/api/v1/calendar/today",
			wantMatched: true,
		},

		// ── History (:8098) & Binary Candles (:8194) ──
		{
			name:        "history ticks",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/history/ticks",
			wantService: "history",
			wantRewPath: "/history/ticks",
			wantMatched: true,
		},
		{
			name:        "ws/history",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/ws/history",
			isWS:        true,
			wantService: "history",
			wantRewPath: "/ws/history",
			wantMatched: true,
		},
		{
			name:        "history/candles routes to binary-candles",
			kind:        KindTerminal,
			method:      http.MethodGet,
			path:        "/history/candles/EURUSD",
			wantService: "binary-candles",
			wantRewPath: "/history/candles/EURUSD",
			wantMatched: true,
		},

		// ── Logging (:8099) ──
		{
			name:        "v1 audit",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v1/audit",
			wantService: "logging",
			wantRewPath: "/api/v1/audit",
			wantMatched: true,
		},
		{
			name:        "v1 metrics latency",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/api/v1/metrics/latency",
			wantService: "logging",
			wantRewPath: "/api/v1/metrics/latency",
			wantMatched: true,
		},

		// ── License (:8100) ──
		{
			name:        "license status",
			kind:        KindAdmin,
			method:      http.MethodGet,
			path:        "/license/status",
			wantService: "license",
			wantRewPath: "/license/status",
			wantMatched: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "http://127.0.0.1:18530"+tc.path, nil)
			if tc.isWS {
				req.Header.Set("Upgrade", "websocket")
			}
			gotSvc, gotPath, gotMatched := classifyBrokerRoute(tc.kind, req)
			if gotMatched != tc.wantMatched {
				t.Fatalf("classifyBrokerRoute(%v, %s %s) matched = %v, want %v",
					tc.kind, tc.method, tc.path, gotMatched, tc.wantMatched)
			}
			if gotSvc != tc.wantService {
				t.Errorf("classifyBrokerRoute(%v, %s %s) service = %q, want %q",
					tc.kind, tc.method, tc.path, gotSvc, tc.wantService)
			}
			if gotPath != tc.wantRewPath {
				t.Errorf("classifyBrokerRoute(%v, %s %s) rewrittenPath = %q, want %q",
					tc.kind, tc.method, tc.path, gotPath, tc.wantRewPath)
			}
		})
	}
}

func TestClassifySuperAdminRoute_ParityEndpoints(t *testing.T) {
	cases := []struct {
		name        string
		method      string
		path        string
		isWS        bool
		wantService string
		wantRewPath string
		wantMatched bool
	}{
		{
			name:        "tcp-security status",
			method:      http.MethodGet,
			path:        "/api/tcp-security/status",
			wantService: "tcp-security",
			wantRewPath: "/api/tcp-security/status",
			wantMatched: true,
		},
		{
			name:        "ota check",
			method:      http.MethodGet,
			path:        "/ota/check",
			wantService: "ota",
			wantRewPath: "/ota/check",
			wantMatched: true,
		},
		{
			name:        "candle-api prefix stripped",
			method:      http.MethodGet,
			path:        "/candle-api/api/v1/admin/market-data/status",
			wantService: "control-plane",
			wantRewPath: "/api/v1/admin/market-data/status",
			wantMatched: true,
		},
		{
			name:        "license server route",
			method:      http.MethodPost,
			path:        "/license/generate",
			wantService: "license",
			wantRewPath: "/license/generate",
			wantMatched: true,
		},
		{
			name:        "superadmin ws feed",
			method:      http.MethodGet,
			path:        "/ws/feed",
			isWS:        true,
			wantService: "control-plane",
			wantRewPath: "/ws/feed",
			wantMatched: true,
		},
		{
			name:        "superadmin livez probe",
			method:      http.MethodGet,
			path:        "/livez",
			wantService: "control-plane",
			wantRewPath: "/livez",
			wantMatched: true,
		},
		{
			name:        "superadmin db-backup status",
			method:      http.MethodGet,
			path:        "/api/superadmin/db-backup/status",
			wantService: "control-plane",
			wantRewPath: "/api/superadmin/db-backup/status",
			wantMatched: true,
		},
		{
			name:        "superadmin db-backup run",
			method:      http.MethodPost,
			path:        "/api/superadmin/db-backup/run",
			wantService: "control-plane",
			wantRewPath: "/api/superadmin/db-backup/run",
			wantMatched: true,
		},
		{
			name:        "superadmin db-backup archive download",
			method:      http.MethodGet,
			path:        "/api/superadmin/db-backup/download",
			wantService: "control-plane",
			wantRewPath: "/api/superadmin/db-backup/download",
			wantMatched: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "http://127.0.0.1:18533"+tc.path, nil)
			if tc.isWS {
				req.Header.Set("Upgrade", "websocket")
			}
			gotSvc, gotPath, gotMatched := classifySuperAdminRoute(req)
			if gotMatched != tc.wantMatched {
				t.Fatalf("classifySuperAdminRoute(%s %s) matched = %v, want %v",
					tc.method, tc.path, gotMatched, tc.wantMatched)
			}
			if gotSvc != tc.wantService {
				t.Errorf("classifySuperAdminRoute(%s %s) service = %q, want %q",
					tc.method, tc.path, gotSvc, tc.wantService)
			}
			if gotPath != tc.wantRewPath {
				t.Errorf("classifySuperAdminRoute(%s %s) rewrittenPath = %q, want %q",
					tc.method, tc.path, gotPath, tc.wantRewPath)
			}
		})
	}
}
