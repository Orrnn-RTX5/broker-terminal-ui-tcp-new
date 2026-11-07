// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rtx5VersionBadge } from './Rtx5VersionBadge';
import { formatBuild, shortCommit } from '../utils/rtx5BuildLabel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RTX5 version badge', () => {
  it('shows UI and backend builds in one line', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: '1.0.0', commit: 'd4e5f6a7b8c9d0' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Rtx5VersionBadge backendUrl="/api/v2/version" />);
    await waitFor(() => expect(screen.getByText(/Backend v1\.0\.0 \(d4e5f6a\)/)).toBeTruthy());
    expect(screen.getByText(/^UI v/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/version', { cache: 'no-store' });
  });

  it('shows a dash when the backend cannot say', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    render(<Rtx5VersionBadge backendUrl="/api/v2/version" />);
    await waitFor(() => expect(screen.getByText(/Backend —$/)).toBeTruthy());
  });

  it('formats builds the same way as every other RTX5 app', () => {
    expect(formatBuild('v1.0.0', 'a1b2c3d4e5f6')).toBe('v1.0.0 (a1b2c3d)');
    expect(shortCommit('')).toBe('unknown');
    expect(formatBuild('', 'x')).toBe('—');
  });
});

describe('RTX5 version badge placement', () => {
  it('docks inside the status bar slot instead of covering it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '1.0.0', commit: '5886961abcdef' }), { status: 200 })));
    const slot = document.createElement('span');
    slot.setAttribute('data-rtx5-version-slot', '');
    document.body.appendChild(slot);
    try {
      render(<Rtx5VersionBadge backendUrl="/api/v2/version" />);
      await waitFor(() => expect(slot.textContent).toMatch(/Backend v1\.0\.0 \(5886961\)/));
      const badge = slot.querySelector('[data-rtx5-version-badge]') as HTMLElement;
      expect(badge.getAttribute('data-rtx5-version-docked')).toBe('true');
      expect(badge.style.position).not.toBe('fixed');
      expect(document.querySelectorAll('[data-rtx5-version-badge]')).toHaveLength(1);
    } finally {
      slot.remove();
    }
  });

  it('stays in the bottom-right corner when there is no status bar (login screen)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    render(<Rtx5VersionBadge backendUrl="/api/v2/version" />);
    const badge = await waitFor(() => {
      const el = document.querySelector('[data-rtx5-version-badge]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(badge.style.position).toBe('fixed');
    expect(badge.getAttribute('data-rtx5-version-docked')).toBeNull();
  });
});
