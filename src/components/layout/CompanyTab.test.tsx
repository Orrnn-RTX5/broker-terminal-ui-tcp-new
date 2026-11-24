// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanyTab, DEFAULT_COMPANY_URL } from './CompanyTab';

describe('CompanyTab', () => {
    afterEach(() => {
        cleanup();
    });

    it('renders the embedded company website iframe and clears loading state on load', () => {
        render(<CompanyTab />);
        expect(screen.getByTestId('company-tab')).toBeInTheDocument();
        const iframe = screen.getByTestId('company-iframe') as HTMLIFrameElement;
        expect(iframe.tagName).toBe('IFRAME');
        expect(iframe).toHaveAttribute('src', `${DEFAULT_COMPANY_URL}/`);
        expect(iframe).toHaveAttribute('title', 'Company');
        expect(screen.getByRole('status')).toHaveTextContent('Loading…');

        fireEvent.load(iframe);
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('reloads the embedded iframe when Refresh is clicked', () => {
        render(<CompanyTab />);
        const initialIframe = screen.getByTestId('company-iframe');
        fireEvent.load(initialIframe);
        expect(screen.queryByRole('status')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        const reloadedIframe = screen.getByTestId('company-iframe');
        expect(reloadedIframe).not.toBe(initialIframe);
        expect(screen.getByRole('status')).toHaveTextContent('Loading…');

        fireEvent.load(reloadedIframe);
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('renders only the Refresh button in the toolbar without the URL text or Open in browser button', () => {
        render(<CompanyTab />);
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0]).toHaveAccessibleName('Refresh');
        expect(screen.queryByText(DEFAULT_COMPANY_URL)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Open in browser' })).toBeNull();
    });

    it('rejects unsafe or credential-bearing URLs and renders no iframe', () => {
        for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:pass@orrnn.com', '']) {
            const view = render(<CompanyTab url={bad} />);
            expect(screen.queryByTestId('company-iframe'), bad).toBeNull();
            expect(screen.getByRole('status'), bad).toHaveTextContent('Broker company information');
            view.unmount();
        }
    });
});
