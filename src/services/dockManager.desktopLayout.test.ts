// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { DockManager, type DockContainer, type DockLayout, type DockPanelConfig } from './dockManager';

const asContainer = (node: DockContainer | DockPanelConfig): DockContainer => {
  if (!('children' in node)) throw new Error(`Expected container, got panel ${node.id}`);
  return node;
};

const asPanel = (node: DockContainer | DockPanelConfig): DockPanelConfig => {
  if ('children' in node) throw new Error(`Expected panel, got container ${node.id}`);
  return node;
};

const installElectronBridge = () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    writable: true,
    value: { window: {} },
  });
};

const createPreviousDesktopLayout = () => ({
  root: {
    id: 'root',
    type: 'split',
    direction: 'vertical',
    ratio: 1,
    children: [
      {
        id: 'desktop-top-main',
        type: 'split',
        direction: 'horizontal',
        ratio: 0.657,
        children: [
          {
            id: 'left-sidebar',
            type: 'split',
            direction: 'vertical',
            ratio: 0.184,
            children: [
              { id: 'market-watch', type: 'panel', component: 'MarketWatch', ratio: 0.5 },
              { id: 'navigator', type: 'panel', component: 'Navigator', ratio: 0.5 },
            ],
          },
          {
            id: 'chart-live',
            type: 'panel',
            component: 'Chart',
            title: 'BTCUSD,M5',
            props: { symbol: 'BTCUSD', timeframe: 'M5', preserved: true },
            ratio: 0.816,
          },
        ],
      },
      { id: 'toolbox', type: 'panel', component: 'Terminal', ratio: 0.343 },
    ],
  },
  floatingPanels: [
    {
      id: 'floating-one',
      type: 'split',
      direction: 'horizontal',
      ratio: 1,
      children: [{ id: 'floating-news', type: 'panel', component: 'News', ratio: 1 }],
    },
  ],
  version: '2.6',
});

const createPreviousSidebarLayout = (marketWatchRatio = 0.5, navigatorRatio = 0.5) => {
  const layout = new DockManager().getLayout();
  const root = layout.root;
  const leftSidebar = asContainer(root.children[0]);
  leftSidebar.children[0].ratio = marketWatchRatio;
  leftSidebar.children[1].ratio = navigatorRatio;
  asPanel(asContainer(root.children[1]).children[0]).props = { symbol: 'BTCUSD', timeframe: 'M5', preserved: true };
  layout.floatingPanels = [{
    id: 'floating-news', type: 'panel', ratio: 1, isFloating: true,
    position: { x: 700, y: 150 }, size: { width: 320, height: 240 },
    children: [{ id: 'news', title: 'News', component: 'News', ratio: 1 }],
  }];
  return layout;
};

afterEach(() => {
  localStorage.clear();
  delete window.electron;
});

