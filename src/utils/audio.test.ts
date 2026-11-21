// @vitest-environment jsdom

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSystemSoundAssetPath,
  playSystemSound,
  resetAudioContextForTests,
  type SystemSoundType,
} from './audio';
import { useSettingsStore } from '../store/useSettingsStore';

interface PlayedBufferRecord {
  buffer: unknown;
  gain: number | null;
  startedAt: number | null;
}

function installMockAudioEnvironment(initialState: AudioContextState = 'running') {
  const playedBuffers: PlayedBufferRecord[] = [];
  const playedHtmlAudio: Array<{ src: string; volume: number }> = [];
  const fetchedUrls: string[] = [];
  let state: AudioContextState = initialState;

  const resume = vi.fn(async () => {
    state = 'running';
  });

  const decodeAudioData = vi.fn(async (buf: ArrayBuffer) => {
    // Tag each decoded buffer by byte length so tests can verify distinct decoded assets.
    return { duration: 0.25, byteLength: buf.byteLength } as unknown as AudioBuffer;
  });

  class MockAudioContext {
    currentTime = 1.0;
    sampleRate = 22050;
    destination = {};
    get state() {
      return state;
    }
    resume = resume;
    decodeAudioData = decodeAudioData;
    createGain() {
      const node = {
        value: null as number | null,
        gain: {
          setValueAtTime: vi.fn((val: number) => {
            node.value = val;
          }),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
      return node;
    }
    createBufferSource() {
      const record: PlayedBufferRecord = {
        buffer: null,
        gain: null,
        startedAt: null,
      };
      const source = {
        get buffer() {
          return record.buffer;
        },
        set buffer(value: unknown) {
          record.buffer = value;
        },
        connect: vi.fn((dest: { value?: number | null }) => {
          if (dest && typeof dest.value === 'number') {
            record.gain = dest.value;
          }
        }),
        start: vi.fn((when?: number) => {
          record.startedAt = when ?? 0;
          playedBuffers.push(record);
        }),
        stop: vi.fn(),
      };
      return source;
    }
    createOscillator() {
      return {
        type: 'sine' as OscillatorType,
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
    }
  }

  class MockHtmlAudio {
    src: string;
    preload = '';
    volume = 1;
    constructor(src: string) {
      this.src = src;
    }
    play = vi.fn(() => {
      playedHtmlAudio.push({ src: this.src, volume: this.volume });
      return Promise.resolve();
    });
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    // Distinct synthetic ArrayBuffer size per URL so decoded buffers are distinguishable.
    const bytes = new ArrayBuffer(64 + url.length);
    return {
      ok: true,
      arrayBuffer: async () => bytes,
    } as Response;
  });

  Object.defineProperty(window, 'AudioContext', {
    value: MockAudioContext,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'Audio', {
    value: MockHtmlAudio,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchMock,
    configurable: true,
    writable: true,
  });

  return { playedBuffers, playedHtmlAudio, fetchedUrls, resume, decodeAudioData };
}

describe('Authentic MetaTrader 5 trade and system audio playback', () => {
  const originalAudioContext = window.AudioContext;
  const originalAudio = globalThis.Audio;
  const originalFetch = globalThis.fetch;
  const initialNotifications = useSettingsStore.getState().notifications;

  beforeEach(() => {
    resetAudioContextForTests();
    useSettingsStore.setState({
      notifications: {
        ...initialNotifications,
        doNotDisturb: false,
        enableSoundAlerts: true,
        tradeExecution: {
          ...initialNotifications.tradeExecution,
          playSound: true,
        },
      },
    });
  });

  afterEach(() => {
    resetAudioContextForTests();
    useSettingsStore.setState({ notifications: initialNotifications });
    Object.defineProperty(window, 'AudioContext', {
      value: originalAudioContext,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'Audio', {
      value: originalAudio,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it('maps buy, sell, open, and every close case to distinct WAV sound assets on disk', () => {
    const soundTypes: SystemSoundType[] = ['buy', 'sell', 'open', 'close-single', 'close-all', 'close-profit', 'close-loss'];
    const assetPaths = soundTypes.map((type) => getSystemSoundAssetPath(type));

    for (const path of assetPaths) {
      expect(path).toMatch(/sounds\/mt5-trade-[a-z-]+\.wav$/);
      const relativePublicPath = String(path).replace(/^\.?\/+/, '');
      const diskPath = resolve(process.cwd(), 'public', relativePublicPath);
      expect(existsSync(diskPath)).toBe(true);
      const header = readFileSync(diskPath).subarray(0, 12).toString('ascii');
      expect(header.slice(0, 4)).toBe('RIFF');
      expect(header.slice(8, 12)).toBe('WAVE');
    }
    // All 7 trade cases (buy, sell, open + 4 close cases) have distinct WAV files.
    expect(new Set(assetPaths).size).toBe(7);
    expect(getSystemSoundAssetPath('close')).toBe(getSystemSoundAssetPath('close-single'));
    expect(getSystemSoundAssetPath('login')).toMatch(/sounds\/mt5-connect\.wav$/);
  });

  it('plays immediately on first trade and uses cached Web Audio buffer on subsequent trades', async () => {
    const { playedBuffers, playedHtmlAudio, fetchedUrls, decodeAudioData } = installMockAudioEnvironment('running');

    // First play: cold cache fires HTMLAudio immediately and warms Web Audio buffer in background.
    playSystemSound('open');
    expect(playedHtmlAudio).toHaveLength(1);
    expect(playedHtmlAudio[0]?.src).toMatch(/sounds\/mt5-trade-open\.wav$/);

    // Wait for background fetch + decodeAudioData + cache write to settle.
    await vi.waitFor(() => {
      expect(fetchedUrls.some((u) => u.endsWith('sounds/mt5-trade-open.wav'))).toBe(true);
      expect(decodeAudioData).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));

    // Second play: hits decoded Web Audio buffer directly (0ms overlapping playback, no extra HTMLAudio).
    playSystemSound('open');
    expect(playedBuffers).toHaveLength(1);
    expect(playedBuffers[0]?.startedAt).toBe(0);
    expect(playedHtmlAudio).toHaveLength(1);
  });

  it('resumes a suspended AudioContext before playing MT5 trade sounds', async () => {
    const { playedHtmlAudio, resume } = installMockAudioEnvironment('suspended');
    playSystemSound('close-profit');
    expect(resume).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(playedHtmlAudio).toHaveLength(1);
    expect(playedHtmlAudio[0]?.src).toMatch(/sounds\/mt5-trade-close-profit\.wav$/);
  });

  it('respects doNotDisturb and tradeExecution.playSound preferences', () => {
    const { playedHtmlAudio, playedBuffers } = installMockAudioEnvironment('running');
    useSettingsStore.setState({
      notifications: {
        ...useSettingsStore.getState().notifications,
        tradeExecution: {
          ...useSettingsStore.getState().notifications.tradeExecution,
          playSound: false,
        },
      },
    });
    playSystemSound('buy');
    playSystemSound('sell');
    playSystemSound('open');
    playSystemSound('close-profit');
    playSystemSound('close-loss');
    playSystemSound('close-all');
    playSystemSound('close-single');
    expect(playedHtmlAudio).toHaveLength(0);
    expect(playedBuffers).toHaveLength(0);

    // Non-trade sounds (login) still play when only tradeExecution.playSound is false.
    playSystemSound('login');
    expect(playedHtmlAudio).toHaveLength(1);
    expect(playedHtmlAudio[0]?.src).toMatch(/sounds\/mt5-connect\.wav$/);

    playedHtmlAudio.length = 0;
    useSettingsStore.setState({
      notifications: {
        ...useSettingsStore.getState().notifications,
        doNotDisturb: true,
      },
    });
    playSystemSound('login');
    expect(playedHtmlAudio).toHaveLength(0);
  });
});
