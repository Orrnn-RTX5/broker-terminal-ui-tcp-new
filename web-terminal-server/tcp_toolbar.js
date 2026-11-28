(function () {
  if (window.__RTX5_TCP_TOOLBAR__) return;
  window.__RTX5_TCP_TOOLBAR__ = true;

  var latestStatus = {
    connected: true,
    target_tcp: (window.__RTX5_RUNTIME_CONFIG__ && window.__RTX5_RUNTIME_CONFIG__.TCP_SERVER_ADDR) || '127.0.0.1:4443',
    broker_id: (window.__RTX5_RUNTIME_CONFIG__ && window.__RTX5_RUNTIME_CONFIG__.BROKER_ID) || '',
    broker_name: (window.__RTX5_RUNTIME_CONFIG__ && window.__RTX5_RUNTIME_CONFIG__.BROKER_NAME) || 'Trading Server',
    rtt_ms: 0,
    avg_rtt_ms: 0,
    dll_verified: true,
    ota: { enabled: true, up_to_date: true }
  };
  window.__RTX5_TCP_STATUS__ = latestStatus;

  var activeModalCleanup = null;

  var ICON_CLOSE =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="18" y1="6" x2="6" y2="18"/>' +
      '<line x1="6" y1="6" x2="18" y2="18"/>' +
    '</svg>';

  var ICON_REFRESH =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
      '<path d="M3 3v5h5"/>' +
      '<path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>' +
      '<path d="M16 16h5v5"/>' +
    '</svg>';

  var ICON_CONNECT =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5 12h14"/>' +
      '<path d="m12 5 7 7-7 7"/>' +
    '</svg>';

  var ICON_ALERT =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10"/>' +
      '<line x1="12" y1="8" x2="12" y2="12"/>' +
      '<line x1="12" y1="16" x2="12.01" y2="16"/>' +
    '</svg>';

  var ICON_CHEVRON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="6 9 12 15 18 9"/>' +
    '</svg>';

  function escapeHtml(val) {
    return String(val == null ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatLatency(st) {
    if (st && st.rtt_ms > 0) {
      var avg = st.avg_rtt_ms > 0 ? st.avg_rtt_ms : st.rtt_ms;
      return st.rtt_ms.toFixed(1) + ' ms (avg ' + avg.toFixed(1) + ' ms)';
    }
    return '< 1 ms';
  }

  function formatUpdateStatus(ota) {
    if (ota && (ota.exe_restart_ready || ota.ui_reload_ready)) {
      return 'Update ready to apply';
    }
    return 'Up to date';
  }

  function syncPrimaryButtonContrast(btn, container) {
    if (!btn || !container || !window.getComputedStyle) return;
    try {
      var bg = window.getComputedStyle(btn).backgroundColor || '';
      var m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (!m) return;
      var lum = (0.299 * parseInt(m[1], 10) + 0.587 * parseInt(m[2], 10) + 0.114 * parseInt(m[3], 10)) / 255;
      container.style.setProperty('--tcp-accent-fg', lum > 0.64 ? '#111111' : '#ffffff');
    } catch { /* Keep default --tcp-accent-fg if computed style lookup fails */ }
  }

  function ensureStyles() {
    var existing = document.getElementById('rtx5-tcp-dialog-styles');
    if (existing) return;

    var style = document.createElement('style');
    style.id = 'rtx5-tcp-dialog-styles';
    style.textContent = [
      '@keyframes rtx5-tcp-rise {',
      '  from { opacity: 0; transform: translate3d(0, 6px, 0) scale(0.988); }',
      '  to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }',
      '}',
      '@keyframes rtx5-tcp-spin {',
      '  from { transform: rotate(0deg); }',
      '  to { transform: rotate(360deg); }',
      '}',

      /* Backdrop: completely clear, zero blur, zero dimming so live chart stays 100% visible */
      '#rtx5-tcp-endpoint-backdrop {',
      '  position: fixed !important;',
      '  inset: 0 !important;',
      '  z-index: 2147483640 !important;',
      '  display: flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  padding: 16px !important;',
      '  background: transparent !important;',
      '  backdrop-filter: none !important;',
      '  -webkit-backdrop-filter: none !important;',
      '  box-sizing: border-box !important;',
      '}',

      '#rtx5-tcp-endpoint-backdrop * {',
      '  box-sizing: border-box;',
      '}',

      /* App-native professional sheet with crisp white text in dark mode */
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-sheet {',
      '  --tcp-font-sans: var(--rtx-ui-font-family, var(--font-sans, "Segoe UI", Tahoma, Arial, sans-serif));',
      '  --tcp-font-mono: var(--font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);',
      '  --tcp-surface: var(--bg-secondary, var(--rtx-dark-bg-secondary, #1f1f1f));',
      '  --tcp-chrome: var(--bg-secondary, var(--rtx-dark-bg-secondary, #1f1f1f));',
      '  --tcp-recessed: color-mix(in srgb, var(--tcp-surface) 84%, #000000);',
      '  --tcp-control-bg: var(--bg-quaternary, var(--rtx-dark-bg-quaternary, #2a2a2a));',
      '  --tcp-control-hover: color-mix(in srgb, var(--tcp-control-bg) 88%, #ffffff);',
      '  --tcp-field-bg: var(--bg-quaternary, var(--rtx-dark-bg-quaternary, #2a2a2a));',
      '  --tcp-field-hover: color-mix(in srgb, var(--tcp-field-bg) 92%, #ffffff);',
      '  --tcp-border: var(--border-primary, var(--rtx-dark-border-primary, #444444));',
      '  --tcp-border-strong: var(--border-tertiary, var(--rtx-dark-border-tertiary, #555555));',
      '  --tcp-divider: color-mix(in srgb, var(--tcp-border) 62%, transparent);',
      '  --tcp-text: #ffffff;',
      '  --tcp-text-secondary: rgba(255, 255, 255, 0.88);',
      '  --tcp-text-muted: rgba(255, 255, 255, 0.72);',
      '  --tcp-accent: var(--rtx-dark-accent, var(--rtx-toolbox-selected, #0078d7));',
      '  --tcp-accent-hover: var(--color-primary-hover, color-mix(in srgb, var(--tcp-accent) 88%, #ffffff));',
      '  --tcp-accent-active: var(--color-primary-active, color-mix(in srgb, var(--tcp-accent) 84%, #000000));',
      '  --tcp-accent-fg: #ffffff;',
      '  --tcp-focus-ring: color-mix(in srgb, var(--tcp-accent) 28%, transparent);',
      '  --tcp-err-fg: #ffffff;',
      '  --tcp-err-bg: color-mix(in srgb, var(--color-loss, #dc2626) 22%, var(--tcp-surface));',
      '  --tcp-err-border: color-mix(in srgb, var(--color-loss, #dc2626) 55%, var(--tcp-border));',
      '  --tcp-shadow: 0 24px 60px rgba(0, 0, 0, 0.62), 0 6px 20px rgba(0, 0, 0, 0.42);',

      '  width: 440px;',
      '  max-width: calc(100vw - 24px);',
      '  max-height: calc(100dvh - 28px);',
      '  display: flex;',
      '  flex-direction: column;',
      '  background: var(--tcp-surface) !important;',
      '  background-image: none !important;',
      '  color: var(--tcp-text) !important;',
      '  border: 1px solid var(--tcp-border) !important;',
      '  border-radius: 10px !important;',
      '  box-shadow: var(--tcp-shadow) !important;',
      '  overflow: hidden;',
      '  color-scheme: dark;',
      '  animation: rtx5-tcp-rise 140ms cubic-bezier(0.16, 1, 0.3, 1);',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  font-family: var(--tcp-font-sans);',
      '  -webkit-font-smoothing: antialiased;',
      '}',

      /* Light theme & all 30+ light presets */
      'html.rtx-skin-untitled-light #rtx5-tcp-endpoint-backdrop .rtx5-tcp-sheet,',
      'html.theme-light #rtx5-tcp-endpoint-backdrop .rtx5-tcp-sheet {',
      '  --tcp-surface: var(--rtx-light-elevated, var(--bg-elevated, #ffffff));',
      '  --tcp-chrome: var(--rtx-light-panel-subtle, var(--bg-tertiary, #f1f4f8));',
      '  --tcp-recessed: var(--rtx-light-panel, var(--bg-secondary, #f8fafc));',
      '  --tcp-control-bg: var(--rtx-light-panel-subtle, var(--bg-tertiary, #f1f4f8));',
      '  --tcp-control-hover: var(--rtx-light-hover, var(--bg-quaternary, #e8eef6));',
      '  --tcp-field-bg: var(--rtx-light-field, #ffffff);',
      '  --tcp-field-hover: var(--rtx-light-field, #ffffff);',
      '  --tcp-border: var(--rtx-light-border-strong, var(--border-secondary, #cbd5e1));',
      '  --tcp-border-strong: var(--rtx-light-control-border, var(--border-tertiary, #697b91));',
      '  --tcp-divider: var(--rtx-light-border, var(--border-primary, #dce2e9));',
      '  --tcp-text: var(--rtx-light-text, var(--text-primary, #182230));',
      '  --tcp-text-secondary: var(--rtx-light-text-secondary, var(--text-secondary, #334155));',
      '  --tcp-text-muted: var(--rtx-light-text-muted, var(--text-tertiary, #475569));',
      '  --tcp-accent: var(--rtx-light-accent, var(--color-primary, #2457a7));',
      '  --tcp-accent-hover: var(--rtx-light-accent-strong, var(--color-primary-hover, #1e4788));',
      '  --tcp-accent-active: var(--rtx-light-accent-pressed, var(--color-primary-active, #173768));',
      '  --tcp-focus-ring: var(--rtx-light-focus-ring, color-mix(in srgb, var(--tcp-accent) 18%, transparent));',
      '  --tcp-err-fg: var(--color-loss, #b91c1c);',
      '  --tcp-err-bg: color-mix(in srgb, var(--color-loss, #b91c1c) 8%, var(--tcp-surface));',
      '  --tcp-err-border: color-mix(in srgb, var(--color-loss, #b91c1c) 35%, var(--tcp-border));',
      '  --tcp-shadow: 0 20px 50px rgba(15, 23, 42, 0.18), 0 4px 14px rgba(15, 23, 42, 0.08);',
      '  color-scheme: light;',
      '}',

      /* Header */
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-header {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 12px;',
      '  padding: 14px 16px 14px 18px;',
      '  background: var(--tcp-chrome) !important;',
      '  border-bottom: 1px solid var(--tcp-divider) !important;',
      '  cursor: move;',
      '  user-select: none;',
      '  flex-shrink: 0;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-header.is-dragging {',
      '  cursor: grabbing;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-header-left {',
      '  display: flex;',
      '  align-items: center;',
      '  min-width: 0;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-title-wrap {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 1px;',
      '  min-width: 0;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-title {',
      '  margin: 0;',
      '  color: var(--tcp-text) !important;',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  --rtx-type-size: 13.5px;',
      '  --rtx-type-weight: 600;',
      '  font-family: var(--tcp-font-sans);',
      '  font-size: 13.5px;',
      '  font-weight: 600;',
      '  line-height: 18px !important;',
      '  letter-spacing: -0.01em;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-subtitle {',
      '  color: var(--tcp-text-muted) !important;',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  --rtx-type-size: 11.5px;',
      '  --rtx-type-weight: 400;',
      '  font-family: var(--tcp-font-sans);',
      '  font-size: 11.5px;',
      '  font-weight: 400;',
      '  line-height: 15px;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-close-btn {',
      '  width: 28px;',
      '  height: 28px;',
      '  padding: 0;',
      '  border: 1px solid transparent !important;',
      '  border-radius: 6px;',
      '  background: transparent !important;',
      '  color: var(--tcp-text-secondary) !important;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  cursor: pointer;',
      '  flex-shrink: 0;',
      '  transition: background-color 120ms ease, color 120ms ease;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-close-btn:hover {',
      '  background: var(--tcp-control-bg) !important;',
      '  color: var(--tcp-text) !important;',
      '}',

      /* Body */
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-body {',
      '  padding: 16px 18px;',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 14px;',
      '  overflow-y: auto;',
      '  overscroll-behavior: contain;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-section {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 8px;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-eyebrow {',
      '  color: var(--tcp-text-muted) !important;',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  --rtx-type-size: 10.5px;',
      '  --rtx-type-weight: 600;',
      '  font-family: var(--tcp-font-sans);',
      '  font-size: 10.5px;',
      '  font-weight: 600;',
      '  letter-spacing: 0.06em;',
      '  text-transform: uppercase;',
      '  line-height: 14px;',
      '}',

      /* Overview spec card */
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-card {',
      '  border-radius: 8px;',
      '  background: var(--tcp-recessed);',
      '  border: 1px solid var(--tcp-divider);',
      '  overflow: hidden;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-row {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 14px;',
      '  padding: 10px 13px;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-row + .rtx5-tcp-row {',
      '  border-top: 1px solid var(--tcp-divider);',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-key {',
      '  color: var(--tcp-text-muted) !important;',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  --rtx-type-size: 12px;',
      '  --rtx-type-weight: 500;',
      '  font-family: var(--tcp-font-sans);',
      '  font-size: 12px;',
      '  font-weight: 500;',
      '  line-height: 16px;',
      '  white-space: nowrap;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-val {',
      '  color: var(--tcp-text) !important;',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  --rtx-type-size: 12.5px;',
      '  --rtx-type-weight: 500;',
      '  font-family: var(--tcp-font-sans);',
      '  font-size: 12.5px;',
      '  font-weight: 500;',
      '  line-height: 17px;',
      '  text-align: right;',
      '  min-width: 0;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-val--num {',
      '  --rtx-type-family: var(--tcp-font-mono);',
      '  font-family: var(--tcp-font-mono);',
      '  font-variant-numeric: tabular-nums;',
      '  --rtx-type-size: 12px;',
      '  font-size: 12px;',
      '}',

      /* Optional broker select when multiple licensed brokers are available */
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-field {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 5px;',
      '  margin: 0;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-label {',
      '  color: var(--tcp-text) !important;',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  --rtx-type-size: 12px;',
      '  --rtx-type-weight: 500;',
      '  font-family: var(--tcp-font-sans);',
      '  font-size: 12px;',
      '  font-weight: 500;',
      '  line-height: 16px;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-select-wrap {',
      '  position: relative;',
      '  display: flex;',
      '  align-items: center;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-select-chevron {',
      '  position: absolute;',
      '  right: 10px;',
      '  display: inline-flex;',
      '  color: var(--tcp-text-muted);',
      '  pointer-events: none;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-select {',
      '  width: 100%;',
      '  height: 36px;',
      '  padding: 0 32px 0 11px;',
      '  appearance: none;',
      '  -webkit-appearance: none;',
      '  border-radius: 6px !important;',
      '  border: 1px solid var(--tcp-border) !important;',
      '  background: var(--tcp-field-bg) !important;',
      '  color: var(--tcp-text) !important;',
      '  box-shadow: none !important;',
      '  outline: none !important;',
      '  cursor: pointer;',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  --rtx-type-size: 12.5px;',
      '  --rtx-type-weight: 500;',
      '  font-family: var(--tcp-font-sans);',
      '  font-size: 12.5px;',
      '  font-weight: 500;',
      '  transition: border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-select option {',
      '  background: var(--tcp-surface);',
      '  color: var(--tcp-text);',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-select:hover {',
      '  border-color: var(--tcp-border-strong) !important;',
      '  background: var(--tcp-field-hover) !important;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-select:focus {',
      '  border-color: var(--tcp-accent) !important;',
      '  box-shadow: 0 0 0 2px var(--tcp-focus-ring) !important;',
      '}',

      /* Error callout */
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-error {',
      '  display: none;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 8px 11px;',
      '  border-radius: 6px;',
      '  background: var(--tcp-err-bg);',
      '  border: 1px solid var(--tcp-err-border);',
      '  color: var(--tcp-err-fg) !important;',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  --rtx-type-size: 12px;',
      '  --rtx-type-weight: 500;',
      '  font-family: var(--tcp-font-sans);',
      '  font-size: 12px;',
      '  font-weight: 500;',
      '  line-height: 17px;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-error.is-visible {',
      '  display: flex;',
      '}',

      /* Footer */
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-footer {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 10px;',
      '  padding: 12px 18px;',
      '  background: var(--tcp-chrome) !important;',
      '  border-top: 1px solid var(--tcp-divider) !important;',
      '  flex-shrink: 0;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-footer-actions {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn {',
      '  height: 34px;',
      '  padding: 0 13px;',
      '  border-radius: 6px !important;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  gap: 7px;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  --rtx-type-family: var(--tcp-font-sans);',
      '  --rtx-type-size: 12px;',
      '  --rtx-type-weight: 500;',
      '  font-family: var(--tcp-font-sans);',
      '  font-size: 12px;',
      '  font-weight: 500;',
      '  line-height: 1;',
      '  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn:disabled {',
      '  opacity: 0.55;',
      '  cursor: not-allowed;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn:focus-visible {',
      '  outline: 2px solid var(--tcp-accent) !important;',
      '  outline-offset: 2px;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn--secondary,',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn--ota {',
      '  background: var(--tcp-control-bg) !important;',
      '  border: 1px solid var(--tcp-border) !important;',
      '  color: var(--tcp-text) !important;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn--secondary:hover:not(:disabled),',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn--ota:hover:not(:disabled) {',
      '  background: var(--tcp-control-hover) !important;',
      '  border-color: var(--tcp-border-strong) !important;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn--ota.is-spinning svg {',
      '  animation: rtx5-tcp-spin 750ms linear infinite;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn--primary {',
      '  padding: 0 15px;',
      '  --rtx-type-weight: 600;',
      '  font-weight: 600;',
      '  background: var(--tcp-accent) !important;',
      '  border: 1px solid var(--tcp-accent) !important;',
      '  color: var(--tcp-accent-fg) !important;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn--primary:hover:not(:disabled) {',
      '  background: var(--tcp-accent-hover) !important;',
      '  border-color: var(--tcp-accent-hover) !important;',
      '}',
      '#rtx5-tcp-endpoint-backdrop .rtx5-tcp-btn--primary:active:not(:disabled) {',
      '  background: var(--tcp-accent-active) !important;',
      '  border-color: var(--tcp-accent-active) !important;',
      '}',

      /* OTA notification toast — inherits app theme tokens */
      '#rtx5-ota-toast {',
      '  --toast-bg: var(--bg-secondary, var(--rtx-dark-bg-secondary, #1f1f1f));',
      '  --toast-border: var(--border-primary, var(--rtx-dark-border-primary, #444444));',
      '  --toast-text: #ffffff;',
      '  --toast-muted: rgba(255, 255, 255, 0.72);',
      '  --toast-accent: var(--rtx-dark-accent, var(--rtx-toolbox-selected, #0078d7));',
      '  position: fixed;',
      '  right: 16px;',
      '  bottom: 34px;',
      '  z-index: 2147483635;',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 10px;',
      '  padding: 10px 12px 10px 14px;',
      '  border-radius: 8px;',
      '  background: var(--toast-bg);',
      '  border: 1px solid var(--toast-border);',
      '  color: var(--toast-text);',
      '  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.45);',
      '  --rtx-type-family: var(--rtx-ui-font-family, var(--font-sans, "Segoe UI", Tahoma, Arial, sans-serif));',
      '  --rtx-type-size: 12px;',
      '  --rtx-type-weight: 500;',
      '  font-family: var(--rtx-ui-font-family, var(--font-sans, "Segoe UI", Tahoma, Arial, sans-serif));',
      '  font-size: 12px;',
      '  font-weight: 500;',
      '}',
      'html.rtx-skin-untitled-light #rtx5-ota-toast,',
      'html.theme-light #rtx5-ota-toast {',
      '  --toast-bg: var(--rtx-light-elevated, #ffffff);',
      '  --toast-border: var(--rtx-light-border-strong, #cbd5e1);',
      '  --toast-text: var(--rtx-light-text, #182230);',
      '  --toast-muted: var(--rtx-light-text-muted, #475569);',
      '  --toast-accent: var(--rtx-light-accent, #2457a7);',
      '  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.16);',
      '}',
      '#rtx5-ota-apply-btn {',
      '  height: 27px;',
      '  padding: 0 11px;',
      '  border-radius: 5px;',
      '  border: 1px solid var(--toast-accent) !important;',
      '  background: var(--toast-accent) !important;',
      '  color: #ffffff !important;',
      '  --rtx-type-size: 11.5px;',
      '  --rtx-type-weight: 600;',
      '  font-size: 11.5px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '}',
      '#rtx5-ota-apply-btn:hover {',
      '  filter: brightness(1.08);',
      '}',
      '#rtx5-ota-dismiss-btn {',
      '  width: 24px;',
      '  height: 24px;',
      '  padding: 0;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  border-radius: 5px;',
      '  border: none !important;',
      '  background: transparent !important;',
      '  color: var(--toast-muted) !important;',
      '  cursor: pointer;',
      '}',
      '#rtx5-ota-dismiss-btn:hover {',
      '  color: var(--toast-text) !important;',
      '}',

      '@media (max-width: 480px) {',
      '  #rtx5-tcp-endpoint-backdrop .rtx5-tcp-footer { flex-wrap: wrap; }',
      '  #rtx5-tcp-endpoint-backdrop .rtx5-tcp-footer-actions { margin-left: auto; }',
      '}'
    ].join('\n');

    (document.head || document.documentElement).appendChild(style);
  }

  function renderOTANotificationBanner(st) {
    var ota = (st && st.ota) || {};
    var needExe = !!ota.exe_restart_ready;
    var needUI = !!ota.ui_reload_ready;
    var existing = document.getElementById('rtx5-ota-toast');

    if (!needExe && !needUI) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return;

    ensureStyles();

    var banner = document.createElement('div');
    banner.id = 'rtx5-ota-toast';

    var label = needExe ? 'Terminal Update Ready' : 'Interface Update Ready';
    var btnText = needExe ? 'Restart & Update' : 'Reload Terminal';

    banner.innerHTML =
      '<span>' + label + '</span>' +
      '<button type="button" id="rtx5-ota-apply-btn">' + btnText + '</button>' +
      '<button type="button" id="rtx5-ota-dismiss-btn" aria-label="Dismiss">' + ICON_CLOSE + '</button>';

    document.body.appendChild(banner);

    document.getElementById('rtx5-ota-apply-btn').onclick = async function () {
      if (needExe) {
        try { await fetch('/api/tcp-client/ota-restart', { method: 'POST' }); } catch { /* Restart request failure is tolerated; status polling reflects state */ }
      } else {
        try { await fetch('/api/tcp-client/ota-ack-ui', { method: 'POST' }); } catch { /* Proceed with page reload even if UI ack fails */ }
        window.location.reload();
      }
    };
    document.getElementById('rtx5-ota-dismiss-btn').onclick = function () {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    };
  }

  async function refreshStatus() {
    try {
      var r = await fetch('/api/tcp-client/status', { cache: 'no-store' });
      if (!r.ok) return latestStatus;
      var s = await r.json();
      latestStatus = Object.assign({}, latestStatus, s);
      window.__RTX5_TCP_STATUS__ = latestStatus;
      window.dispatchEvent(new CustomEvent('rtx5-tcp-status', { detail: latestStatus }));
      if (document.body) renderOTANotificationBanner(latestStatus);
      return latestStatus;
    } catch {
      return latestStatus;
    }
  }

  async function fetchAvailableBrokers() {
    try {
      var r = await fetch('/api/tcp-client/brokers', { cache: 'no-store' });
      if (!r.ok) return [];
      var data = await r.json();
      if (!Array.isArray(data)) return [];
      return data.filter(function (b) {
        return b && (b.broker_name || b.broker_id) && b.tcp_addr;
      });
    } catch {
      return [];
    }
  }

  window.rtx5GetTcpStatus = function () {
    return latestStatus;
  };

  window.rtx5CheckOTAUpdate = async function () {
    try {
      var r = await fetch('/api/tcp-client/ota-check', { method: 'POST' });
      var data = await r.json();
      await refreshStatus();
      return data;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };

  function closeExistingModal() {
    if (typeof activeModalCleanup === 'function') {
      try { activeModalCleanup(); } catch { /* Ensure listener cleanup error does not block closing modal */ }
      activeModalCleanup = null;
    }
    var old = document.getElementById('rtx5-tcp-endpoint-backdrop');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  window.rtx5OpenTcpEndpointDialog = async function () {
    closeExistingModal();
    ensureStyles();

    var results = await Promise.all([refreshStatus(), fetchAvailableBrokers()]);
    var st = results[0] || latestStatus;
    var brokers = results[1] || [];
    var ota = st.ota || {};
    var brokerName = st.broker_name || 'Trading Server';
    var latencyTxt = formatLatency(st);
    var updateTxt = formatUpdateStatus(ota);
    var securityTxt = st.dll_verified !== false ? 'Encrypted & Verified' : 'Encrypted';
    var connTxt = st.connected ? 'Connected' : 'Reconnecting';

    var activeBroker = {
      broker_id: st.broker_id || '',
      broker_name: brokerName,
      tcp_addr: st.target_tcp || ''
    };
    var selectedBroker = activeBroker;

    var selectableBrokers = brokers.length > 1 ? brokers : [];
    var brokerSelectHtml = '';
    if (selectableBrokers.length > 1) {
      var optionsHtml = selectableBrokers.map(function (b, idx) {
        var isCurrent =
          (st.broker_id && b.broker_id === st.broker_id) ||
          (st.broker_name && b.broker_name === st.broker_name);
        if (isCurrent) selectedBroker = b;
        var label = b.broker_name || 'Server ' + (idx + 1);
        return '<option value="' + idx + '"' + (isCurrent ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      }).join('');

      brokerSelectHtml =
        '<div class="rtx5-tcp-section">' +
          '<label class="rtx5-tcp-field">' +
            '<span class="rtx5-tcp-label">Switch Trading Server</span>' +
            '<div class="rtx5-tcp-select-wrap">' +
              '<select id="rtx5-tcp-broker-select" class="rtx5-tcp-select">' + optionsHtml + '</select>' +
              '<span class="rtx5-tcp-select-chevron">' + ICON_CHEVRON + '</span>' +
            '</div>' +
          '</label>' +
        '</div>';
    }

    var backdrop = document.createElement('div');
    backdrop.id = 'rtx5-tcp-endpoint-backdrop';

    var card = document.createElement('div');
    card.className = 'rtx5-tcp-sheet';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'rtx5-tcp-dialog-title');

    card.innerHTML =
      '<div class="rtx5-tcp-header" id="rtx5-tcp-drag-handle" title="Drag to move · Double-click to recenter">' +
        '<div class="rtx5-tcp-header-left">' +
          '<div class="rtx5-tcp-title-wrap">' +
            '<h2 class="rtx5-tcp-title" id="rtx5-tcp-dialog-title">Connection &amp; Updates</h2>' +
            '<div class="rtx5-tcp-subtitle">Server status and terminal updates</div>' +
          '</div>' +
        '</div>' +
        '<button type="button" id="rtx5-tcp-close-btn" class="rtx5-tcp-close-btn" data-no-drag="true" aria-label="Close dialog" title="Close (Esc)">' + ICON_CLOSE + '</button>' +
      '</div>' +

      '<div class="rtx5-tcp-body">' +
        '<div class="rtx5-tcp-section">' +
          '<span class="rtx5-tcp-eyebrow">Connection Overview</span>' +
          '<div class="rtx5-tcp-card">' +
            '<div class="rtx5-tcp-row">' +
              '<span class="rtx5-tcp-key">Server</span>' +
              '<span id="rtx5-tcp-server-name" class="rtx5-tcp-val">' + escapeHtml(brokerName) + '</span>' +
            '</div>' +
            '<div class="rtx5-tcp-row">' +
              '<span class="rtx5-tcp-key">Status</span>' +
              '<span id="rtx5-tcp-conn-state" class="rtx5-tcp-val">' + escapeHtml(connTxt) + '</span>' +
            '</div>' +
            '<div class="rtx5-tcp-row">' +
              '<span class="rtx5-tcp-key">Latency</span>' +
              '<span id="rtx5-tcp-rtt-main" class="rtx5-tcp-val rtx5-tcp-val--num">' + escapeHtml(latencyTxt) + '</span>' +
            '</div>' +
            '<div class="rtx5-tcp-row">' +
              '<span class="rtx5-tcp-key">Security</span>' +
              '<span id="rtx5-tcp-security-state" class="rtx5-tcp-val">' + escapeHtml(securityTxt) + '</span>' +
            '</div>' +
            '<div class="rtx5-tcp-row">' +
              '<span class="rtx5-tcp-key">Updates</span>' +
              '<span id="rtx5-ota-status-line" class="rtx5-tcp-val">' + escapeHtml(updateTxt) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        brokerSelectHtml +
        '<div id="rtx5-tcp-err" class="rtx5-tcp-error" role="alert"></div>' +
      '</div>' +

      '<div class="rtx5-tcp-footer">' +
        '<button type="button" id="rtx5-ota-check-btn" class="rtx5-tcp-btn rtx5-tcp-btn--ota">' +
          ICON_REFRESH +
          '<span id="rtx5-ota-check-label">Check for Updates</span>' +
        '</button>' +
        '<div class="rtx5-tcp-footer-actions">' +
          '<button type="button" id="rtx5-tcp-cancel-btn" class="rtx5-tcp-btn rtx5-tcp-btn--secondary">Close</button>' +
          '<button type="button" id="rtx5-tcp-save-btn" class="rtx5-tcp-btn rtx5-tcp-btn--primary">' +
            '<span id="rtx5-tcp-save-label">Reconnect</span>' +
            ICON_CONNECT +
          '</button>' +
        '</div>' +
      '</div>';

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    var dragHandle = document.getElementById('rtx5-tcp-drag-handle');
    var serverNameEl = document.getElementById('rtx5-tcp-server-name');
    var connStateEl = document.getElementById('rtx5-tcp-conn-state');
    var rttMainEl = document.getElementById('rtx5-tcp-rtt-main');
    var securityEl = document.getElementById('rtx5-tcp-security-state');
    var otaLine = document.getElementById('rtx5-ota-status-line');
    var brokerSelect = document.getElementById('rtx5-tcp-broker-select');
    var errEl = document.getElementById('rtx5-tcp-err');
    var otaBtn = document.getElementById('rtx5-ota-check-btn');
    var otaBtnLabel = document.getElementById('rtx5-ota-check-label');
    var saveBtn = document.getElementById('rtx5-tcp-save-btn');
    var saveBtnLabel = document.getElementById('rtx5-tcp-save-label');

    syncPrimaryButtonContrast(saveBtn, card);
    function onThemeChange() {
      syncPrimaryButtonContrast(saveBtn, card);
    }
    window.addEventListener('rtx:theme-appearance-change', onThemeChange);

    var manualOtaMsg = false;
    var submitting = false;

    function clearErr() {
      errEl.classList.remove('is-visible');
      errEl.innerHTML = '';
    }

    function showErr(msg) {
      errEl.innerHTML = ICON_ALERT + '<span>' + escapeHtml(msg) + '</span>';
      errEl.classList.add('is-visible');
    }

    function isSameBroker(a, b) {
      return Boolean(a && b && ((a.broker_id && a.broker_id === b.broker_id) || (a.broker_name && a.broker_name === b.broker_name)));
    }

    if (brokerSelect) {
      brokerSelect.onchange = function () {
        clearErr();
        var idx = parseInt(brokerSelect.value, 10);
        if (!isNaN(idx) && selectableBrokers[idx]) {
          selectedBroker = selectableBrokers[idx];
          saveBtnLabel.textContent = isSameBroker(selectedBroker, activeBroker) ? 'Reconnect' : 'Connect';
        }
      };
    }

    /* Live status refresh while dialog remains open */
    function onLiveStatus(ev) {
      var next = (ev && ev.detail) || latestStatus;
      if (!next) return;
      if (serverNameEl && next.broker_name) {
        serverNameEl.textContent = next.broker_name;
      }
      if (connStateEl) {
        connStateEl.textContent = next.connected ? 'Connected' : 'Reconnecting';
      }
      if (rttMainEl) {
        rttMainEl.textContent = formatLatency(next);
      }
      if (securityEl) {
        securityEl.textContent = next.dll_verified !== false ? 'Encrypted & Verified' : 'Encrypted';
      }
      if (!manualOtaMsg && otaLine) {
        otaLine.textContent = formatUpdateStatus(next.ota || {});
      }
    }
    window.addEventListener('rtx5-tcp-status', onLiveStatus);

    /* Draggable title bar with viewport clamping */
    var dragOffsetX = 0;
    var dragOffsetY = 0;
    var activeDragCleanup = null;

    function applyDragTransform() {
      if (dragOffsetX === 0 && dragOffsetY === 0) {
        card.style.transform = '';
      } else {
        card.style.transform = 'translate3d(' + dragOffsetX + 'px, ' + dragOffsetY + 'px, 0)';
      }
    }

    dragHandle.addEventListener('dblclick', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('[data-no-drag], button')) return;
      dragOffsetX = 0;
      dragOffsetY = 0;
      applyDragTransform();
    });

    dragHandle.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest('[data-no-drag], button, input, select')) return;

      ev.preventDefault();
      var startX = ev.clientX;
      var startY = ev.clientY;
      var origX = dragOffsetX;
      var origY = dragOffsetY;
      var rect = card.getBoundingClientRect();
      var naturalLeft = rect.left - origX;
      var naturalTop = rect.top - origY;
      var width = rect.width;

      dragHandle.classList.add('is-dragging');
      card.style.animation = 'none';

      function onMove(moveEv) {
        var nextX = origX + (moveEv.clientX - startX);
        var nextY = origY + (moveEv.clientY - startY);
        var marginX = Math.min(72, width);
        var minX = marginX - width - naturalLeft;
        var maxX = window.innerWidth - marginX - naturalLeft;
        var minY = -naturalTop;
        var maxY = Math.max(minY, window.innerHeight - 44 - naturalTop);
        dragOffsetX = Math.round(Math.min(Math.max(nextX, minX), maxX));
        dragOffsetY = Math.round(Math.min(Math.max(nextY, minY), maxY));
        applyDragTransform();
      }

      function onUp() {
        dragHandle.classList.remove('is-dragging');
        if (activeDragCleanup) {
          activeDragCleanup();
          activeDragCleanup = null;
        }
      }

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onUp);
      activeDragCleanup = function () {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('blur', onUp);
      };
    });

    otaBtn.onclick = async function () {
      clearErr();
      otaBtn.disabled = true;
      otaBtn.classList.add('is-spinning');
      otaBtnLabel.textContent = 'Checking…';
      var res = await window.rtx5CheckOTAUpdate();
      otaBtn.classList.remove('is-spinning');
      otaBtn.disabled = false;
      otaBtnLabel.textContent = 'Check for Updates';
      if (res && res.ota) {
        manualOtaMsg = true;
        if (res.ota.exe_restart_ready || res.ota.ui_reload_ready) {
          otaLine.textContent = 'Update ready to apply';
          closeExistingModal();
        } else {
          otaLine.textContent = 'Up to date';
        }
      } else if (res && res.ok === false) {
        manualOtaMsg = true;
        otaLine.textContent = 'Unable to check updates';
      }
    };

    async function submitReconnect() {
      if (submitting) return;
      clearErr();
      var target = selectedBroker || activeBroker;
      if (!target || !target.tcp_addr) {
        showErr('No trading server available to reconnect.');
        return;
      }
      submitting = true;
      saveBtn.disabled = true;
      saveBtnLabel.textContent = 'Connecting…';
      try {
        var res = await fetch('/api/tcp-client/switch-broker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tcp_addr: target.tcp_addr,
            broker_name: target.broker_name || 'Trading Server',
            broker_id: target.broker_id || ''
          })
        });
        if (res.ok) {
          closeExistingModal();
          window.location.reload();
        } else {
          showErr('Unable to connect to the trading server. Please try again.');
        }
      } catch {
        showErr('Unable to reach the trading connection service.');
      } finally {
        submitting = false;
        saveBtn.disabled = false;
        saveBtnLabel.textContent = isSameBroker(selectedBroker, activeBroker) ? 'Reconnect' : 'Connect';
      }
    }

    document.getElementById('rtx5-tcp-close-btn').onclick = closeExistingModal;
    document.getElementById('rtx5-tcp-cancel-btn').onclick = closeExistingModal;
    saveBtn.onclick = submitReconnect;

    var pointerDownOnBackdrop = false;
    backdrop.addEventListener('mousedown', function (ev) {
      pointerDownOnBackdrop = ev.target === backdrop;
    });
    backdrop.addEventListener('click', function (ev) {
      if (pointerDownOnBackdrop && ev.target === backdrop) {
        closeExistingModal();
      }
      pointerDownOnBackdrop = false;
    });

    function onWindowKeyDown(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeExistingModal();
      }
    }
    window.addEventListener('keydown', onWindowKeyDown);

    activeModalCleanup = function () {
      window.removeEventListener('rtx5-tcp-status', onLiveStatus);
      window.removeEventListener('rtx:theme-appearance-change', onThemeChange);
      window.removeEventListener('keydown', onWindowKeyDown);
      if (activeDragCleanup) {
        activeDragCleanup();
        activeDragCleanup = null;
      }
    };
  };

  window.addEventListener('keydown', function (ev) {
    if (ev.altKey && ev.shiftKey && (ev.key === 'T' || ev.key === 't')) {
      ev.preventDefault();
      window.rtx5OpenTcpEndpointDialog();
    }
  });

  refreshStatus();
  setInterval(refreshStatus, 3000);
})();
