// Label format shared by every RTX5 app: "v1.0.0 (a1b2c3d)".
export const shortCommit = (commit: unknown): string => {
  const value = String(commit || '').trim();
  if (!value || value === 'unknown') return 'unknown';
  return value.slice(0, 7);
};

export const formatBuild = (version: unknown, commit: unknown): string => {
  const v = String(version || '').trim().replace(/^v/i, '');
  return v ? `v${v} (${shortCommit(commit)})` : '—';
};

type Build = { version?: string; commit?: string } | null | undefined;

/** Full badge text: "UI v1.0.0 (a1b2c3d) · Backend v1.0.0 (d4e5f6a)". */
export const formatVersionBadge = (ui: Build, backend: Build): string => (
  `UI ${formatBuild(ui?.version, ui?.commit)} · Backend ${backend ? formatBuild(backend.version, backend.commit) : '—'}`
);
