/**
 * Suppresses the browser's native right-click context menu (Inspect, Reload,
 * View Page Source) across the application viewport while leaving custom
 * application context menus and browser DevTools keyboard shortcuts (F12,
 * Ctrl+Shift+I/J/C, Cmd+Option+I/J/C) active.
 */
export const installBrowserContextMenuGuard = (target: Document = document): (() => void) => {
  const handleContextMenu = (event: MouseEvent) => {
    if (!event.defaultPrevented) {
      event.preventDefault();
    }
  };
  target.addEventListener('contextmenu', handleContextMenu);
  return () => target.removeEventListener('contextmenu', handleContextMenu);
};
