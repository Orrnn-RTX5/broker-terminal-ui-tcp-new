import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const journalSource = readSource('src/components/layout/JournalTab.tsx');
const indexCss = readSource('src/index.css');
const journalToolbarCss = readSource('src/components/layout/journal-toolbar.css');
const historySource = readSource('src/features/bottom-dock/history/HistoryTab.tsx');

describe('Journal toolbar visual contract', () => {
  it('uses the same compact terminal geometry as the History reference', () => {
    // 7c10304f moved journal toolbar geometry onto rtx-trade-view-bar; 63d1d5b8 added data-dock-inner-header.
    expect(journalSource).toContain('rtx-journal-toolbar rtx-trade-view-bar');
    expect(journalSource).toContain('data-dock-inner-header="true"');
    expect(historySource).toContain('rtx-history-toolbar rtx-trade-view-bar');
    expect(historySource).toContain('data-dock-inner-header="true"');
    expect(journalToolbarCss).toMatch(/html \.rtx-journal-tab \.rtx-journal-toolbar\s*\{[^}]*height: auto;/);
    expect(journalToolbarCss).toMatch(
      /html:root\.rtx-advanced-view\.rtx-skin-untitled-light \.rtx-journal-tab \.rtx-journal-toolbar\s*\{[^}]*height: auto !important;\s*min-height: 36px;/,
    );
    expect(journalSource).toContain('rtx-journal-control h-7 min-w-[94px]');
    expect(journalSource).toContain('rtx-journal-control h-7 min-w-[112px]');
    expect(journalSource).toContain('rtx-journal-control h-7 w-full');
    expect(journalSource).toContain("{ label: '2h', hours: 2 }");
    expect(journalSource).not.toContain("{ label: '3h', hours: 3 }");
    expect(journalSource).not.toContain("{ label: '6h', hours: 6 }");
    expect(journalSource).not.toContain("{ label: 'Month', hours: 24 * 30 }");
    expect(journalSource).toContain("{ label: 'Today', hours: 24 }");
    expect(journalSource).toContain("{ label: 'All', hours: 0 }");
    expect(journalSource).toContain('rtx-journal-table__head sticky top-0');
  });

  it('uses squared corners and an inset focus treatment instead of an outer ring', () => {
    // 7c10304f squares journal controls except trade subtabs and moves the light inset focus into journal-toolbar.css.
    expect(indexCss).toMatch(/html \.rtx-journal-toolbar \.rtx-journal-control:not\(\.rtx-trade-subtab-btn\)\s*\{[^}]*border-radius: 2px !important;/);
    expect(indexCss).toMatch(/\.rtx-journal-toolbar button\.rtx-journal-control:active\s*\{[^}]*transform: none;/);
    expect(journalToolbarCss).toMatch(
      /html:root\.rtx-advanced-view\.rtx-skin-untitled-light \.rtx-journal-tab \.rtx-journal-control:not\(\.rtx-journal-time-btn\):is\(:focus, :focus-visible\)\s*\{[^}]*box-shadow: inset 0 0 0 1px var\(--rtx-light-focus-ring\) !important;/,
    );
    expect(indexCss).toMatch(/\.rtx-journal-auto\[aria-pressed="true"\]\s*\{[^}]*background: #f4ebff !important;/);
  });
});