describe('desktop dock defaults', () => {
  it('preserves the established browser workspace proportions', () => {
    const root = new DockManager().getLayout().root;
    expect(root.children.map((child) => child.ratio)).toEqual([0.20, 0.80]);
    // 0ec4a611 set the default sidebar split to 0.48/0.52 and the migration marker to dock-layout-balanced-sidebar-v2.
    expect(asContainer(root.children[0]).children.map((child) => child.ratio)).toEqual([0.48, 0.52]);
    expect(asContainer(root.children[1]).children.map((child) => child.ratio)).toEqual([0.75, 0.25]);
  });

  it('keeps Market Watch and Navigator full-height beside Chart over Toolbox', () => {
    installElectronBridge();

    const layout = new DockManager().getLayout();
    const root = layout.root;
    expect(root.direction).toBe('horizontal');
    expect(root.children.map((child) => child.id)).toEqual(['left-sidebar', 'center-main']);

    const [leftSidebar, centerMain] = root.children.map(asContainer);
    expect(leftSidebar.ratio).toBe(0.20);
    expect(leftSidebar.direction).toBe('vertical');
    expect(leftSidebar.children.map((child) => child.id)).toEqual(['market-watch', 'navigator']);
    expect(leftSidebar.children.map((child) => child.ratio)).toEqual([0.48, 0.52]);

    expect(centerMain.ratio).toBe(0.80);
    expect(centerMain.direction).toBe('vertical');
    expect(centerMain.children.map((child) => child.id)).toEqual(['chart-default-container', 'toolbox']);
    expect(centerMain.children.map((child) => child.ratio)).toEqual([0.75, 0.25]);
  });

  it('migrates the previous full-width Toolbox default without losing panel state', () => {
    installElectronBridge();
    const storageKey = 'desktop-layout-migration-test';
    const previousDesktopLayout = createPreviousDesktopLayout();
    localStorage.setItem(storageKey, JSON.stringify(previousDesktopLayout));
    localStorage.setItem(`dock-layout-desktop-mt5-v2:${storageKey}`, '1');

    const manager = new DockManager();
    expect(manager.loadFromStorage(storageKey)).toBe(true);

    const layout = manager.getLayout();
    const root = layout.root;
    const leftSidebar = asContainer(root.children[0]);
    const centerMain = asContainer(root.children[1]);
    expect(root.direction).toBe('horizontal');
    expect(root.children.map((child) => child.id)).toEqual(['left-sidebar', 'center-main']);
    expect(leftSidebar.ratio).toBe(0.20);
    expect(leftSidebar.children.map((child) => child.ratio)).toEqual([0.48, 0.52]);
    expect(centerMain.ratio).toBe(0.80);
    expect(centerMain.children.map((child) => child.id)).toEqual(['chart-live', 'toolbox']);
    expect(centerMain.children.map((child) => child.ratio)).toEqual([0.75, 0.25]);
    expect(asPanel(centerMain.children[0]).props).toEqual({
      symbol: 'BTCUSD',
      timeframe: 'M5',
      preserved: true,
    });
    expect(layout.floatingPanels).toEqual(previousDesktopLayout.floatingPanels);
    expect(localStorage.getItem(`dock-layout-desktop-web-parity-v3:${storageKey}`)).toBe('1');
  });

  it('does not migrate the previous desktop layout when it is loaded in the web app', () => {
    const storageKey = 'browser-layout-isolation-test';
    const previousDesktopLayout = createPreviousDesktopLayout();
    localStorage.setItem(storageKey, JSON.stringify(previousDesktopLayout));
    localStorage.setItem(`dock-layout-desktop-mt5-v2:${storageKey}`, '1');

    const manager = new DockManager();
    expect(manager.loadFromStorage(storageKey)).toBe(true);

    const root = manager.getLayout().root;
    expect(root.direction).toBe('vertical');
    expect(root.children.map((child) => child.id)).toEqual(['desktop-top-main', 'toolbox']);
    expect(localStorage.getItem(`dock-layout-desktop-web-parity-v3:${storageKey}`)).toBeNull();
  });

  it('does not overwrite a customized desktop layout that shares the old structure', () => {
    installElectronBridge();
    const storageKey = 'custom-desktop-layout-test';
    const customizedDesktopLayout = createPreviousDesktopLayout();
    customizedDesktopLayout.root.children[0].ratio = 0.60;
    customizedDesktopLayout.root.children[1].ratio = 0.40;
    localStorage.setItem(storageKey, JSON.stringify(customizedDesktopLayout));
    localStorage.setItem(`dock-layout-desktop-mt5-v2:${storageKey}`, '1');

    const manager = new DockManager();
    expect(manager.loadFromStorage(storageKey)).toBe(true);

    const root = manager.getLayout().root;
    expect(root.direction).toBe('vertical');
    expect(root.children.map((child) => child.ratio)).toEqual([0.60, 0.40]);
    expect(localStorage.getItem(`dock-layout-desktop-web-parity-v3:${storageKey}`)).toBe('1');
  });
});

