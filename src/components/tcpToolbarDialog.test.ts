import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_TOOLBAR_PATH = resolve(process.cwd(), 'web-terminal-server/tcp_toolbar.js');
const DESKTOP_TOOLBAR_PATH = resolve(process.cwd(), 'desktop-clients/clientcore/tcp_toolbar.js');

const mockStatusPayload = {
  connected: true,
  target_tcp: '51.195.188.172:4443',
  broker_id: 'orrnn',
  broker_name: 'Orrnn',
  rtt_ms: 174.7,
  avg_rtt_ms: 178.29,
  dll_verified: true,
  cipher: 'X25519 + HKDF-SHA256 + AES-256-GCM',
  ota: {
    enabled: true,
    channel: 'production',
    up_to_date: true,
    release_id: 'rtx5-tcp-ota-20261118-135014',
    ui_source: 'ota-hot-cache',
  },
};

type ToolbarWindow = Window & {
  __RTX5_TCP_TOOLBAR__?: boolean;
  __RTX5_TCP_STATUS__?: unknown;
  rtx5OpenTcpEndpointDialog?: () => Promise<void>;
  rtx5CheckOTAUpdate?: () => Promise<unknown>;
  rtx5SetOTAChannel?: (channel: string) => Promise<unknown>;
};

function loadToolbarScript(scriptPath: string) {
  const win = window as ToolbarWindow;
  delete win.__RTX5_TCP_TOOLBAR__;
  const src = readFileSync(scriptPath, 'utf8');
  window.eval(src);
}

describe.each([
  ['web-terminal-server/tcp_toolbar.js', WEB_TOOLBAR_PATH, false],
  ['desktop-clients/clientcore/tcp_toolbar.js', DESKTOP_TOOLBAR_PATH, true],
])('%s', (_label, scriptPath, hasChannelSelector) => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    document.head.innerHTML = '';
    document.body.innerHTML = '';

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/tcp-client/status')) {
        return new Response(JSON.stringify(mockStatusPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/tcp-client/brokers')) {
        return new Response(
          JSON.stringify([
            {
              broker_id: 'orrnn',
              broker_name: 'Orrnn',
              tcp_addr: '51.195.188.172:4443',
              online: true,
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/tcp-client/ota-check')) {
        return new Response(JSON.stringify({ ok: true, ota: mockStatusPayload.ota }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/tcp-client/ota-channel')) {
        return new Response(
          JSON.stringify({
            ok: true,
            channel: 'beta',
            ota: { ...mockStatusPayload.ota, channel: 'beta' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (window as ToolbarWindow).__RTX5_TCP_TOOLBAR__;
  });

  it('hides internal IP, port, protocol, cipher, DLL, OTA hashes, and status pill while keeping backdrop clear and text white', async () => {
    loadToolbarScript(scriptPath);
    await (window as ToolbarWindow).rtx5OpenTcpEndpointDialog?.();

    const styleEl = document.getElementById('rtx5-tcp-dialog-styles');
    expect(styleEl).not.toBeNull();
    const css = styleEl?.textContent ?? '';
    expect(css).toContain('background: transparent !important;');
    expect(css).toContain('backdrop-filter: none !important;');
    expect(css).toContain('-webkit-backdrop-filter: none !important;');
    expect(css).not.toContain('backdrop-filter:blur');
    expect(css).not.toContain('backdrop-filter: blur');

    // App-native theme surfaces and pure white dark-mode text
    expect(css).toContain('var(--bg-secondary');
    expect(css).toContain('var(--bg-quaternary');
    expect(css).toContain('var(--border-primary');
    expect(css).toContain('--tcp-text: #ffffff;');
    expect(css).toContain('var(--rtx-dark-accent');
    expect(css).toContain('var(--rtx-light-elevated');
    expect(css).toContain('var(--rtx-light-accent');
    expect(css).not.toMatch(/#(34d399|7dd3fc|60a5fa|10b981|fbbf24|0f172a|020617)/i);

    const backdrop = document.getElementById('rtx5-tcp-endpoint-backdrop');
    expect(backdrop).not.toBeNull();
    const sheet = backdrop?.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(sheet).not.toBeNull();
    expect(sheet?.getAttribute('aria-modal')).toBe('true');

    // Must not expose any internal infrastructure info in the DOM
    const html = sheet?.innerHTML ?? '';
    const text = sheet?.textContent ?? '';
    expect(html).not.toContain('51.195.188.172');
    expect(html).not.toContain(':4443');
    expect(html).not.toContain('rtx5_guard.dll');
    expect(html).not.toContain('X25519');
    expect(html).not.toContain('AES-256-GCM');
    expect(html).not.toContain('RTX\\x05');
    expect(html).not.toContain('Ed25519');
    expect(html).not.toContain('ota-hot-cache');
    expect(html).not.toContain('rtx5-tcp-ota-20261118-135014');
    expect(text).not.toContain('CONNECTED · BINARY TCP');
    expect(document.getElementById('rtx5-tcp-status-pill')).toBeNull();
    expect(sheet?.querySelector('.rtx5-tcp-emblem')).toBeNull();
    expect(document.getElementById('rtx5-tcp-addr-input')).toBeNull();
    expect(document.getElementById('rtx5-tcp-id-input')).toBeNull();

    // Displays clean user-facing connection info
    expect(document.getElementById('rtx5-tcp-server-name')?.textContent).toBe('Orrnn');
    expect(document.getElementById('rtx5-tcp-conn-state')?.textContent).toBe('Connected');
    expect(document.getElementById('rtx5-tcp-rtt-main')?.textContent).toBe('174.7 ms (avg 178.3 ms)');
    expect(document.getElementById('rtx5-tcp-security-state')?.textContent).toBe('Encrypted & Verified');
    expect(document.getElementById('rtx5-ota-status-line')?.textContent).toBe('Up to date');

    const channelSelect = document.getElementById('rtx5-ota-channel-select');
    if (hasChannelSelector) {
      expect(channelSelect).not.toBeNull();
    } else {
      expect(channelSelect).toBeNull();
    }
  });

  it('refreshes live latency and status and supports Escape dismissal', async () => {
    loadToolbarScript(scriptPath);
    await (window as ToolbarWindow).rtx5OpenTcpEndpointDialog?.();

    window.dispatchEvent(
      new CustomEvent('rtx5-tcp-status', {
        detail: { ...mockStatusPayload, connected: false, rtt_ms: 42.5, avg_rtt_ms: 45.1 },
      }),
    );
    expect(document.getElementById('rtx5-tcp-conn-state')?.textContent).toBe('Reconnecting');
    expect(document.getElementById('rtx5-tcp-rtt-main')?.textContent).toBe('42.5 ms (avg 45.1 ms)');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('rtx5-tcp-endpoint-backdrop')).toBeNull();
  });

  it('closes on clean backdrop click without closing when dragging from inside the sheet', async () => {
    loadToolbarScript(scriptPath);
    await (window as ToolbarWindow).rtx5OpenTcpEndpointDialog?.();

    const backdrop = document.getElementById('rtx5-tcp-endpoint-backdrop') as HTMLElement;
    const sheet = backdrop.querySelector('.rtx5-tcp-sheet') as HTMLElement;

    sheet.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('rtx5-tcp-endpoint-backdrop')).not.toBeNull();

    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('rtx5-tcp-endpoint-backdrop')).toBeNull();
  });
});
