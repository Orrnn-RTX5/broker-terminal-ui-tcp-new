// The one place every RTX5 app shows what it is running (same component in all 4 UI repos):
//   bottom-right corner:  UI v1.0.0 (a1b2c3d) · Backend v1.0.0 (d4e5f6a)
// UI values are baked in at build time; the backend answers its own version endpoint.
import React, { useEffect, useState } from 'react';
import { formatVersionBadge } from '../utils/rtx5BuildLabel';

declare const __RTX5_UI_VERSION__: string | undefined;
declare const __RTX5_UI_COMMIT__: string | undefined;
const UI_VERSION = typeof __RTX5_UI_VERSION__ === 'string' ? __RTX5_UI_VERSION__ : 'dev';
const UI_COMMIT = typeof __RTX5_UI_COMMIT__ === 'string' ? __RTX5_UI_COMMIT__ : 'unknown';
const REFRESH_MS = 60_000;

const badgeStyle: React.CSSProperties = {
  position: 'fixed',
  right: 8,
  bottom: 4,
  zIndex: 2147483000,
  padding: '2px 8px',
  borderRadius: 4,
  background: 'rgba(0, 0, 0, 0.6)',
  color: 'rgba(255, 255, 255, 0.8)',
  font: '11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};

type BackendBuild = { version?: string; commit?: string };

export function Rtx5VersionBadge({ backendUrl, refreshMs = REFRESH_MS }: { backendUrl: string; refreshMs?: number }) {
  const [backend, setBackend] = useState<BackendBuild | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(backendUrl, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as BackendBuild;
        if (active) setBackend({ version: data?.version, commit: data?.commit });
      } catch {
        if (active) setBackend(null);
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, refreshMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [backendUrl, refreshMs]);

  return (
    <div data-rtx5-version-badge style={badgeStyle} title="Build running in this app">
      {formatVersionBadge({ version: UI_VERSION, commit: UI_COMMIT }, backend)}
    </div>
  );
}
