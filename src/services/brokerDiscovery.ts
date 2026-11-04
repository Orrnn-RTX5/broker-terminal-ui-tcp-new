export interface BrokerDiscoveryItem {
  broker_id?: string;
  broker_name?: string;
  display_server?: string;
  tcp_addr?: string;
  host?: string;
  tcp_port?: number;
  name?: string;
  id?: string | number;
  server?: string;
  server_url?: string;
  backend_url?: string;
  market_api_url?: string;
  server_ip?: string;
  server_port?: number;
  logo_url?: string;
  region?: string;
  [key: string]: unknown;
}

export const formatBrokerDisplayServer = (
  broker: {
    broker_name?: unknown;
    name?: unknown;
    broker_id?: unknown;
    tcp_addr?: unknown;
    display_server?: unknown;
  } | null | undefined,
): string => {
  if (!broker) return '';
  const brokerName = String(broker.broker_name ?? broker.name ?? broker.broker_id ?? '').trim();
  const tcpAddr = String(broker.tcp_addr ?? '').trim();
  if (brokerName && tcpAddr) {
    return `${brokerName} (${tcpAddr})`;
  }
  return String(broker.display_server ?? brokerName).trim();
};

export const switchDesktopTcpBroker = async (
  broker: {
    broker_id?: unknown;
    broker_name?: unknown;
    name?: unknown;
    tcp_addr?: unknown;
  } | null | undefined,
): Promise<boolean> => {
  if (!broker) return false;
  const brokerId = String(broker.broker_id ?? '').trim();
  const brokerName = String(broker.broker_name ?? broker.name ?? brokerId).trim();
  const tcpAddr = String(broker.tcp_addr ?? '').trim();
  if (!tcpAddr) return false;

  if (typeof globalThis !== 'undefined') {
    const win = globalThis as unknown as Record<string, unknown>;
    const displayServer = brokerName ? `${brokerName} (${tcpAddr})` : tcpAddr;
    for (const key of ['__RTX5_RUNTIME_CONFIG__', '__RTX_RUNTIME_CONFIG__', 'RUNTIME_CONFIG', '__RUNTIME_CONFIG__']) {
      const cfg = win[key];
      if (cfg && typeof cfg === 'object') {
        const record = cfg as Record<string, unknown>;
        if (brokerId) {
          record.BROKER_ID = brokerId;
          record.FEED_BROKER_ID = brokerId;
        }
        if (brokerName) {
          record.BROKER_NAME = brokerName;
          record.DEFAULT_MT5_SERVER = brokerName;
        }
        record.TCP_SERVER_ADDR = tcpAddr;
        record.DISPLAY_SERVER = displayServer;
      }
    }
    const tcpStatus = win.__RTX5_TCP_STATUS__;
    if (tcpStatus && typeof tcpStatus === 'object') {
      const statusRecord = tcpStatus as Record<string, unknown>;
      if (brokerId) statusRecord.broker_id = brokerId;
      if (brokerName) statusRecord.broker_name = brokerName;
      statusRecord.target_tcp = tcpAddr;
    }
  }

  try {
    const response = await fetch('/api/tcp-client/switch-broker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        broker_id: brokerId,
        broker_name: brokerName,
        tcp_addr: tcpAddr,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const arrayFromObjectPayload = (payload: Record<string, unknown>): unknown[] => {
  const candidates = [
    payload.brokers,
    payload.servers,
    payload.data,
    payload.result,
    payload.rows,
    payload.items,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = arrayFromObjectPayload(candidate as Record<string, unknown>);
      if (nested.length > 0) return nested;
    }
  }

  return [];
};

export const extractBrokerDiscoveryList = (payload: unknown): BrokerDiscoveryItem[] => {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? arrayFromObjectPayload(payload as Record<string, unknown>)
      : [];

  return rows
    .filter((row): row is BrokerDiscoveryItem => Boolean(row && typeof row === 'object'))
    .map((row) => {
      const brokerId = String(row.broker_id ?? row.id ?? '').trim();
      const brokerName = String(row.broker_name ?? row.name ?? brokerId).trim();
      const explicitTcpAddr = String(row.tcp_addr ?? '').trim();
      const host = String(row.host ?? '').trim();
      const tcpPort = Number(row.tcp_port ?? 0);
      const tcpAddr = explicitTcpAddr || (host ? `${host}:${tcpPort > 0 ? tcpPort : 4443}` : '');
      const displayServer = tcpAddr && (brokerName || brokerId)
        ? `${brokerName || brokerId} (${tcpAddr})`
        : String(row.display_server ?? '').trim();

      return {
        ...row,
        broker_id: brokerId,
        broker_name: brokerName || brokerId,
        ...(tcpAddr ? { tcp_addr: tcpAddr } : {}),
        ...(displayServer ? { display_server: displayServer } : {}),
      };
    })
    .filter((row) => Boolean(row.broker_id && row.broker_name));
};

const SUSPENDED_BROKER_STATUSES = new Set(['suspended', 'disabled', 'inactive', 'deleted']);

export const isBrokerSuspended = (broker: BrokerDiscoveryItem | null | undefined): boolean => {
  if (!broker) return false;
  if (broker.active === false || broker.enabled === false) return true;
  const status = String(broker.status ?? '').trim().toLowerCase();
  return SUSPENDED_BROKER_STATUSES.has(status);
};

// Desktop login must use the address published in the directory, never an
// environment fallback or an address reconstructed from the broker name/IP.
export const getDirectoryBrokerServerUrl = (broker: BrokerDiscoveryItem | null | undefined): string => {
  const value = String(broker?.server_url || '').trim().replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return value;
  } catch {
    return '';
  }
};

export const isDirectoryBrokerSelectable = (broker: BrokerDiscoveryItem | null | undefined): boolean =>
  Boolean(broker && !isBrokerSuspended(broker) && getDirectoryBrokerServerUrl(broker));

export const firstSelectableBroker = <T extends BrokerDiscoveryItem>(
  brokers: T[],
): T | undefined => brokers.find((broker) => !isBrokerSuspended(broker));

export const filterBrokerDirectory = <T extends BrokerDiscoveryItem>(
  brokers: T[],
  query: string,
  selectedBroker: T | null,
): T[] => {
  const normalizedQuery = query.trim().toLowerCase();
  // The login input is pre-filled with the selected broker's name; treating that
  // as a filter would hide the rest of the superadmin directory when the dropdown
  // opens, so an exact self-match lists every broker instead.
  if (
    selectedBroker
    && (
      normalizedQuery === String(selectedBroker.broker_name || '').trim().toLowerCase()
      || normalizedQuery === formatBrokerDisplayServer(selectedBroker).toLowerCase()
    )
  ) {
    const current = brokers.find((broker) => broker.broker_id === selectedBroker.broker_id);
    return current ? [current, ...brokers.filter((broker) => broker !== current)] : brokers;
  }
  if (!normalizedQuery) return brokers;
  return brokers.filter((broker) => (
    String(broker.broker_name || '').toLowerCase().includes(normalizedQuery)
    || String(broker.broker_id || '').toLowerCase().includes(normalizedQuery)
    || String(broker.tcp_addr || '').toLowerCase().includes(normalizedQuery)
    || String(broker.display_server || '').toLowerCase().includes(normalizedQuery)
    || String(broker.region || '').toLowerCase().includes(normalizedQuery)
  ));
};
