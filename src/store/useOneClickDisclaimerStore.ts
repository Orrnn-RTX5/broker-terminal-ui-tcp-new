import { create } from 'zustand';
import { selectOneClickTrading, useSettingsStore } from './useSettingsStore';

export const ONE_CLICK_DISCLAIMER_SESSION_KEY = 'rtx5_one_click_disclaimer_accepted';

const readSessionAccepted = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(ONE_CLICK_DISCLAIMER_SESSION_KEY) === '1';
  } catch {
    return false;
  }
};

const writeSessionAccepted = (accepted: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    if (accepted) {
      window.sessionStorage.setItem(ONE_CLICK_DISCLAIMER_SESSION_KEY, '1');
    } else {
      window.sessionStorage.removeItem(ONE_CLICK_DISCLAIMER_SESSION_KEY);
    }
  } catch {
    // Ignore storage access failures in restricted environments.
  }
};

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
  onAccept: () => {
    writeSessionAccepted(true);
    useSettingsStore.getState().updateTradeSettings({ oneClickTrading: true });
    set({ isOpen: false, ownerId: null, acceptedInSession: true });
    resolveAllPending(true);
  },
  onCancel: () => {
    set({ isOpen: false, ownerId: null });
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
    set({ acceptedInSession: accepted });
  },
  syncSessionAcceptanceFromStorage: () => {
    const accepted = readSessionAccepted();
    set({ acceptedInSession: accepted });
    return accepted;
  },
  resetSessionAcceptance: () => {
    writeSessionAccepted(false);
    if (get().isOpen) {
      set({ isOpen: false, ownerId: null, acceptedInSession: false });
      resolveAllPending(false);
      return;
    }
    set({ acceptedInSession: false });
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
