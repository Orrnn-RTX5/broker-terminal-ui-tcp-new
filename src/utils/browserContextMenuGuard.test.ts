// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { installBrowserContextMenuGuard } from './browserContextMenuGuard';

describe('installBrowserContextMenuGuard', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('prevents native browser Inspect context menu across unhandled screen areas', () => {
    cleanup = installBrowserContextMenuGuard(document);

    const blankDiv = document.createElement('div');
    document.body.appendChild(blankDiv);

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    blankDiv.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    blankDiv.remove();
  });

  it('does not block browser DevTools keyboard shortcuts on Windows/Linux or Mac', () => {
    cleanup = installBrowserContextMenuGuard(document);

    const winDevTools = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      shiftKey: true,
      key: 'I',
    });
    const macDevTools = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      altKey: true,
      key: 'i',
    });
    const f12DevTools = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'F12',
    });

    document.dispatchEvent(winDevTools);
    document.dispatchEvent(macDevTools);
    document.dispatchEvent(f12DevTools);

    expect(winDevTools.defaultPrevented).toBe(false);
    expect(macDevTools.defaultPrevented).toBe(false);
    expect(f12DevTools.defaultPrevented).toBe(false);
  });
});
