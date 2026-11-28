import { describe, expect, it } from 'vitest'
import { validateBrokerRuntimeConfig } from './brokerRuntimeConfig'
import {
  LOCAL_WORKSPACE_PROFILES_STORAGE_KEY,
  LocalWorkspaceProfileService,
  createBuiltinWorkspaceProfile,
} from '../services/localWorkspaceProfiles'
import type { DockLayout } from '../services/dockManager'
import { defaultChartProperties } from '../store/useChartSettingsStore'

const baseRuntimeConfig = () => ({
  CONFIG_SOURCE: 'deployment',
  BACKEND_TARGET: 'web',
  API_HOST: 'https://api.example.test',
  WS_HOST: 'wss://api.example.test',
  DEFAULT_MT5_SERVER: 'Trading Server',
})

const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
}

const createDockLayout = (symbol: string): DockLayout => ({
  root: {
    id: 'root',
    type: 'split',
    direction: 'horizontal',
    ratio: 1,
    children: [
      {
        id: 'chart-1',
        title: `${symbol},M15`,
        component: 'Chart',
        props: { symbol, timeframe: 'M15' },
        ratio: 1,
      },
    ],
  },
  floatingPanels: [],
  version: '2.6',
})

const storeProfileWithSymbol = (
  storage: Storage,
  selectedSymbol: string,
  hiddenSymbols: string[],
  watchlistSymbols: string[],
  symbolSetSymbols: string[],
  symbolProperties: Record<string, typeof defaultChartProperties>,
) => {
  storage.setItem(
    LOCAL_WORKSPACE_PROFILES_STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      profiles: [
        {
          schemaVersion: 1,
          origin: 'saved',
          id: 'acc-1:guardcheck',
          accountId: 'acc-1',
          name: 'GuardCheck',
          createdAt: '2026-09-02T10:00:00.000Z',
          updatedAt: '2026-09-02T10:00:00.000Z',
          state: {
            dockLayout: createDockLayout('EURUSD'),
            chartView: {
              selectedSymbol,
              timeframe: 'M15',
              chartType: 'candlestick',
              orderVolume: 0.01,
              dockHeight: null,
            },
            chartSettings: {
              globalProperties: defaultChartProperties,
              symbolProperties,
              volumeBarsDefaultMigrationVersion: 2,
              periodSeparatorsDefaultMigrationVersion: 1,
              chartShiftDefaultMigrationVersion: 1,
              ohlcDefaultMigrationVersion: 1,
            },
            marketWatch: {
              watchlists: [
                {
                  id: 'wl-1',
                  name: 'Main',
                  symbols: watchlistSymbols,
                  isDefault: true,
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
              activeWatchlistId: 'wl-1',
              hiddenSymbols,
              columns: ['symbol', 'bid', 'ask', 'spread'],
              options: {
                useSystemColors: true,
                showMilliseconds: false,
                autoRemoveExpired: false,
                autoArrange: true,
                showGrid: true,
              },
              symbolSets: { Main: symbolSetSymbols },
              symbolSetColumns: {},
            },
          },
        },
      ],
    }),
  )
}

