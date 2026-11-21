import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import { clearTradeHistoryRequestCache, tradeGatewayApi } from './tradeGateway';
import { invalidateTerminalHistory } from '../services/terminalHistory';

vi.mock('./client', () => ({ apiClient: { get: vi.fn() } }));

const LOGIN = 654321;

beforeEach(() => {
  vi.clearAllMocks();
  clearTradeHistoryRequestCache();
  vi.mocked(apiClient.get).mockImplementation(async () => ({ positions: [], deals: [] }) as never);
});

const closedCalls = () => vi.mocked(apiClient.get).mock.calls
  .filter(([endpoint]) => endpoint === `/positions/${LOGIN}/history`);

describe('history read limits', () => {
  it('default closed-position read keeps limit 500 (History tab path)', async () => {
    await tradeGatewayApi.getClosedPositions(LOGIN);
    expect(closedCalls()[0]?.[1]).toMatchObject({ params: { limit: 500, offset: 0 } });
  });

  it('a limited read sends limit 100 and never serves or poisons the 500-row cache', async () => {
    await tradeGatewayApi.getClosedPositions(LOGIN, { limit: 100 });
    await tradeGatewayApi.getClosedPositions(LOGIN);
    const limits = closedCalls().map(([, options]) => (options as { params: { limit: number } }).params.limit);
    expect(limits).toEqual([100, 500]);
    // Both are cached under their own keys afterwards.
    await tradeGatewayApi.getClosedPositions(LOGIN, { limit: 100 });
    await tradeGatewayApi.getClosedPositions(LOGIN);
    expect(closedCalls()).toHaveLength(2);
  });

  it('limited deals read one small page; the default read still pages with 500', async () => {
    const dealCalls = () => vi.mocked(apiClient.get).mock.calls.filter(([endpoint]) => endpoint === `/deals/${LOGIN}`);
    vi.mocked(apiClient.get).mockImplementation(async (endpoint: string) => {
      if (endpoint === `/deals/${LOGIN}`) {
        return { deals: Array.from({ length: 100 }, (_, i) => ({ ticket: i + 1, symbol: 'EURUSD' })) } as never;
      }
      return { positions: [] } as never;
    });
    await tradeGatewayApi.getDeals(LOGIN, { limit: 100 });
    expect(dealCalls()).toHaveLength(1);
    expect(dealCalls()[0]?.[1]).toMatchObject({ params: { limit: 100, offset: 0 } });

    await tradeGatewayApi.getDeals(LOGIN);
    expect(dealCalls()[1]?.[1]).toMatchObject({ params: { limit: 500, offset: 0 } });
  });
});

describe('invalidation never kills an in-flight read', () => {
  it('a deals read in flight when a fill invalidates the history cache still completes', async () => {
    let release!: (value: unknown) => void;
    vi.mocked(apiClient.get).mockImplementation(((endpoint: string) => (
      endpoint === `/deals/${LOGIN}`
        ? new Promise((resolve) => { release = resolve; })
        : Promise.resolve({ positions: [] })
    )) as never);
    const read = tradeGatewayApi.getDeals(LOGIN, { limit: 100 });
    invalidateTerminalHistory();
    release({ deals: [{ ticket: 1, symbol: 'EURUSD' }] });
    await expect(read).resolves.toHaveLength(1);
  });

  it('settled results from before the invalidation are not served afterwards', async () => {
    let release!: (value: unknown) => void;
    let calls = 0;
    vi.mocked(apiClient.get).mockImplementation((() => {
      calls += 1;
      return calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ positions: [] });
    }) as never);
    const first = tradeGatewayApi.getClosedPositions(LOGIN);
    invalidateTerminalHistory();
    release({ positions: [] });
    await first;
    await tradeGatewayApi.getClosedPositions(LOGIN);
    expect(calls).toBe(2);
  });
});
