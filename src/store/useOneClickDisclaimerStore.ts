import { create } from 'zustand';
import { selectOneClickTrading, useSettingsStore } from './useSettingsStore';

export const ONE_CLICK_DISCLAIMER_SESSION_KEY = 'rtx5_one_click_disclaimer_accepted';
export const ONE_CLICK_DISCLAIMER_DECLINED_SESSION_KEY = 'rtx5_one_click_disclaimer_declined';

const readSessionFlag = (key: string): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

const writeSessionFlag = (key: string, value: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      window.sessionStorage.setItem(key, '1');
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore storage access failures in restricted environments.
  }
};

const readSessionAccepted = (): boolean => readSessionFlag(ONE_CLICK_DISCLAIMER_SESSION_KEY);
const writeSessionAccepted = (accepted: boolean): void => writeSessionFlag(ONE_CLICK_DISCLAIMER_SESSION_KEY, accepted);
const readSessionDeclined = (): boolean => !readSessionAccepted() && readSessionFlag(ONE_CLICK_DISCLAIMER_DECLINED_SESSION_KEY);
const writeSessionDeclined = (declined: boolean): void => writeSessionFlag(ONE_CLICK_DISCLAIMER_DECLINED_SESSION_KEY, declined);

interface OneClickDisclaimerState {
  requestId: number;
  isOpen: boolean;
  ownerId: string | null;
  globalHostCount: number;
  /**
   * Scoped to the current browser tab / application window via `sessionStorage`:
   * - Survives normal page refresh and hard refresh (Cmd/Ctrl+Shift+R).
   * - Automatically clears when the tab, page, or desktop application is closed
   *   and reopened, so the disclaimer is shown again on the next launch.
   */
  acceptedInSession: boolean;
  /**
   * Tracks when the user explicitly canceled/dismissed the disclaimer in this
   * session so subsequent chart BUY/SELL clicks open the Order sheet instead
   * of repeatedly popping up the disclaimer.
   */
  declinedInSession: boolean;
  onAccept: () => void;
  onCancel: () => void;
  registerGlobalHost: () => () => void;
  requestOneClickAcceptance: (ownerId?: string | null) => Promise<boolean>;
  setAcceptedInSession: (accepted: boolean) => void;
  syncSessionAcceptanceFromStorage: () => boolean;
  resetSessionAcceptance: () => void;
  closeDisclaimer: () => void;
}

let nextRequestId = 0;
let pendingResolvers: Array<(accepted: boolean) => void> = [];

const resolveAllPending = (accepted: boolean) => {
  if (pendingResolvers.length === 0) return;
  const resolvers = pendingResolvers;
  pendingResolvers = [];
  for (const resolve of resolvers) {
    resolve(accepted);
  }
};

export const isOneClickTradingAccepted = (): boolean => {
  try {
    return useOneClickDisclaimerStore.getState().acceptedInSession === true
      && selectOneClickTrading(useSettingsStore.getState()) === true;
  } catch {
    return false;
  }
};

export const useOneClickDisclaimerStore = create<OneClickDisclaimerState>((set, get) => ({
  requestId: 0,
  isOpen: false,
  ownerId: null,
  globalHostCount: 0,
  acceptedInSession: readSessionAccepted(),
  declinedInSession: readSessionDeclined(),
  onAccept: () => {
    writeSessionAccepted(true);
    writeSessionDeclined(false);
    useSettingsStore.getState().updateTradeSettings({ oneClickTrading: true });
    set({ isOpen: false, ownerId: null, acceptedInSession: true, declinedInSession: false });
    resolveAllPending(true);
  },
  onCancel: () => {
    writeSessionDeclined(true);
    set({ isOpen: false, ownerId: null, declinedInSession: true });
    resolveAllPending(false);
  },
  registerGlobalHost: () => {
    set((state) => ({ globalHostCount: state.globalHostCount + 1 }));
    return () => {
      set((state) => ({ globalHostCount: Math.max(0, state.globalHostCount - 1) }));
    };
  },
  requestOneClickAcceptance: (ownerId = null) => {
    if (isOneClickTradingAccepted()) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      pendingResolvers.push(resolve);
      if (get().isOpen) {
        return;
      }

      const requestId = ++nextRequestId;
      set({
        requestId,
        isOpen: true,
        ownerId: ownerId ?? null,
      });
    });
  },
  setAcceptedInSession: (accepted) => {
    writeSessionAccepted(accepted);
    if (accepted) {
      writeSessionDeclined(false);
      set({ acceptedInSession: true, declinedInSession: false });
      return;
    }
    set({ acceptedInSession: false });
  },
  syncSessionAcceptanceFromStorage: () => {
    const accepted = readSessionAccepted();
    const declined = accepted ? false : readSessionDeclined();
    set({ acceptedInSession: accepted, declinedInSession: declined });
    return accepted;
  },
  resetSessionAcceptance: () => {
    writeSessionAccepted(false);
    writeSessionDeclined(false);
    if (get().isOpen) {
      set({ isOpen: false, ownerId: null, acceptedInSession: false, declinedInSession: false });
      resolveAllPending(false);
      return;
    }
    set({ acceptedInSession: false, declinedInSession: false });
  },
  closeDisclaimer: () => {
    if (get().isOpen) {
      get().onCancel();
      return;
    }
    set({ isOpen: false, ownerId: null });
    resolveAllPending(false);
  },
}));
