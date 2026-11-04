// Pure Binary TCP Desktop Mode — Zero GitHub / External Release Polling
export const DESKTOP_RELEASE_REPOSITORY = '';
export const DESKTOP_RELEASE_API_URL = '';
export const DESKTOP_RELEASE_LATEST_URL = '';

export interface DesktopRelease {
  version: string | null;
  tagName: string | null;
  releaseUrl: string;
  downloadUrl: string;
  assetName: string | null;
  assetSize: number | null;
}

export const FALLBACK_DESKTOP_RELEASE: DesktopRelease = {
  version: null,
  tagName: null,
  releaseUrl: '',
  downloadUrl: '',
  assetName: null,
  assetSize: null,
};

export const normalizeDesktopRelease = (): DesktopRelease => FALLBACK_DESKTOP_RELEASE;
export const clearDesktopReleaseCache = (): void => {};

export const loadLatestDesktopRelease = async (): Promise<DesktopRelease> => {
  return FALLBACK_DESKTOP_RELEASE;
};

export const getDesktopReleaseVersionLabel = (release: DesktopRelease | null | undefined): string => {
  return release?.version ? `v${release.version}` : '';
};

export const getDesktopReleaseButtonTitle = (): string => '';

export const openDesktopReleaseDownload = (): void => {};

