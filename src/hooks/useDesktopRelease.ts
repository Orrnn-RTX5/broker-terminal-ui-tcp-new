import { FALLBACK_DESKTOP_RELEASE, type DesktopRelease } from '../services/desktopRelease';

export type DesktopReleaseStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseDesktopReleaseResult {
  release: DesktopRelease;
  status: DesktopReleaseStatus;
  error: Error | null;
}

// Pure Binary TCP Desktop Mode — Always native desktop, never polls external release servers
export const useDesktopRelease = (_options: { enabled?: boolean } = {}): UseDesktopReleaseResult => {
  return {
    release: FALLBACK_DESKTOP_RELEASE,
    status: 'idle',
    error: null,
  };
};

