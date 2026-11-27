// Bridge to the update functions the terminal's host injects into the page
// (rtx5-tcp-toolbar.js, served by the desktop client and by the web terminal
// server). The host fetches, verifies and applies updates; the UI only asks it
// to check the release channel and reports what the host answered.

const RELEASE_CHANNEL = 'production';

interface HostUpdateStatus {
  channel?: unknown;
  version?: unknown;
  up_to_date?: unknown;
  ui_reload_ready?: unknown;
  exe_restart_ready?: unknown;
}

interface HostUpdateResult {
  ok?: unknown;
  ota?: HostUpdateStatus | null;
}

type UpdateHostWindow = Window & {
  rtx5CheckOTAUpdate?: () => Promise<HostUpdateResult | null | undefined>;
  rtx5SetOTAChannel?: (channel: string) => Promise<HostUpdateResult | null | undefined>;
};

export type TerminalUpdateState =
  /** The host runs the latest release version. */
  | 'up-to-date'
  /** The host applied a newer version; a reload or restart activates it. */
  | 'update-ready'
  /** A newer version exists, but the host has not applied it. */
  | 'update-available';

export type TerminalUpdateCheck =
  | { ok: true; state: TerminalUpdateState; version: string | null }
  | { ok: false };

const updateHost = (): UpdateHostWindow | null => (
  typeof window === 'undefined' ? null : window as UpdateHostWindow
);

/** The host can check for updates: the desktop app and the web terminal both can. */
export const canCheckTerminalUpdates = (): boolean => (
  typeof updateHost()?.rtx5CheckOTAUpdate === 'function'
);

// Same default as the hosts: an absent or unknown channel is the release channel.
const isReleaseChannel = (channel: unknown): boolean => {
  const value = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
  return value !== 'beta' && value !== 'alpha';
};

const readVersion = (version: unknown): string | null => {
  const value = typeof version === 'string' ? version.trim() : '';
  return value || null;
};

/**
 * Asks the host for the latest release version. A host that can switch
 * channels (the desktop app, from its Connection & Updates dialog) is first
 * moved back to the release channel, so the answer is never about a
 * pre-release build. The result is only trusted when the host confirms it
 * checked the release channel.
 */
export const checkTerminalReleaseChannel = async (): Promise<TerminalUpdateCheck> => {
  const host = updateHost();
  if (typeof host?.rtx5CheckOTAUpdate !== 'function') return { ok: false };

  try {
    if (typeof host.rtx5SetOTAChannel === 'function') {
      const switched = await host.rtx5SetOTAChannel(RELEASE_CHANNEL);
      if (!switched || switched.ok === false) return { ok: false };
    }

    const result = await host.rtx5CheckOTAUpdate();
    const status = result?.ota;
    if (!result || result.ok === false || !status || !isReleaseChannel(status.channel)) {
      return { ok: false };
    }

    const version = readVersion(status.version);
    if (status.ui_reload_ready === true || status.exe_restart_ready === true) {
      return { ok: true, state: 'update-ready', version };
    }
    return { ok: true, state: status.up_to_date === false ? 'update-available' : 'up-to-date', version };
  } catch {
    return { ok: false };
  }
};
