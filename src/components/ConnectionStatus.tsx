import { useUiTranslation } from '../hooks/useUiTranslation';
import { lazy, useState, useRef, useEffect } from 'react';
import { useWebSocketStore } from '../store/useWebSocketStore';
import { useAppStore } from '../store/useAppStore';
import { Wifi, RefreshCw, WifiOff, AlertTriangle, LogIn, Globe, Zap, Server, Download } from 'lucide-react';
import { RetainedLazyFeature } from '../startup/RetainedLazyFeature';

const LoginDialog = lazy(() => import('./LoginDialog').then(module => ({ default: module.LoginDialog })));

interface TcpWireStatus {
  connected?: boolean;
  rtt_ms?: number;
  avg_rtt_ms?: number;
  ota?: {
    up_to_date?: boolean;
    hot_ui_applied?: boolean;
    pending_exe_restart?: boolean;
    latest_version?: string;
  };
}

interface ConnectionStatusProps {
  wsRef?: React.RefObject<WebSocket | null>;
  reconnectCallback?: () => void;
}

const formatWireLatency = (ms: number): string => {
  if (ms < 1) return `${ms.toFixed(1)}ms`;
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
};

export function ConnectionStatus({ reconnectCallback }: ConnectionStatusProps) {
  const tr = useUiTranslation();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showLoginDialog, setShowLoginDialog] = useState(false);
  const [checkingOta, setCheckingOta] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [tcpStatus, setTcpStatus] = useState<TcpWireStatus>(() => {
    if (typeof window === 'undefined') return {};
    return (window as unknown as { __RTX5_TCP_STATUS__?: TcpWireStatus }).__RTX5_TCP_STATUS__ || {};
  });

  const state = useWebSocketStore((snapshot) => snapshot.connectionState);
  const isStale = useWebSocketStore((snapshot) => snapshot.isStale);
  const lastLatency = useWebSocketStore((snapshot) => snapshot.fixConnectionState === 'connected'
    ? snapshot.fixMetrics.lastLatency
    : snapshot.legacyMetrics.lastLatency);
  const latencyMeasuredAt = useWebSocketStore((snapshot) => (snapshot.fixConnectionState === 'connected'
    ? snapshot.fixMetrics.latencyMeasuredAt
    : snapshot.legacyMetrics.latencyMeasuredAt) ?? null);
  const tradeWsConnected = useAppStore((snapshot) => showDropdown && snapshot.wsConnected);
  const tradeApiError = useAppStore((snapshot) => showDropdown ? snapshot.tradeApiStatus.error : null);
  const tradeApiLoading = useAppStore((snapshot) => showDropdown && snapshot.tradeApiStatus.loading);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onTcpStatus = (event: Event) => {
      const detail = (event as CustomEvent<TcpWireStatus>).detail;
      if (detail) setTcpStatus(detail);
    };
    window.addEventListener('rtx5-tcp-status', onTcpStatus);
    return () => window.removeEventListener('rtx5-tcp-status', onTcpStatus);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showDropdown]);

  useEffect(() => {
    const handleOpenLogin = () => {
      if ((window as Window & { __RTX_APP_ACTIVE__?: boolean }).__RTX_APP_ACTIVE__) return;
      setShowLoginDialog(true);
    };
    window.addEventListener('rtx:openLoginDialog', handleOpenLogin);
    return () => window.removeEventListener('rtx:openLoginDialog', handleOpenLogin);
  }, []);

  const accountStreamConnected = tradeWsConnected || state === 'connected';

  const getStatusDisplay = () => {
    switch (state) {
      case 'connected':
        return { color: 'bg-green-500', text: 'Connected', icon: Wifi, iconColor: 'text-green-400 [.rtx-advanced-view_&]:text-green-600' };
      case 'connecting':
        return { color: 'bg-yellow-500', text: 'Connecting...', icon: RefreshCw, iconColor: 'text-yellow-400 [.rtx-advanced-view_&]:text-yellow-600 animate-spin' };
      case 'disconnected':
        return { color: 'bg-red-500', text: 'Disconnected', icon: WifiOff, iconColor: 'text-red-400 [.rtx-advanced-view_&]:text-red-600' };
      case 'offline':
        return { color: 'bg-gray-500', text: 'Offline', icon: WifiOff, iconColor: 'text-gray-400 [.rtx-advanced-view_&]:text-gray-600' };
      case 'reconnecting':
        return { color: 'bg-yellow-500', text: 'Connecting...', icon: RefreshCw, iconColor: 'text-yellow-400 [.rtx-advanced-view_&]:text-yellow-600 animate-spin' };
      case 'error':
        return { color: 'bg-red-600', text: 'Error', icon: AlertTriangle, iconColor: 'text-red-400 [.rtx-advanced-view_&]:text-red-700' };
      default:
        return { color: 'bg-gray-500', text: 'Unknown', icon: WifiOff, iconColor: 'text-gray-400 [.rtx-advanced-view_&]:text-gray-600' };
    }
  };

  const status = isStale
    ? { color: 'bg-orange-500', text: 'Stale Data', icon: AlertTriangle, iconColor: 'text-orange-400 [.rtx-advanced-view_&]:text-orange-600' }
    : getStatusDisplay();
  const StatusIcon = status.icon;

  const handleLogin = () => {
    setShowDropdown(false);
    if (typeof window !== 'undefined' && (window as Window & { __RTX_APP_ACTIVE__?: boolean }).__RTX_APP_ACTIVE__) {
      window.dispatchEvent(new CustomEvent('rtx:openTradeAuth'));
    } else {
      setShowLoginDialog(true);
    }
  };

  const handleNetworkRescan = () => {
    if (reconnectCallback) reconnectCallback();
    setShowDropdown(false);
  };

  const handleOpenTcpServerDialog = () => {
    setShowDropdown(false);
    (window as unknown as { rtx5OpenTcpEndpointDialog?: () => void }).rtx5OpenTcpEndpointDialog?.();
  };

  const handleCheckOtaUpdate = async () => {
    setCheckingOta(true);
    try {
      await fetch('/api/tcp-client/ota-check', { method: 'POST' });
      const res = await fetch('/api/tcp-client/status', { cache: 'no-store' });
      if (res.ok) {
        const next = await res.json();
        (window as unknown as { __RTX5_TCP_STATUS__?: TcpWireStatus }).__RTX5_TCP_STATUS__ = next;
        window.dispatchEvent(new CustomEvent('rtx5-tcp-status', { detail: next }));
      }
    } catch {
      // Ignore network hiccup during manual check
    } finally {
      setCheckingOta(false);
      setShowDropdown(false);
    }
  };

  const wireRttMs = (typeof tcpStatus.avg_rtt_ms === 'number' && tcpStatus.avg_rtt_ms > 0)
    ? tcpStatus.avg_rtt_ms
    : (typeof tcpStatus.rtt_ms === 'number' && tcpStatus.rtt_ms > 0 ? tcpStatus.rtt_ms : null);

  const wsLatencyMs = lastLatency > 0 && latencyMeasuredAt !== null && now - latencyMeasuredAt <= 60_000 && state === 'connected'
    ? lastLatency : null;

  const latencyMs = state === 'connected' ? (wireRttMs ?? wsLatencyMs) : null;

  const tradeApiLabel = tradeApiError ? 'REST error' : tradeApiLoading ? 'syncing' : 'ready';
  const tradeApiColor = tradeApiError
    ? 'text-red-400'
    : tradeApiLoading
      ? 'text-yellow-400'
      : 'text-green-400';

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        data-connection-state={isStale ? 'stale' : state}
        aria-expanded={showDropdown}
        className="rtx-status-bar__connection flex items-center gap-1.5 rounded transition-colors"
        title={tr("Click for connection details")}
      >
        <div className={`rtx-status-bar__status-dot w-2 h-2 rounded-full ${status.color}`} />
        <span className="rtx-status-bar__metric font-normal text-[13px] leading-[19.5px]">
          {state === 'connected' ? (latencyMs !== null ? `${tr('Connected')} ${formatWireLatency(latencyMs)}` : tr('Connected'))
            : state === 'reconnecting' && !isStale ? tr("Reconnecting to server…") : tr(status.text)}
        </span>
        {isStale && (
          <span className="text-orange-400 text-[12px] font-normal ml-1 [.rtx-advanced-view_&]:text-orange-600">{tr("(Stale)")}</span>
        )}
        <StatusIcon size={12} className={`rtx-status-bar__status-icon ${status.iconColor}`} />
      </button>

      {showDropdown && (
        <div className="rtx-connection-dropdown absolute bottom-full right-0 mb-1 w-64 bg-[#1e222d] border border-[#3a3e4a] rounded shadow-2xl z-[100] text-[11px] text-zinc-200 overflow-hidden">
          <div className="border-b border-[#3a3e4a]">
            <button
              onClick={handleLogin}
              className="w-full flex items-center gap-2.5 px-3 py-[7px] hover:bg-[#2a3040] transition-colors text-left"
            >
              <LogIn size={14} className="text-blue-400" />
              <span>{tr("Login")}</span>
            </button>

            <button
              onClick={handleNetworkRescan}
              className="w-full flex items-center gap-2.5 px-3 py-[7px] hover:bg-[#2962FF] hover:text-white transition-colors text-left"
            >
              <Globe size={14} className="text-cyan-400" />
              <span>{tr("Network Rescan")}</span>
            </button>

            <div className="flex items-center justify-between px-3 py-[7px] hover:bg-[#2a3040] transition-colors cursor-default">
              <div className="flex items-center gap-2.5">
                <Zap size={14} className="text-yellow-400" />
                <span>{tr("VPS Hosting Speed Up")}</span>
              </div>
              <span className="text-zinc-400 text-[10px]">Unavailable</span>
            </div>

            <button
              onClick={handleOpenTcpServerDialog}
              className="w-full flex items-center justify-between gap-2.5 px-3 py-[7px] hover:bg-[#2a3040] transition-colors text-left"
            >
              <div className="flex items-center gap-2.5">
                <Server size={14} className="text-emerald-400" />
                <span>TCP Server (:4443)...</span>
              </div>
              <span className="text-zinc-500 font-mono text-[10px]">Alt+Shift+T</span>
            </button>

            <button
              onClick={() => { void handleCheckOtaUpdate(); }}
              disabled={checkingOta}
              className="w-full flex items-center justify-between gap-2.5 px-3 py-[7px] hover:bg-[#2a3040] transition-colors text-left disabled:opacity-60"
            >
              <div className="flex items-center gap-2.5">
                <Download size={14} className="text-amber-400" />
                <span>{checkingOta ? 'Checking OTA...' : 'Check OTA Update'}</span>
              </div>
              <span className="text-emerald-400 font-mono text-[10px]">Ed25519</span>
            </button>
          </div>

          <div className="border-b border-[#3a3e4a]">
            <div className="flex items-center justify-between px-3 py-[7px] hover:bg-[#2a3040] transition-colors cursor-default">
              <div className="flex items-center gap-2.5">
                <Server size={14} className="text-zinc-400" />
                <span>{tr("Trade API")}</span>
              </div>
              <span
                className={`text-[10px] font-mono ${tradeApiColor}`}
                title={tradeApiError ?? undefined}
              >
                {tr(tradeApiLabel)}
              </span>
            </div>
            <div className="flex items-center justify-between px-3 py-[7px] hover:bg-[#2a3040] transition-colors cursor-default">
              <div className="flex items-center gap-2.5">
                <Server size={14} className="text-zinc-400" />
                <span>{tr("Account Stream")}</span>
              </div>
              <span className={`text-[10px] font-mono ${accountStreamConnected ? 'text-green-400' : 'text-yellow-400'}`}>
                {accountStreamConnected ? tr("live") : tr("polling")}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#161921]">
            <div className="flex items-center gap-2">
              <Server size={12} className="text-zinc-500" />
              <span className={`font-mono text-[10px] ${latencyMs && latencyMs < 200 ? 'text-green-400' : 'text-yellow-400'}`}>
                {latencyMs !== null ? `RTT ${latencyMs.toFixed(2)} ms` : 'RTT unavailable'}
              </span>
            </div>
            {tcpStatus.ota?.up_to_date && (
              <span className="font-mono text-[9px] text-emerald-400">OTA OK</span>
            )}
          </div>
        </div>
      )}

      <RetainedLazyFeature active={showLoginDialog}>
        <LoginDialog
          isOpen={showLoginDialog}
          onClose={() => setShowLoginDialog(false)}
        />
      </RetainedLazyFeature>
    </div>
  );
}
