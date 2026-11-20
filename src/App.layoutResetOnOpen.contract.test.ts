import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

const bootStart = source.indexOf('// Every launch opens the shipped default arrangement');
const bootEnd = source.indexOf('// Broker config', bootStart);
const bootEffect = source.slice(bootStart, bootEnd);

describe('layout reset on open', () => {
  it('opens every authenticated session on the default arrangement', () => {
    expect(bootStart).toBeGreaterThan(-1);
    expect(bootEnd).toBeGreaterThan(bootStart);
    expect(bootEffect).toContain('useDockLayoutStore.getState().resetToDefaultLayout();');
    expect(bootEffect).toContain('setSelectedSymbol(DEFAULT_CHART_SYMBOL);');
    expect(bootEffect).toContain('const restoredTimeframe = readPersistedTimeframe() || DEFAULT_CHART_TIMEFRAME;');
    expect(bootEffect).toContain('setTimeframe(restoredTimeframe);');
    expect(bootEffect).toContain('setRestoredLayoutAccountId(accountId);');
    expect(bootEffect.indexOf('resetToDefaultLayout()')).toBeLessThan(bootEffect.indexOf('setRestoredLayoutAccountId(accountId)'));
    expect(source).toContain('readPersistedTimeframe() || DEFAULT_CHART_TIMEFRAME');
  });

  it('never restores or auto-saves per-account layouts at boot', () => {
    expect(bootEffect).not.toContain('loadLayout(');
    expect(bootEffect).not.toContain('saveLayout(');
    expect(bootEffect).not.toContain('useDockLayoutStore.subscribe');
  });

  it('restores the last selected symbol and timeframe onto the default chart container across reload and reopen while falling back to defaults', () => {
    expect(bootEffect).toContain('const persistedSymbol = readPersistedSelectedSymbol();');
    expect(bootEffect).toContain('const restoredTimeframe = readPersistedTimeframe() || DEFAULT_CHART_TIMEFRAME;');
    expect(bootEffect).toContain("useDockLayoutStore.getState().updatePanelProps('chart-default-container'");
    expect(bootEffect).toContain('title: `${persistedSymbol},${restoredTimeframe}`');
    expect(bootEffect).toContain('props: { symbol: persistedSymbol, timeframe: restoredTimeframe }');
    expect(bootEffect).toContain('props: { timeframe: restoredTimeframe }');
    expect(bootEffect).toContain('setSelectedSymbol(persistedSymbol);');
    expect(bootEffect).toContain('setSelectedSymbol(DEFAULT_CHART_SYMBOL);');
    expect(bootEffect).toContain('setTimeframe(restoredTimeframe);');
    expect(source).toContain('readPersistedSelectedSymbol() || DEFAULT_CHART_SYMBOL');
    expect(source).toContain('readPersistedTimeframe() || DEFAULT_CHART_TIMEFRAME');
    expect(source).toContain('if (useDockLayoutStore.getState().layout !== dockLayout) return;');
  });
});
