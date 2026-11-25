import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUiTranslation } from '../../hooks/useUiTranslation';
import { useDialogFocusScope } from '../../hooks/useDialogFocusScope';
import { useDraggableSheet } from '../../hooks/useDraggableSheet';
import { brokerDisplayName, isBrokerName, NEUTRAL_TERMINAL_TITLE } from '../../services/brokerDisplayName';
import { useOneClickDisclaimerStore } from '../../store/useOneClickDisclaimerStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import '../../styles/one-click-disclaimer-dialog.css';

interface OneClickDisclaimerDialogProps {
  /** Mounted once at the root shell so all entry points share one dialog portal. */
  globalHost?: boolean;
  /** Local fallback owner id for standalone component renders outside the root shell. */
  ownerId?: string;
}

function resolveOneClickDisclaimerEntityName(serverName: string): string {
  const resolved = brokerDisplayName(serverName);
  if (!isBrokerName(resolved) || resolved.toLowerCase() === NEUTRAL_TERMINAL_TITLE.toLowerCase()) {
    return 'the broker';
  }
  return resolved;
}

export function OneClickDisclaimerDialog({ globalHost = false, ownerId }: OneClickDisclaimerDialogProps = {}) {
  const tr = useUiTranslation();
  const isOpen = useOneClickDisclaimerStore((state) => state.isOpen);
  const activeOwnerId = useOneClickDisclaimerStore((state) => state.ownerId);
  const globalHostCount = useOneClickDisclaimerStore((state) => state.globalHostCount);
  const onAccept = useOneClickDisclaimerStore((state) => state.onAccept);
  const onCancel = useOneClickDisclaimerStore((state) => state.onCancel);
  const registerGlobalHost = useOneClickDisclaimerStore((state) => state.registerGlobalHost);
  const serverName = useSettingsStore((state) => state.server.serverName);

  useEffect(() => {
    if (!globalHost) return;
    return registerGlobalHost();
  }, [globalHost, registerGlobalHost]);

  const shouldRender = isOpen && (
    globalHost
      ? true
      : globalHostCount === 0 && (ownerId ? activeOwnerId === ownerId : true)
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const contentId = useId();

  useDialogFocusScope({
    isOpen: shouldRender,
    dialogRef,
    onClose: onCancel,
  });
  const { dragStyle, dragHandleProps } = useDraggableSheet({
    isOpen: shouldRender,
    elementRef: dialogRef,
  });

  if (!shouldRender) return null;

  const brokerEntity = resolveOneClickDisclaimerEntityName(serverName);

  return createPortal(
    <div
      className="rtx-oct-disclaimer-backdrop"
      data-testid="one-click-disclaimer-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onContextMenuCapture={(event) => {
        event.stopPropagation();
        event.preventDefault();
      }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={contentId}
        style={dragStyle}
        className="rtx-oct-disclaimer-dialog"
        data-testid="one-click-disclaimer-dialog"
      >
        {/* Title Bar */}
        <div className="rtx-oct-disclaimer-dialog__header" {...dragHandleProps}>
          <div className="rtx-oct-disclaimer-dialog__title-group">
            <span className="rtx-oct-disclaimer-dialog__icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="3" width="6.5" height="10" rx="1" fill="#ff5858" />
                <rect x="8.5" y="3" width="6.5" height="10" rx="1" fill="#4597ff" />
                <path d="M3 6.5H5.5M3 9.5H5.5" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" />
                <path d="M10.5 6.5H13M10.5 9.5H13" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </span>
            <span id={titleId} className="rtx-oct-disclaimer-dialog__title">
              {tr('One Click Trading')}
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label={tr('Close dialog')}
            className="rtx-oct-disclaimer-dialog__close"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Short Flat Document Body — fits cleanly without vertical scrolling */}
        <div id={contentId} className="rtx-oct-disclaimer-dialog__body">
          <h3 className="rtx-oct-disclaimer-dialog__heading">{tr('Disclaimer')}</h3>

          <p>
            {tr('By clicking "I Accept these Terms and Conditions", you activate One Click Trading mode for this session and agree to these terms.')}
          </p>

          <p>
            {tr('1. Default mode is a two-step process requiring order setup and explicit confirmation before submission.')}
          </p>

          <p className="rtx-oct-disclaimer-dialog__list-intro">
            {tr('2. One Click Trading mode is a one-step process. Orders submit immediately when you:')}
          </p>

          <ul className="rtx-oct-disclaimer-dialog__list">
            <li>- {tr('click BUY or SELL on a chart panel or Market Watch Trading tab')}</li>
            <li>- {tr('click Buy, Sell, or Close in the Depth of Market window')}</li>
            <li>- {tr('place, drag, or delete orders from the chart, DOM, or Toolbox')}</li>
          </ul>

          <p className="rtx-oct-disclaimer-dialog__warning">
            {tr('THERE WILL BE NO FURTHER CONFIRMATION PROMPT. MARKET ORDERS FILL PROMPTLY AND CANNOT BE WITHDRAWN OR CHANGED.')}
          </p>

          <p>
            {tr('You accept all risks of errors or accidental clicks and agree to indemnify {{brokerName}} from related losses. You can enable or disable this mode anytime in Options → Trade.', { brokerName: brokerEntity })}
          </p>
        </div>

        {/* Footer */}
        <div className="rtx-oct-disclaimer-dialog__footer">
          <button
            type="button"
            onClick={onCancel}
            className="rtx-oct-disclaimer-dialog__btn-cancel"
          >
            {tr('Cancel')}
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="rtx-oct-disclaimer-dialog__btn-accept"
          >
            {tr('I Accept these Terms and Conditions')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
