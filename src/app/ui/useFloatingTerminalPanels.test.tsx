import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFloatingTerminalPanels } from './useFloatingTerminalPanels';

describe('useFloatingTerminalPanels', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());
  it('opens DOM for the requested symbol at the stable default position', () => {
    const { result } = renderHook(() => useFloatingTerminalPanels('EURUSD'));

    act(() => result.current.openDOM('BTCUSD'));

    expect(result.current.showDOM).toBe(true);
    expect(result.current.domSymbol).toBe('BTCUSD');
    // Laptop jsdom (1024x768) centers a compact DOM: (1024-468)/2, round(max(48,(768-380)*0.36)).
    expect(result.current.domPos).toEqual({ x: 278, y: 140 });
  });

  it('updates DOM position through the isolated drag controller', () => {
    const { result } = renderHook(() => useFloatingTerminalPanels('EURUSD'));
    const preventDefault = vi.fn();

    act(() => {
      result.current.handleDomMouseDown({ button: 0, clientX: 100, clientY: 80, preventDefault } as never);
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 125, clientY: 100 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.current.domPos).toEqual({ x: 303, y: 160 });
  });
});