describe('ASCII control-character guards (0x00-0x1F and 0x7F only)', () => {
  describe('validateBrokerRuntimeConfig BROKER_ID guard', () => {
    it.each([
      ['NUL standalone (0x00)', '\u0000'],
      ['NUL embedded (0x00)', 'broker\u0000id'],
      ['US standalone (0x1F)', '\u001f'],
      ['US embedded (0x1F)', 'broker\u001fid'],
      ['DEL standalone (0x7F)', '\u007f'],
      ['DEL embedded (0x7F)', 'broker\u007fid'],
    ])('rejects %s in BROKER_ID', (_label, badBrokerId) => {
      const result = validateBrokerRuntimeConfig({
        ...baseRuntimeConfig(),
        BROKER_ID: badBrokerId,
      })
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('BROKER_ID must not contain control characters.')
    })

    it.each([
      ['NUL via VITE_BROKER_ID (0x00)', 'broker\u0000alias'],
      ['US via VITE_BROKER_ID (0x1F)', 'broker\u001falias'],
      ['DEL via VITE_BROKER_ID (0x7F)', 'broker\u007falias'],
    ])('rejects %s', (_label, badBrokerId) => {
      const result = validateBrokerRuntimeConfig({
        ...baseRuntimeConfig(),
        VITE_BROKER_ID: badBrokerId,
      })
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('BROKER_ID must not contain control characters.')
    })

    it.each([
      ['PAD standalone (0x80)', '\u0080'],
      ['PAD embedded (0x80)', 'broker\u0080id'],
      ['APC embedded (0x9F)', 'broker\u009fid'],
      ['NBSP embedded (0xA0)', 'broker\u00a0id'],
      ['normal ASCII text', 'broker-alpha_01'],
    ])('accepts %s in BROKER_ID', (_label, okBrokerId) => {
      const result = validateBrokerRuntimeConfig({
        ...baseRuntimeConfig(),
        BROKER_ID: okBrokerId,
      })
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.brokerId).toBe(okBrokerId)
    })

    it('trims standalone NBSP (0xA0) before the regex guard without reporting control characters', () => {
      const result = validateBrokerRuntimeConfig({
        ...baseRuntimeConfig(),
        BROKER_ID: '\u00a0',
      })
      expect(result.valid).toBe(false)
      expect(result.errors).not.toContain('BROKER_ID must not contain control characters.')
      expect(result.errors).toContain('BROKER_ID is required for this broker deployment.')
    })
  })

  describe('localWorkspaceProfiles normalizeSymbol guard', () => {
    it.each([
      ['NUL standalone (0x00)', '\u0000'],
      ['NUL embedded (0x00)', 'EUR\u0000USD'],
      ['US standalone (0x1F)', '\u001f'],
      ['US embedded (0x1F)', 'EUR\u001fUSD'],
      ['DEL standalone (0x7F)', '\u007f'],
      ['DEL embedded (0x7F)', 'EUR\u007fUSD'],
    ])('rejects %s across stored workspace symbol fields', (_label, badSymbol) => {
      const storage = createMemoryStorage()
      storeProfileWithSymbol(
        storage,
        badSymbol,
        [badSymbol, 'EURUSD'],
        [badSymbol, 'GBPUSD'],
        [badSymbol, 'USDJPY'],
        { [badSymbol]: defaultChartProperties, EURUSD: defaultChartProperties },
      )
      const service = new LocalWorkspaceProfileService(storage)
      const profile = service.getWorkspaceProfile({ accountId: 'acc-1', profileName: 'GuardCheck' })

      expect(profile).not.toBeNull()
      expect(profile?.state.chartView.selectedSymbol).toBe('')
      expect(profile?.state.marketWatch.hiddenSymbols).toEqual(['EURUSD'])
      expect(profile?.state.marketWatch.watchlists[0]?.symbols).toEqual(['GBPUSD'])
      expect(profile?.state.marketWatch.symbolSets.Main).toEqual(['USDJPY'])
      expect(Object.keys(profile?.state.chartSettings.symbolProperties ?? {})).toEqual(['EURUSD'])
    })

    it.each([
      ['PAD standalone (0x80)', '\u0080'],
      ['PAD embedded (0x80)', 'EUR\u0080USD'],
      ['APC embedded (0x9F)', 'EUR\u009fUSD'],
      ['NBSP embedded (0xA0)', 'EUR\u00a0USD'],
      ['normal symbol text', 'EURUSD.r#'],
    ])('accepts %s across stored workspace symbol fields', (_label, okSymbol) => {
      const storage = createMemoryStorage()
      storeProfileWithSymbol(
        storage,
        okSymbol,
        [okSymbol],
        [okSymbol],
        [okSymbol],
        { [okSymbol]: defaultChartProperties },
      )
      const service = new LocalWorkspaceProfileService(storage)
      const profile = service.getWorkspaceProfile({ accountId: 'acc-1', profileName: 'GuardCheck' })

      expect(profile).not.toBeNull()
      expect(profile?.state.chartView.selectedSymbol).toBe(okSymbol)
      expect(profile?.state.marketWatch.hiddenSymbols).toEqual([okSymbol])
      expect(profile?.state.marketWatch.watchlists[0]?.symbols).toEqual([okSymbol])
      expect(profile?.state.marketWatch.symbolSets.Main).toEqual([okSymbol])
      expect(Object.keys(profile?.state.chartSettings.symbolProperties ?? {})).toEqual([okSymbol])
    })

    it('rejects 0x00/0x1F/0x7F and accepts 0x80/0xA0/normal text when capturing and building presets', () => {
      const storage = createMemoryStorage()
      const service = new LocalWorkspaceProfileService(
        storage,
        () => new Date('2026-09-02T10:00:00.000Z'),
      )

      for (const badSymbol of ['\u0000', 'EUR\u0000USD', '\u001f', 'EUR\u001fUSD', '\u007f', 'EUR\u007fUSD']) {
        const captured = service.captureCurrentWorkspaceProfile({
          accountId: 'acc-1',
          profileName: 'Capture',
          view: { selectedSymbol: badSymbol },
        })
        expect(captured.state.chartView.selectedSymbol).toBe('')
      }

      for (const okSymbol of ['\u0080', 'EUR\u0080USD', 'EUR\u009fUSD', 'EUR\u00a0USD', 'EURUSD.r#']) {
        const captured = service.captureCurrentWorkspaceProfile({
          accountId: 'acc-1',
          profileName: 'Capture',
          view: { selectedSymbol: okSymbol },
        })
        expect(captured.state.chartView.selectedSymbol).toBe(okSymbol)
      }

      const rejectedPreset = createBuiltinWorkspaceProfile('acc-1', 'Euro', {
        symbols: ['EURUSD\u0000', 'EURUSD\u001f', 'EURUSD\u007f', 'EURJPY'],
      })
      expect(rejectedPreset.state.chartView.selectedSymbol).toBe('EURJPY')

      for (const acceptedEuro of ['EURUSD\u0080', 'EURUSD\u00a0.r', 'EURUSD.r']) {
        const acceptedPreset = createBuiltinWorkspaceProfile('acc-1', 'Euro', {
          symbols: [acceptedEuro],
        })
        expect(acceptedPreset.state.chartView.selectedSymbol).toBe(acceptedEuro)
      }
    })
  })
})
