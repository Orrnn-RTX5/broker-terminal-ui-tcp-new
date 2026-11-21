import { useChartObjectStateStore } from '../store/useChartObjectStateStore';
import { useDockLayoutStore } from '../store/useDockLayoutStore';
import { useLastSymbolStore } from '../store/useLastSymbolStore';
import {
  clearAllSessionViewState,
  clearResettableLocalViewState,
  dispatchWorkspaceViewReset,
} from './sessionViewState';

/** Single entry point for every "Reset Layout" trigger: toolbar, Window menu, shortcut, empty workspace. */
// Reset restores panel geometry and session view defaults only. The interface
// locale stays exactly as the user set it in the existing i18n store, so this
// module never touches i18n.
export const resetWorkspaceLayout = () => {
  clearAllSessionViewState();
  clearResettableLocalViewState();
  useChartObjectStateStore.getState().resetAll();
  useLastSymbolStore.getState().setPanelVisible(false);
  useDockLayoutStore.getState().resetWindows();
  dispatchWorkspaceViewReset();
};