describe('balanced Market Watch sidebar migration', () => {
  it.each([
    { platform: 'browser', previousRatios: [0.5, 0.5] as const },
    { platform: 'desktop', previousRatios: [0.5, 0.5] as const },
    { platform: 'browser', previousRatios: [0.38, 0.62] as const },
    { platform: 'desktop', previousRatios: [0.38, 0.62] as const },
  ])('migrates the old $previousRatios split once in $platform without changing chart, Toolbox, or floating state', ({ platform, previousRatios }) => {
    if (platform === 'desktop') installElectronBridge();
    const storageKey = `dock-layout-sidebar-${platform}-${previousRatios.join('-')}`;
    const previous = createPreviousSidebarLayout(previousRatios[0], previousRatios[1]);
    localStorage.setItem(storageKey, JSON.stringify(previous));
    const expected = structuredClone(previous);
    const expectedSidebar = asContainer(expected.root.children[0]);
    expectedSidebar.children[0].ratio = 0.48;
    expectedSidebar.children[1].ratio = 0.52;

    const manager = new DockManager();
    expect(manager.loadFromStorage(storageKey)).toBe(true);
    expect(manager.getLayout()).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(expected);
    expect(localStorage.getItem(`dock-layout-balanced-sidebar-v2:${storageKey}`)).toBe('1');
  });

  it('preserves customized sidebar ratios', () => {
    const storageKey = 'dock-layout-custom-sidebar';
    const customized = createPreviousSidebarLayout();
    const sidebar = asContainer(customized.root.children[0]);
    sidebar.children[0].ratio = 0.44;
    sidebar.children[1].ratio = 0.56;
    localStorage.setItem(storageKey, JSON.stringify(customized));

    const manager = new DockManager();
    expect(manager.loadFromStorage(storageKey)).toBe(true);
    expect(manager.getLayout()).toEqual(customized);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(customized);
  });

  it('preserves an equal split explicitly restored after the migration marker was saved', () => {
    const storageKey = 'dock-layout-resized-sidebar';
    localStorage.setItem(storageKey, JSON.stringify(createPreviousSidebarLayout()));
    const manager = new DockManager();
    expect(manager.loadFromStorage(storageKey)).toBe(true);
    expect(localStorage.getItem(`dock-layout-balanced-sidebar-v2:${storageKey}`)).toBe('1');

    const resized = manager.getLayout();
    const sidebar = asContainer(resized.root.children[0]);
    sidebar.children[0].ratio = 0.5;
    sidebar.children[1].ratio = 0.5;
    manager.setLayout(resized);
    manager.saveToStorage(storageKey);

    const restored = new DockManager();
    expect(restored.loadFromStorage(storageKey)).toBe(true);
    expect(restored.getLayout()).toEqual(resized);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(resized);
  });
});

