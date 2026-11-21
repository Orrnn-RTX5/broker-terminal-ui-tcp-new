// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import { OneClickTrading } from './OneClickTrading';

describe('OneClickTrading flickering direction colors', () => {
  beforeEach(() => {
    useAppStore.getState().reset();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '200001',
      ticks: {
        EURUSD: { symbol: 'EURUSD', bid: 1.1000, ask: 1.1002, spread: 2, timestamp: Date.now(), digits: 5 },
      },
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().reset();
  });

  it('colors both Sell and Buy buttons blue on uptick and both buttons red on downtick', () => {
    render(<OneClickTrading symbol="EURUSD" visible />);

    const sellButton = screen.getByRole('button', { name: /^SELL EURUSD/ });
    const buyButton = screen.getByRole('button', { name: /^BUY EURUSD/ });

    expect(sellButton).toHaveAttribute('data-dir', 'flat');
    expect(buyButton).toHaveAttribute('data-dir', 'flat');
    expect(sellButton.style.background).toBe('rgb(107, 114, 128)');
    expect(buyButton.style.background).toBe('rgb(107, 114, 128)');

    // Price moves down -> BOTH Sell and Buy turn red
    act(() => {
      useAppStore.setState({
        ticks: {
          EURUSD: { symbol: 'EURUSD', bid: 1.0995, ask: 1.0997, spread: 2, timestamp: Date.now() + 100, digits: 5 },
        },
      });
    });

    expect(sellButton).toHaveAttribute('data-dir', 'down');
    expect(buyButton).toHaveAttribute('data-dir', 'down');
    expect(sellButton.style.background).toBe('rgb(255, 88, 88)');
    expect(buyButton.style.background).toBe('rgb(255, 88, 88)');

    // Price moves up -> BOTH Sell and Buy turn blue
    act(() => {
      useAppStore.setState({
        ticks: {
          EURUSD: { symbol: 'EURUSD', bid: 1.1005, ask: 1.1007, spread: 2, timestamp: Date.now() + 200, digits: 5 },
        },
      });
    });

    expect(sellButton).toHaveAttribute('data-dir', 'up');
    expect(buyButton).toHaveAttribute('data-dir', 'up');
    expect(sellButton.style.background).toBe('rgb(69, 151, 255)');
    expect(buyButton.style.background).toBe('rgb(69, 151, 255)');

    // Verify stylesheet drives both dark and light colors by data-dir rather than fixed side
    const css = readFileSync(resolve(process.cwd(), 'src/components/OneClickTrading.css'), 'utf8');
    expect(css).toContain(".rtx-oct-trade-button[data-dir='up']");
    expect(css).toContain(".rtx-oct-trade-button[data-dir='down']");
    expect(css).toContain(".rtx-oct-trade-button[data-dir='flat']");
    expect(css).not.toMatch(/\.rtx-oct-trade-button\[data-side='(?:buy|sell)'\]\s*\{[\s\S]*?background:/);
  });
});
