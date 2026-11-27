// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { canCheckTerminalUpdates, checkTerminalReleaseChannel } from './terminalUpdateChannel';

type HostWindow = Window & {
  rtx5CheckOTAUpdate?: unknown;
  rtx5SetOTAChannel?: unknown;
};

const host = window as HostWindow;

const releaseStatus = {
  enabled: true,
  channel: 'production',
  version: '1.2.18',
  up_to_date: true,
  ui_reload_ready: false,
  exe_restart_ready: false,
};

afterEach(() => {
  delete host.rtx5CheckOTAUpdate;
  delete host.rtx5SetOTAChannel;
});

describe('terminal release channel host bridge', () => {
  it('reports no capability and fails closed when the host injects no update functions', async () => {
    expect(canCheckTerminalUpdates()).toBe(false);
    await expect(checkTerminalReleaseChannel()).resolves.toEqual({ ok: false });
  });

  it('checks the release channel on a host that cannot switch channels (web terminal)', async () => {
    const check = vi.fn().mockResolvedValue({ ok: true, ota: releaseStatus });
    host.rtx5CheckOTAUpdate = check;

    expect(canCheckTerminalUpdates()).toBe(true);
    await expect(checkTerminalReleaseChannel()).resolves.toEqual({
      ok: true,
      state: 'up-to-date',
      version: '1.2.18',
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it.each(['beta', 'alpha', ' Beta '])('never reports a %s build as the release version', async (channel) => {
    host.rtx5CheckOTAUpdate = vi.fn().mockResolvedValue({ ok: true, ota: { ...releaseStatus, channel } });
    await expect(checkTerminalReleaseChannel()).resolves.toEqual({ ok: false });
  });

  it('moves a switch-capable host (desktop app) back to the release channel before checking', async () => {
    const calls: string[] = [];
    host.rtx5SetOTAChannel = vi.fn(async (channel: string) => {
      calls.push(`switch:${channel}`);
      return { ok: true, channel, ota: { ...releaseStatus, channel } };
    });
    host.rtx5CheckOTAUpdate = vi.fn(async () => {
      calls.push('check');
      return { ok: true, ota: { ...releaseStatus, version: '1.2.19', exe_restart_ready: true } };
    });

    await expect(checkTerminalReleaseChannel()).resolves.toEqual({
      ok: true,
      state: 'update-ready',
      version: '1.2.19',
    });
    expect(calls).toEqual(['switch:production', 'check']);
  });

  it('reports an applied interface update as ready', async () => {
    host.rtx5CheckOTAUpdate = vi.fn().mockResolvedValue({
      ok: true,
      ota: { ...releaseStatus, version: '1.2.19', ui_reload_ready: true },
    });

    await expect(checkTerminalReleaseChannel()).resolves.toEqual({
      ok: true,
      state: 'update-ready',
      version: '1.2.19',
    });
  });

  it('reports a newer version the host has not applied as available, not as up to date', async () => {
    host.rtx5CheckOTAUpdate = vi.fn().mockResolvedValue({
      ok: true,
      ota: { ...releaseStatus, version: ' 1.2.19 ', up_to_date: false },
    });

    await expect(checkTerminalReleaseChannel()).resolves.toEqual({
      ok: true,
      state: 'update-available',
      version: '1.2.19',
    });
  });

  it('treats a missing channel as the release channel and a missing version as unknown', async () => {
    host.rtx5CheckOTAUpdate = vi.fn().mockResolvedValue({ ok: true, ota: { up_to_date: true } });

    await expect(checkTerminalReleaseChannel()).resolves.toEqual({
      ok: true,
      state: 'up-to-date',
      version: null,
    });
  });

  it('does not check when the host refuses the channel switch', async () => {
    const check = vi.fn();
    host.rtx5SetOTAChannel = vi.fn().mockResolvedValue({ ok: false, error: 'offline' });
    host.rtx5CheckOTAUpdate = check;

    await expect(checkTerminalReleaseChannel()).resolves.toEqual({ ok: false });
    expect(check).not.toHaveBeenCalled();
  });

  it.each([
    ['a failed check', async () => ({ ok: false, error: 'OTA disabled', ota: releaseStatus })],
    ['an answer without update status', async () => ({ ok: true })],
    ['no answer', async () => null],
    ['a thrown error', async () => { throw new Error('network'); }],
  ])('fails closed on %s', async (_label, check) => {
    host.rtx5CheckOTAUpdate = vi.fn(check);
    await expect(checkTerminalReleaseChannel()).resolves.toEqual({ ok: false });
  });
});