describe('1.2.18 container/panel predicate parity', () => {
  it('pins 1.2.18 loadFromStorage handling of primitives, null, and nullable/array children on panels', () => {
    installElectronBridge();

    // 1. Primitive entry in root.children must not throw in getPreviousDesktopDefaultParts or sanitizeContainer
    // before desktop/sidebar migration flags are recorded in localStorage.
    const primitiveStorageKey = 'dock-layout-primitive-child-test';
    const layoutWithPrimitive = new DockManager().getLayout() as unknown as {
      version: string;
      floatingPanels: unknown[];
      root: { id: string; type: string; direction: string; ratio: number; children: unknown[] };
    };
    layoutWithPrimitive.root.children.push('stray-primitive-node');
    localStorage.setItem(primitiveStorageKey, JSON.stringify(layoutWithPrimitive));
    localStorage.setItem(`dock-layout-desktop-mt5-v2:${primitiveStorageKey}`, '1');

    new DockManager().loadFromStorage(primitiveStorageKey);
    expect(localStorage.getItem(`dock-layout-desktop-web-parity-v3:${primitiveStorageKey}`)).toBe('1');
    expect(localStorage.getItem(`dock-layout-balanced-sidebar-v2:${primitiveStorageKey}`)).toBe('1');

    // 2. Legacy v2 desktop panels with a children property (e.g. children: []) must still match
    // getPreviousDesktopDefaultParts and migrate to the web-parity layout.
    const childrenPropMigrationKey = 'dock-layout-children-prop-migration-test';
    const legacyWithChildrenProp = createPreviousDesktopLayout() as unknown as {
      root: {
        children: [
          { children: [unknown, Record<string, unknown>] },
          Record<string, unknown>,
        ];
      };
    };
    legacyWithChildrenProp.root.children[0].children[1].children = [];
    legacyWithChildrenProp.root.children[1].children = [];
    localStorage.setItem(childrenPropMigrationKey, JSON.stringify(legacyWithChildrenProp));
    localStorage.setItem(`dock-layout-desktop-mt5-v2:${childrenPropMigrationKey}`, '1');

    const migratedManager = new DockManager();
    expect(migratedManager.loadFromStorage(childrenPropMigrationKey)).toBe(true);
    expect(migratedManager.getLayout().root.direction).toBe('horizontal');
    expect(migratedManager.getLayout().root.children.map((c) => c.id)).toEqual(['left-sidebar', 'center-main']);

    // 3. Corrupt Chart panel with explicit children: null must still be purged by sanitizeContainer.
    const corruptChartKey = 'dock-layout-corrupt-chart-null-children-test';
    const layoutWithCorruptChart = new DockManager().getLayout();
    layoutWithCorruptChart.root.children.push({
      id: 'corrupt-chart-null-children',
      title: 'Corrupt',
      component: 'Chart',
      props: { symbol: 'BAD SYMBOL!' },
      children: null,
    } as unknown as DockLayout['root']['children'][number]);
    localStorage.setItem(corruptChartKey, JSON.stringify(layoutWithCorruptChart));

    const sanitizeManager = new DockManager();
    expect(sanitizeManager.loadFromStorage(corruptChartKey)).toBe(true);
    expect(sanitizeManager.getLayout().root.children.some((c) => c.id === 'corrupt-chart-null-children')).toBe(false);

    // 4. Null entry in children throws TypeError in sanitizeContainer and loadFromStorage catches and returns false (1.2.18 parity).
    const nullChildKey = 'dock-layout-null-child-test';
    const layoutWithNull = new DockManager().getLayout() as unknown as {
      root: { children: unknown[] };
    };
    layoutWithNull.root.children.push(null);
    localStorage.setItem(nullChildKey, JSON.stringify(layoutWithNull));
    expect(new DockManager().loadFromStorage(nullChildKey)).toBe(false);
  });

  it('pins 1.2.18 floating child lookup in dockFloatingPanel, redockPanel, and removePanel when child has a children property', () => {
    const makeFloatingLayout = (panelId: string): DockLayout => {
      const base = new DockManager().getLayout();
      base.floatingPanels = [{
        id: `float-${panelId}`,
        type: 'panel',
        ratio: 1,
        isFloating: true,
        position: { x: 100, y: 100 },
        size: { width: 300, height: 240 },
        children: [{
          id: panelId,
          type: 'tabs',
          ratio: 1,
          activeTab: `${panelId}-leaf`,
          children: [{
            id: `${panelId}-leaf`,
            title: 'Floating News',
            component: 'News',
            ratio: 1,
          }],
        }],
      }];
      return base;
    };

    const dockBackManager = new DockManager(makeFloatingLayout('news-dock'));
    dockBackManager.dockFloatingPanel('news-dock', 'center-main', 'right');
    expect(dockBackManager.getLayout().floatingPanels).toHaveLength(0);
    expect(JSON.stringify(dockBackManager.getLayout().root)).toContain('news-dock');

    const redockManager = new DockManager(makeFloatingLayout('news-redock'));
    expect(redockManager.redockPanel('news-redock')).toBe(true);
    expect(redockManager.getLayout().floatingPanels).toHaveLength(0);
    expect(JSON.stringify(redockManager.getLayout().root)).toContain('news-redock');

    const removeManager = new DockManager(makeFloatingLayout('news-remove'));
    expect(removeManager.removePanel('news-remove')).toBe(true);
    expect(removeManager.getLayout().floatingPanels).toHaveLength(0);
    expect(JSON.stringify(removeManager.getLayout().root)).not.toContain('news-remove');
  });
});
