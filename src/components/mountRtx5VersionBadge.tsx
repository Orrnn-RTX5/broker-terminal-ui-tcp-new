import { createRoot } from 'react-dom/client';
import { Rtx5VersionBadge } from './Rtx5VersionBadge';

/** Mounts the version badge in its own root so it shows on every screen, login included. */
export function mountRtx5VersionBadge(backendUrl: string): void {
  if (typeof document === 'undefined' || document.querySelector('[data-rtx5-version-badge-root]')) return;
  const host = document.createElement('div');
  host.setAttribute('data-rtx5-version-badge-root', '');
  document.body.appendChild(host);
  createRoot(host).render(<Rtx5VersionBadge backendUrl={backendUrl} />);
}
