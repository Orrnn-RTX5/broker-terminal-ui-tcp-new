import { useCallback, useMemo, useState } from 'react';
import { useUiTranslation } from '../../hooks/useUiTranslation';
import { Icon } from '../ui/Icon';
import { DEFAULT_COMPANY_URL, sanitizeCompanyUrl } from './companyRuntime';
import './company-tab.css';

export { DEFAULT_COMPANY_URL };

export interface CompanyTabProps {
    /** URL to render inside the embedded Company pane. Defaults to https://orrnn.com. */
    url?: string;
    /** True while the Company dock tab is the visible one. */
    active?: boolean;
}

export function CompanyTab({ url = DEFAULT_COMPANY_URL }: CompanyTabProps) {
    const tr = useUiTranslation();
    const resolvedUrl = useMemo(() => sanitizeCompanyUrl(url), [url]);
    const [reloadNonce, setReloadNonce] = useState(0);
    const [loadedKey, setLoadedKey] = useState<string | null>(null);

    const frameKey = resolvedUrl ? `${resolvedUrl}:${reloadNonce}` : '';
    const loading = Boolean(resolvedUrl) && loadedKey !== frameKey;

    const handleReload = useCallback(() => {
        setReloadNonce((current) => current + 1);
    }, []);

    if (!resolvedUrl) {
        return (
            <div className="rtx-company-tab" data-testid="company-tab">
                <div className="rtx-company-state" role="status">{tr('Broker company information')}</div>
            </div>
        );
    }

    return (
        <div className="rtx-company-tab" data-testid="company-tab">
            <div className="rtx-company-toolbar" data-dock-inner-header="true">
                <button
                    type="button"
                    className="rtx-company-btn"
                    title={tr('Refresh')}
                    aria-label={tr('Refresh')}
                    onClick={handleReload}
                >
                    <Icon name="refresh" size="xs" />
                </button>
                {loading ? <span className="rtx-company-status" role="status">{tr('Loading…')}</span> : null}
            </div>
            <div className="rtx-company-body">
                <iframe
                    key={frameKey}
                    className="rtx-company-frame"
                    data-testid="company-iframe"
                    title={tr('Company')}
                    src={resolvedUrl}
                    referrerPolicy="strict-origin-when-cross-origin"
                    allow="clipboard-write"
                    onLoad={() => setLoadedKey(frameKey)}
                />
            </div>
        </div>
    );
}
