import { toPublicAssetPath } from '../components/welcomeHeroAssets';
import { useSettingsStore } from '../store/useSettingsStore';

export type SystemSoundType =
  | 'open'
  | 'buy'
  | 'sell'
  | 'close'
  | 'close-single'
  | 'close-all'
  | 'close-profit'
  | 'close-loss'
  | 'login'
  | 'welcome';

type SoundAssetKey =
  | 'open'
  | 'buy'
  | 'sell'
  | 'close-single'
  | 'close-all'
  | 'close-profit'
  | 'close-loss'
  | 'login';

interface SoundAssetConfig {
  readonly assetKey: SoundAssetKey;
  readonly relativePath: string;
  readonly gain: number;
}

const TRADE_SOUND_TYPES = new Set<SystemSoundType>([
  'open',
  'buy',
  'sell',
  'close',
  'close-single',
  'close-all',
  'close-profit',
  'close-loss',
]);

/**
 * Distinct trading audio assets for buy, sell, open, close in profit,
 * close in loss, close all, single close, and login.
 */
const SOUND_ASSET_CONFIGS: Record<Exclude<SystemSoundType, 'welcome'>, SoundAssetConfig> = {
  open: {
    assetKey: 'open',
    relativePath: 'sounds/mt5-trade-open.wav',
    gain: 0.92,
  },
  buy: {
    assetKey: 'buy',
    relativePath: 'sounds/mt5-trade-buy.wav',
    gain: 0.94,
  },
  sell: {
    assetKey: 'sell',
    relativePath: 'sounds/mt5-trade-sell.wav',
    gain: 0.94,
  },
  close: {
    assetKey: 'close-single',
    relativePath: 'sounds/mt5-trade-close-single.wav',
    gain: 0.9,
  },
  'close-single': {
    assetKey: 'close-single',
    relativePath: 'sounds/mt5-trade-close-single.wav',
    gain: 0.9,
  },
  'close-all': {
    assetKey: 'close-all',
    relativePath: 'sounds/mt5-trade-close-all.wav',
    gain: 0.94,
  },
  'close-profit': {
    assetKey: 'close-profit',
    relativePath: 'sounds/mt5-trade-close-profit.wav',
    gain: 0.94,
  },
  'close-loss': {
    assetKey: 'close-loss',
    relativePath: 'sounds/mt5-trade-close-loss.wav',
    gain: 0.88,
  },
  login: {
    assetKey: 'login',
    relativePath: 'sounds/mt5-connect.wav',
    gain: 0.72,
  },
};

const PRELOAD_TRADE_KEYS: readonly SoundAssetKey[] = [
  'open',
  'buy',
  'sell',
  'close-single',
  'close-all',
  'close-profit',
  'close-loss',
];

let audioCtx: AudioContext | null = null;
let decodedBuffersCtx: AudioContext | null = null;
const decodedBuffers = new Map<SoundAssetKey, AudioBuffer>();
const pendingDecodes = new Map<SoundAssetKey, Promise<AudioBuffer | null>>();
let gestureUnlockInstalled = false;

export const getSystemSoundAssetPath = (type: SystemSoundType): string | null => {
  if (type === 'welcome') return null;
  const config = SOUND_ASSET_CONFIGS[type];
  return config ? toPublicAssetPath(config.relativePath) : null;
};

const getAudioContextConstructor = (): (typeof AudioContext) | undefined => {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
};

const clearDecodedCache = (): void => {
  decodedBuffers.clear();
  pendingDecodes.clear();
  decodedBuffersCtx = null;
};

const initAudio = (): AudioContext | null => {
  const Ctor = getAudioContextConstructor();
  if (!Ctor) return null;
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new Ctor();
    clearDecodedCache();
    decodedBuffersCtx = audioCtx;
  }
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume().catch(() => undefined);
  }
  return audioCtx;
};

const decodeAudioBuffer = async (
  ctx: AudioContext,
  arrayBuffer: ArrayBuffer,
): Promise<AudioBuffer | null> => {
  if (typeof ctx.decodeAudioData !== 'function') return null;
  try {
    // Pass a copy so engines that detach the ArrayBuffer during decode never mutate caller state.
    const bufferCopy = arrayBuffer.slice(0);
    return await new Promise<AudioBuffer>((resolve, reject) => {
      const maybePromise = ctx.decodeAudioData(bufferCopy, resolve, reject);
      if (maybePromise && typeof maybePromise.then === 'function') {
        void maybePromise.then(resolve, reject);
      }
    });
  } catch {
    return null;
  }
};

const loadSoundBuffer = (ctx: AudioContext, config: SoundAssetConfig): Promise<AudioBuffer | null> => {
  if (decodedBuffersCtx !== ctx) {
    clearDecodedCache();
    decodedBuffersCtx = ctx;
  }

  const cached = decodedBuffers.get(config.assetKey);
  if (cached) return Promise.resolve(cached);

  const inFlight = pendingDecodes.get(config.assetKey);
  if (inFlight) return inFlight;

  if (typeof fetch !== 'function' || typeof ctx.decodeAudioData !== 'function') {
    return Promise.resolve(null);
  }

  const url = toPublicAssetPath(config.relativePath);
  if (!url) return Promise.resolve(null);

  const task = fetch(url)
    .then((response) => {
      if (!response.ok) return null;
      return response.arrayBuffer();
    })
    .then((arrayBuffer) => {
      if (!arrayBuffer) return null;
      return decodeAudioBuffer(ctx, arrayBuffer);
    })
    .then((audioBuffer) => {
      if (audioBuffer && decodedBuffersCtx === ctx) {
        decodedBuffers.set(config.assetKey, audioBuffer);
      }
      return audioBuffer;
    })
    .catch(() => null)
    .finally(() => {
      if (pendingDecodes.get(config.assetKey) === task) {
        pendingDecodes.delete(config.assetKey);
      }
    });

  pendingDecodes.set(config.assetKey, task);
  return task;
};

