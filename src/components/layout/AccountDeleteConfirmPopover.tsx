import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUiTranslation } from '../../hooks/useUiTranslation';
import { useDialogFocusScope } from '../../hooks/useDialogFocusScope';
import '../../styles/account-delete-popover.css';

interface AccountDeleteConfirmPopoverProps {
    accountLogin: number | null;
    onConfirm: () => void;
    onCancel: () => void;
}

export function AccountDeleteConfirmPopover({
    accountLogin,
    onConfirm,
    onCancel,
}: AccountDeleteConfirmPopoverProps) {
    const tr = useUiTranslation();
    const isOpen = accountLogin !== null;
    const dialogRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const descId = useId();

    useDialogFocusScope({
        isOpen,
        dialogRef,
        onClose: onCancel,
    });

    if (!isOpen) return null;

    return createPortal(
        <div
            className="rtx-account-delete-backdrop"
            data-testid="account-delete-backdrop"
            onPointerDown={(event) => {
                event.stopPropagation();
                if (event.target === event.currentTarget) {
                    onCancel();
                }
            }}
            onClick={(event) => {
                event.stopPropagation();
                if (event.target === event.currentTarget) {
                    onCancel();
                }
            }}
            onContextMenuCapture={(event) => {
                event.stopPropagation();
                event.preventDefault();
            }}
            onContextMenu={(event) => event.stopPropagation()}
        >
            <div
                ref={dialogRef}
                tabIndex={-1}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descId}
                className="rtx-account-delete-popover"
                data-testid="account-delete-popover"
            >
                <div className="rtx-account-delete-popover__body">
                    <p id={titleId} className="rtx-account-delete-popover__title">
                        {tr('Remove account {{value0}} from saved list?', { value0: String(accountLogin) })}
                    </p>
                    <p id={descId} className="rtx-account-delete-popover__message">
                        {tr('Are you sure?')}
                    </p>
                </div>

                <div className="rtx-account-delete-popover__actions">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="rtx-account-delete-popover__btn-cancel"
                    >
                        {tr('Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="rtx-account-delete-popover__btn-confirm"
                    >
                        {tr('Delete')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
