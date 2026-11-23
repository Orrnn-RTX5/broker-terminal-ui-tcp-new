import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const readSource = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const marketWatchDesktopCss = readSource('src/components/market-watch/market-watch-desktop.css');
const marketWatchViewsCss = readSource('src/components/market-watch/market-watch-views.css');
const mt5SurfacesCss = readSource('src/styles/mt5-toolbox-surfaces.css');
const enterpriseLightCss = readSource('src/styles/enterprise-light.css');
const lightTypographyCss = readSource('src/styles/light-typography.css');
const historySummaryCss = readSource('src/features/bottom-dock/history/history-summary.css');
const indexCss = readSource('src/index.css');
const tradeTableSource = readSource('src/features/bottom-dock/trade/TradeTable.tsx');
const historyTabSource = readSource('src/features/bottom-dock/history/HistoryTab.tsx');
const journalTabSource = readSource('src/components/layout/JournalTab.tsx');
const pendingOrdersSource = readSource('src/features/bottom-dock/trade/PendingOrdersPanel.tsx');
const exposureTabSource = readSource('src/features/bottom-dock/exposure/ExposureTab.tsx');
const calendarTabSource = readSource('src/components/layout/CalendarTab.tsx');

describe('MT5 desktop alternating row and summary highlight contract', () => {
  it('applies MT5 #ffffff / #ebebeb alternating row striping, soft borders, and focused #0078d7 selection in Market Watch', () => {
    expect(marketWatchDesktopCss).toMatch(
      /html:root:is\(\.rtx-skin-untitled-light, \.theme-light\) \.rtx-market-watch\.rtx-market-watch--desktop \{[\s\S]*?--mw-desktop-row:\s*#ffffff;[\s\S]*?--mw-desktop-row-alt:\s*#ebebeb;[\s\S]*?--mw-desktop-row-selected-focus:\s*#0078d7;[\s\S]*?--mw-desktop-grid:\s*#dcdcdc;[\s\S]*?--mw-desktop-grid-vertical:\s*#c8c8c8;/,
    );
    expect(marketWatchDesktopCss).toMatch(
      /\.rtx-market-watch__grid tbody tr:nth-child\(even\) td \{[\s\S]*?background:\s*var\(--mw-desktop-row-alt\) !important;/,
    );
    // Grid lines must not erase Market Watch zebra stripes.
    expect(marketWatchDesktopCss).not.toMatch(
      /\.rtx-market-watch__grid--lines tbody tr:nth-child\(even\) td\s*\{[\s\S]*?background:\s*var\(--mw-desktop-row\)/,
    );
    // Focused row turns MT5 #0078d7 with white text; unfocused row returns to normal zebra striping.
    expect(marketWatchDesktopCss).toMatch(
      /\.rtx-market-watch__grid tbody tr\[aria-selected='true'\]:focus-within td \{[\s\S]*?background:\s*var\(--mw-desktop-row-selected-focus, #0078d7\) !important;[\s\S]*?color:\s*#ffffff !important;/,
    );
    expect(marketWatchDesktopCss).toContain("tr[aria-selected='true']:not(:focus-within):nth-child(even) td");
    expect(marketWatchViewsCss).toContain('--rtx-market-details-row-odd: #ebebeb;');
    // Preset light themes derive their own alternating stripe from preset tokens.
    expect(marketWatchDesktopCss).toMatch(
      /:not\(\[data-rtx-theme-preset='default-light'\]\) \.rtx-market-watch\.rtx-market-watch--desktop \{[\s\S]*?--mw-desktop-row-alt:\s*color-mix\(/,
    );
    // Market Watch column headers (Symbol .. Daily Change) match dark theme's lighter control weight (500) rather than bold heading weight (600).
    expect(lightTypographyCss).toMatch(
      /\.rtx-market-watch\.rtx-market-watch--desktop :is\(\s*\.rtx-market-watch__grid th,\s*\.rtx-market-watch__grid th span\s*\) \{[\s\S]*?--rtx-type-weight:\s*var\(--rtx-light-weight-control\);/,
    );
  });

  it('matches official MT5 desktop Market Watch blue/red column value colors and uniform 12px typography across dark and light themes', () => {
    const marketWatchRowSource = readSource('src/components/market-watch/MarketWatchRow.tsx');
    // Dark MT5 desktop Market Watch (Build 5640): #1e95fe blue / #fe6e6e red
    expect(marketWatchDesktopCss).toMatch(
      /html:root:not\(\.rtx-skin-untitled-light\):not\(\.theme-light\) \.rtx-market-watch\.rtx-market-watch--desktop \{[\s\S]*?--mw-desktop-quote-up:\s*#1e95fe;[\s\S]*?--mw-desktop-quote-down:\s*#fe6e6e;/,
    );
    // Light MT5 desktop Market Watch: #0000ff blue / #ff0000 red
    expect(marketWatchDesktopCss).toMatch(
      /html:root:is\(\.rtx-skin-untitled-light, \.theme-light\) \.rtx-market-watch\.rtx-market-watch--desktop \{[\s\S]*?--mw-desktop-quote-up:\s*#0000ff;[\s\S]*?--mw-desktop-quote-down:\s*#ff0000;/,
    );
    // Applies MT5 quote tokens across Bid, Ask, Daily Change, and direction arrows while keeping focused light selection white.
    expect(marketWatchDesktopCss).toContain('color: var(--mw-desktop-quote-up) !important;');
    expect(marketWatchDesktopCss).toContain('color: var(--mw-desktop-quote-down) !important;');
    expect(marketWatchDesktopCss).toContain('.rtx-market-watch__price--up, .rtx-market-watch__price--down,');
    // Uniform 12px / 300 global typography matching Market Watch Symbol, Bid, Ask, and Daily Change cells.
    expect(marketWatchDesktopCss).toMatch(
      /\.rtx-market-watch__grid tbody td > span,\s*html:root \.rtx-market-watch\.rtx-market-watch--desktop \.rtx-market-watch__last-close > span \{[\s\S]*?font-size: 12px !important;[\s\S]*?font-weight: 300 !important;/,
    );
    expect(marketWatchDesktopCss).toMatch(
      /\.rtx-market-watch__grid tbody td > span\.rtx-market-watch__daily \{[\s\S]*?font-size: 12px !important;[\s\S]*?font-weight: 300 !important;[\s\S]*?letter-spacing: normal !important;/,
    );
    expect(marketWatchDesktopCss).toMatch(
      /\.rtx-market-watch__grid tbody td :is\(\s*\.rtx-market-watch__symbol,[\s\S]*?\.rtx-market-watch__price,[\s\S]*?\.rtx-market-watch__daily,[\s\S]*?\.rtx-market-watch__daily-price,[\s\S]*?\) \{[\s\S]*?--rtx-type-weight: 300;[\s\S]*?font-weight: 300 !important;/,
    );
    expect(marketWatchDesktopCss).not.toContain('font-size: 9.5px');
    expect(marketWatchDesktopCss).not.toMatch(/\.rtx-market-watch__grid tbody td[^}]*font-size: 10\.5px/);
    expect(lightTypographyCss).toMatch(
      /\.rtx-market-watch__grid tbody td > span\.rtx-market-watch__daily,[\s\S]*?\.rtx-market-watch__daily-price[\s\S]*?--rtx-type-size: max\(12px, calc\(var\(--rtx-ui-font-size\) - 2px\)\);[\s\S]*?--rtx-type-weight: 300;/,
    );
    // Dark fallback in index.css and Details view in market-watch-views.css stay aligned with MT5 colors.
    expect(indexCss).toContain('var(--rtx-quote-up, var(--mw-desktop-quote-up, #1e95fe)) !important;');
    expect(indexCss).toContain('var(--rtx-quote-down, var(--mw-desktop-quote-down, #fe6e6e)) !important;');
    expect(marketWatchViewsCss).toContain('--rtx-market-details-up: #1e95fe;');
    expect(marketWatchViewsCss).toContain('--rtx-market-details-down: #fe6e6e;');
    // Custom chart palettes still override Market Watch desktop quote tokens inline on the row.
    expect(marketWatchRowSource).toContain("'--mw-desktop-quote-up': quoteUpColor,");
    expect(marketWatchRowSource).toContain("'--mw-desktop-quote-down': quoteDownColor,");
    expect(marketWatchRowSource).toContain('rtx-market-watch__daily-price');
  });

  it('matches Dark Theme flat click-to-add inline search bar style, green plus icon, and font sizing in Light Theme', () => {
    expect(enterpriseLightCss).toMatch(
      /\.rtx-market-watch__search--inline \.rtx-market-watch__search-bar\s*\{[\s\S]*?margin:\s*0 !important;[\s\S]*?background:\s*transparent !important;[\s\S]*?border:\s*0 !important;[\s\S]*?border-radius:\s*0 !important;[\s\S]*?box-shadow:\s*none !important;/,
    );
    expect(enterpriseLightCss).toMatch(
      /\.rtx-market-watch__search--inline\s*\{[\s\S]*?border-top:\s*1px solid var\(--mw-desktop-grid, var\(--rtx-light-border\)\) !important;/,
    );
    // Rounded field and muted search-icon coloring must stay scoped to --open so inline keeps its dark-parity flat look and green plus icon.
    expect(enterpriseLightCss).toMatch(
      /\.rtx-market-watch__search--open \.rtx-market-watch__search-bar\s*\{[\s\S]*?border-radius:\s*6px !important;/,
    );
    expect(enterpriseLightCss).not.toMatch(
      /\.rtx-market-watch \.rtx-market-watch__search-bar\s*>\s*svg\s*\{/,
    );
    // Light typography must not override the shared desktop Market Watch search/count font size (12px desktop / 10.5px laptop).
    expect(lightTypographyCss).not.toContain('.rtx-market-watch__search-bar .mw-input');
    expect(lightTypographyCss).not.toContain('.rtx-market-watch__symbol-count');
  });

  it('applies MT5 #ffffff headers, #ebebeb/#ffffff alternating rows, #d2d2d2 dividers, #0078d7 selection, #c8c8c8 summary bar, and #f0f0f0/#ffffff bottom tabs across Trade to Journal', () => {
    expect(mt5SurfacesCss).toMatch(
      /html:root:is\(\.rtx-advanced-view\.rtx-skin-untitled-light, \.rtx-skin-untitled-light, \.theme-light\) \.rtx-bottom-dock \{[\s\S]*?--rtx-toolbox-row:\s*#ffffff;[\s\S]*?--rtx-toolbox-row-alt:\s*#ebebeb;[\s\S]*?--rtx-toolbox-selected:\s*#0078d7;[\s\S]*?--rtx-toolbox-summary:\s*#c8c8c8;[\s\S]*?--rtx-toolbox-tabs:\s*#f0f0f0;[\s\S]*?--rtx-toolbox-border-header:\s*#b0b0b0;[\s\S]*?--rtx-toolbox-border-grid:\s*#d2d2d2;[\s\S]*?--rtx-toolbox-profit:\s*#0000ff;[\s\S]*?--rtx-toolbox-loss:\s*#ea3323;/,
    );
    for (const rowClass of [
      '.rtx-trade-row',
      '.rtx-pending-order-row',
      '.rtx-exposure-row',
      '.rtx-journal-row',
      '.rtx-calendar-row',
    ]) {
      expect(mt5SurfacesCss).toContain(rowClass);
    }
    expect(mt5SurfacesCss).toMatch(
      /:is\(\[data-row-parity='odd'\], :not\(\[data-row-parity\]\):nth-child\(odd\)\)\s*\{[\s\S]*?background:\s*var\(--rtx-toolbox-row-alt\) !important;/,
    );
    expect(mt5SurfacesCss).toMatch(
      /td\.rtx-history-cell--tp-hit \{[\s\S]*?background:\s*#60f060 !important;[\s\S]*?color:\s*#000000 !important;/,
    );
    expect(mt5SurfacesCss).toMatch(
      /td\.rtx-history-cell--sl-hit \{[\s\S]*?background:\s*#ff8080 !important;[\s\S]*?color:\s*#000000 !important;/,
    );
    expect(mt5SurfacesCss).toMatch(
      /\.rtx-history-summary-bar :is\(\s*\.rtx-history-summary-table,[\s\S]*?background:\s*transparent !important;/,
    );
    expect(enterpriseLightCss).toMatch(
      /\.rtx-trade-table tbody tr\.rtx-trade-row:not\(\.rtx-trade-row--selected\)\[data-row-parity="odd"\][\s\S]*?background:\s*var\(--rtx-toolbox-row-alt, #ebebeb\) !important;/,
    );
    expect(enterpriseLightCss).toMatch(/\.rtx-exposure-account-bar \{\s*display:\s*flex;\s*\}/);
    expect(enterpriseLightCss).toContain('.rtx-trade-sl-value.text-zinc-100');
    expect(indexCss).toContain('.rtx-trade-sl-value.text-zinc-100');
    expect(mt5SurfacesCss).toMatch(
      /\.rtx-bottom-dock :is\(\s*\.rtx-trade-footer,\s*\.rtx-history-summary-bar,\s*\.rtx-exposure-account-bar\s*\) \{[\s\S]*?background:\s*var\(--rtx-toolbox-summary, #c8c8c8\) !important;/,
    );
    expect(mt5SurfacesCss).toContain("tr.rtx-exposure-row[aria-selected='true'] .rtx-exposure-asset-badge");
    expect(mt5SurfacesCss).toContain("tr.rtx-pending-order-row[aria-selected='true'] .rtx-pending-row-btn");
    expect(historySummaryCss).toContain('background: var(--rtx-toolbox-summary, #c8c8c8) !important;');
  });

  it('keeps non-applicable sections (Toolbox commands, placeholders, bulk-close tab buttons, Trading/Ticks) unstriped', () => {
    const stripedSelectors: string[] = [];
    parse(mt5SurfacesCss, { from: 'src/styles/mt5-toolbox-surfaces.css' }).walkRules((rule) => {
      if (rule.selector.includes('data-row-parity') || rule.selector.includes('nth-child')) {
        stripedSelectors.push(rule.selector);
      }
    });
    expect(stripedSelectors.length).toBeGreaterThanOrEqual(2);
    const combined = stripedSelectors.join('\n');
    expect(combined).not.toContain('.rtx-toolbox-row');
    expect(combined).not.toContain('.rtx-placeholder-tab');
    expect(combined).not.toContain('.rtx-bulk-close');
    expect(combined).not.toContain('.rtx-market-tick-chart');
    expect(combined).not.toContain('.rtx-mw-trading');
  });

  it('emits stable data-row-parity and History TP/SL hit classes across Bottom Dock tables', () => {
    expect(tradeTableSource).toContain('data-row-parity={rowParity}');
    expect(tradeTableSource).toContain("rowParity={absoluteIndex % 2 === 0 ? 'odd' : 'even'}");
    expect(historyTabSource).toContain("data-row-parity={index % 2 === 0 ? 'odd' : 'even'}");
    expect(historyTabSource).toContain('rtx-history-cell--tp-hit');
    expect(historyTabSource).toContain('rtx-history-cell--sl-hit');
    expect(journalTabSource).toContain("data-row-parity={absoluteIndex % 2 === 0 ? 'odd' : 'even'}");
    expect(pendingOrdersSource).toContain("data-row-parity={index % 2 === 0 ? 'odd' : 'even'}");
    expect(exposureTabSource).toContain("data-row-parity={absoluteIndex % 2 === 0 ? 'odd' : 'even'}");
    expect(calendarTabSource).toContain("data-row-parity={rowIndex % 2 === 0 ? 'odd' : 'even'}");
  });
});