const preloadTradeSounds = (ctx: AudioContext): void => {
  for (const key of PRELOAD_TRADE_KEYS) {
    void loadSoundBuffer(ctx, SOUND_ASSET_CONFIGS[key]);
  }
};

const playDecodedBuffer = (ctx: AudioContext, buffer: AudioBuffer, gainValue: number): boolean => {
  if (typeof ctx.createBufferSource !== 'function') return false;
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  if (typeof ctx.createGain === 'function') {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, ctx.currentTime);
    source.connect(gain);
    gain.connect(ctx.destination);
  } else {
    source.connect(ctx.destination);
  }

  source.start(0);
  return true;
};

const playHtmlAudioFallback = (config: SoundAssetConfig): boolean => {
  if (typeof window === 'undefined' || typeof Audio !== 'function') return false;
  const url = toPublicAssetPath(config.relativePath);
  if (!url) return false;
  try {
    const element = new Audio(url);
    element.preload = 'auto';
    element.volume = Math.max(0, Math.min(1, config.gain));
    const playResult = element.play();
    if (playResult && typeof playResult.catch === 'function') {
      void playResult.catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
};

const playWelcomeChord = (ctx: AudioContext): void => {
  if (typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') return;
  const now = ctx.currentTime + 0.002;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);

  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const osc3 = ctx.createOscillator();

  osc1.type = 'triangle';
  osc2.type = 'triangle';
  osc3.type = 'sine';

  osc1.connect(gain);
  osc2.connect(gain);
  osc3.connect(gain);

  osc1.frequency.setValueAtTime(440.0, now);
  osc2.frequency.setValueAtTime(554.37, now);
  osc3.frequency.setValueAtTime(659.25, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.14, now + 0.18);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);

  osc1.start(now);
  osc1.stop(now + 1.42);
  osc2.start(now);
  osc2.stop(now + 1.42);
  osc3.start(now);
  osc3.stop(now + 1.42);
};

const installAudioGestureUnlock = () => {
  if (gestureUnlockInstalled || typeof window === 'undefined') return;
  gestureUnlockInstalled = true;
  const unlock = () => {
    try {
      const ctx = initAudio();
      if (ctx) {
        preloadTradeSounds(ctx);
        if (ctx.state === 'running') {
          window.removeEventListener('pointerdown', unlock, true);
          window.removeEventListener('keydown', unlock, true);
        }
      }
    } catch {
      // Ignore audio unlock errors in headless or restricted environments.
    }
  };
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true, passive: true });
};

installAudioGestureUnlock();

const shouldPlaySound = (type: SystemSoundType): boolean => {
  try {
    const notifications = useSettingsStore.getState()?.notifications;
    if (!notifications) return true;
    if (notifications.doNotDisturb) return false;
    if (notifications.enableSoundAlerts === false) return false;
    if (TRADE_SOUND_TYPES.has(type) && notifications.tradeExecution?.playSound === false) {
      return false;
    }
  } catch {
    // Allow playback when settings store is unavailable in isolated tests.
  }
  return true;
};

export const playSystemSound = (type: SystemSoundType): void => {
  try {
    if (!shouldPlaySound(type)) return;

    if (type === 'welcome') {
      const ctx = initAudio();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        void ctx.resume().then(() => playWelcomeChord(ctx)).catch(() => undefined);
      } else {
        playWelcomeChord(ctx);
      }
      return;
    }

    const config = SOUND_ASSET_CONFIGS[type];
    if (!config) return;

    const ctx = initAudio();
    if (!ctx) {
      playHtmlAudioFallback(config);
      return;
    }

    const playWithContext = () => {
      if (decodedBuffersCtx !== ctx) {
        clearDecodedCache();
        decodedBuffersCtx = ctx;
      }

      const cached = decodedBuffers.get(config.assetKey);
      if (cached && playDecodedBuffer(ctx, cached, config.gain)) {
        return;
      }

      // Play immediately via HTMLAudioElement on cold cache so the very first trade never misses,
      // while decoding into Web Audio memory in the background for 0ms overlapping playback.
      const playedFallback = playHtmlAudioFallback(config);
      void loadSoundBuffer(ctx, config).then((buffer) => {
        if (!playedFallback && buffer) {
          playDecodedBuffer(ctx, buffer, config.gain);
        }
      });
    };

    if (ctx.state === 'suspended') {
      void ctx.resume().then(playWithContext).catch(() => {
        playHtmlAudioFallback(config);
      });
    } else {
      playWithContext();
    }
  } catch (e) {
    console.warn('System sound playback skipped/blocked by browser policy without interaction.', e);
  }
};

export const resetAudioContextForTests = (): void => {
  audioCtx = null;
  clearDecodedCache();
};
