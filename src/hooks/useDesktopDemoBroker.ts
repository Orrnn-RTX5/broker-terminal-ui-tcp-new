import { useEffect, useState } from 'react';
import { getRuntimeBrokerConfiguration } from '../config/backendTarget.js';
import { loadAppBrokerDirectory } from '../services/brokerDirectory';
import { isDirectoryBrokerSelectable, type BrokerDiscoveryItem } from '../services/brokerDiscovery';
import type { BrokerLoginPolicy } from '../services/brokerLoginPolicy';

interface TcpClientStatus {
  broker_id?: unknown;
  target_tcp?: unknown;
  connected?: unknown;
}

export interface DesktopDemoBroker {
  policy: BrokerLoginPolicy;
  /** Directory row of the broker server this terminal is connected to. */
  broker: BrokerDiscoveryItem | null;
}

export const DESKTOP_DEMO_DIRECTORY_UNAVAILABLE_MESSAGE =
  'Demo accounts are unavailable because the broker servers could not be loaded. Please try again.';
export const DESKTOP_DEMO_BROKER_UNKNOWN_MESSAGE =
  'Demo accounts are unavailable because the connected broker server is not in the broker list.';
export const DESKTOP_DEMO_NOT_CONNECTED_MESSAGE =
  'The terminal is not connected to the broker server. Nothing was created. Please try again in a moment.';
export const DESKTOP_DEMO_BROKER_CHANGED_MESSAGE =
  'The terminal is now connected to a different broker server. Nothing was created. Close this window and try again.';

const text = (value: unknown): string => String(value ?? '').trim();

const readTcpStatus = (): TcpClientStatus => {
  if (typeof window === 'undefined') return {};
  const status = (window as unknown as { __RTX5_TCP_STATUS__?: TcpClientStatus }).__RTX5_TCP_STATUS__;
  return status && typeof status === 'object' ? status : {};
};

// A desktop terminal reaches exactly one broker: the one its encrypted TCP
// link is connected to. A demo account can only be opened there, so that link
// (not a saved session or a packaged default) names the broker.
const readConnectedBrokerKey = (): string => {
  const status = readTcpStatus();
  const brokerId = text(status.broker_id) || text(getRuntimeBrokerConfiguration().brokerId);
  return JSON.stringify([brokerId, text(status.target_tcp)]);
};

const matchesTcpStatus = (broker: BrokerDiscoveryItem, brokerId: string, tcpAddr: string): boolean =>
  brokerId ? text(broker.broker_id) === brokerId : Boolean(tcpAddr && text(broker.tcp_addr) === tcpAddr);

const failedPolicy = (error: string): BrokerLoginPolicy => ({
  status: 'error', brokerId: '', displayName: '', locked: true, local: false, error,
});

/**
 * Names the broker a desktop demo account would be opened at: the directory
 * row of the server the terminal is connected to. Returns null while closed
 * or while the directory is loading.
 */
export const useDesktopDemoBroker = (active: boolean): DesktopDemoBroker | null => {
  const [connectedKey, setConnectedKey] = useState(readConnectedBrokerKey);
  const [directory, setDirectory] = useState<{ key: string; rows: BrokerDiscoveryItem[] | null; error: boolean } | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    const sync = () => setConnectedKey(readConnectedBrokerKey());
    sync();
    window.addEventListener('rtx5-tcp-status', sync);
    return () => window.removeEventListener('rtx5-tcp-status', sync);
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    loadAppBrokerDirectory({ desktop: true })
      .then((rows) => { if (alive) setDirectory({ key: connectedKey, rows, error: false }); })
      .catch(() => { if (alive) setDirectory({ key: connectedKey, rows: null, error: true }); });
    return () => {
      alive = false;
      // An answer never outlives the dialog or the connection it was read for.
      setDirectory(null);
    };
  }, [active, connectedKey]);

  if (!active || !directory || directory.key !== connectedKey) return null;
  if (directory.error || !directory.rows) {
    return { policy: failedPolicy(DESKTOP_DEMO_DIRECTORY_UNAVAILABLE_MESSAGE), broker: null };
  }
  const [brokerId, tcpAddr] = JSON.parse(connectedKey) as [string, string];
  const broker = directory.rows.find(row => isDirectoryBrokerSelectable(row) && matchesTcpStatus(row, brokerId, tcpAddr));
  if (!broker) return { policy: failedPolicy(DESKTOP_DEMO_BROKER_UNKNOWN_MESSAGE), broker: null };
  return {
    policy: {
      status: 'ready',
      brokerId: text(broker.broker_id),
      displayName: text(broker.broker_name) || text(broker.broker_id),
      locked: true,
      local: false,
    },
    broker,
  };
};

/**
 * The broker creates a public demo account on whichever server the terminal
 * is connected to, whatever the request names. Ask the TCP link itself right
 * before sending, so an account is never opened at a broker other than the
 * one shown in the form.
 */
export const assertTerminalConnectedToBroker = async (broker: BrokerDiscoveryItem): Promise<void> => {
  let status: TcpClientStatus | null = null;
  try {
    const response = await fetch('/api/tcp-client/status', { cache: 'no-store' });
    if (response.ok) {
      const body: unknown = await response.json();
      if (body && typeof body === 'object') status = body as TcpClientStatus;
    }
  } catch {
    status = null;
  }
  if (!status || status.connected !== true) throw new Error(DESKTOP_DEMO_NOT_CONNECTED_MESSAGE);
  if (!matchesTcpStatus(broker, text(status.broker_id), text(status.target_tcp))) {
    throw new Error(DESKTOP_DEMO_BROKER_CHANGED_MESSAGE);
  }
};
