import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n, { i18nReady } from '../../i18n';
import { DEALING_REASON_UI_STRINGS } from '../../services/dealing/dealingI18n';
import { ingestDealingEvent } from '../../services/dealing/dealingEvents';
import { createMockDealingUuid } from '../../services/dealing/dealingMock';
import { useDealingStore } from '../../store/useDealingStore';
import { DealingStatusChip } from './DealingStatusChip';

describe('DealingStatusChip', () => {
  beforeEach(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    useDealingStore.getState().reset();
  });

  afterEach(async () => {
    useDealingStore.getState().reset();
    vi.useRealTimers();
    await i18n.changeLanguage('en');
  });

  it('shows "Request sent to dealer…" with spinner during in_dealing and hides when filled', () => {
    const reqId = createMockDealingUuid(0x01);
    const now = Date.now();
    render(<DealingStatusChip clientOrderId="bo-chip-1" />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        clientOrderId: 'bo-chip-1',
        symbol: 'EURUSD',
        phase: 'in_dealing',
        expiresAtMs: now + 10_000,
        serverNowMs: now,
      }, now);
    });

    const chip = screen.getByRole('status');
    expect(chip).toHaveTextContent('Request sent to dealer…');
    expect(chip).toHaveTextContent('10s');
    expect(chip.querySelector('.rtx-dealing-chip__countdown')).toHaveAttribute('aria-hidden', 'true');
    expect(chip.querySelector('.rtx-dealing-chip__spinner')).not.toBeNull();

    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        phase: 'filled',
        orderTicket: 1001,
      }, now + 500);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('displays sanitized dealer rejection reason when showTerminal=true', () => {
    const reqId = createMockDealingUuid(0x02);
    render(<DealingStatusChip requestId={reqId} showTerminal />);

    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        symbol: 'XAUUSD',
        phase: 'in_dealing',
      });
      ingestDealingEvent({
        requestId: reqId,
        phase: 'rejected',
        reasonCode: 'RISK_LIMIT',
        reasonText: 'Order exceeds risk or exposure limits',
      });
    });

    expect(screen.getByRole('status')).toHaveTextContent('Order exceeds risk or exposure limits');
  });

  it('routes reason codes through useUiTranslation() i18n keys while keeping custom text verbatim', async () => {
    i18n.addResourceBundle(
      'fr',
      'ui',
      { [DEALING_REASON_UI_STRINGS.OFF_QUOTES]: '[fr] Hors cotation' },
      true,
      true,
    );
    await act(async () => {
      await i18n.changeLanguage('fr');
    });

    const reqCode = createMockDealingUuid(0x03);
    const reqCustom = createMockDealingUuid(0x04);

    render(
      <>
        <DealingStatusChip requestId={reqCode} showTerminal />
        <DealingStatusChip requestId={reqCustom} showTerminal />
      </>,
    );

    act(() => {
      ingestDealingEvent({
        requestId: reqCode,
        symbol: 'EURUSD',
        phase: 'rejected',
        reasonCode: 'OFF_QUOTES',
      });
      ingestDealingEvent({
        requestId: reqCustom,
        symbol: 'XAUUSD',
        phase: 'rejected',
        reasonCode: 'CUSTOM',
        reasonText: 'Desk quote spread threshold exceeded',
      });
    });

    const statuses = screen.getAllByRole('status');
    expect(statuses[0]).toHaveTextContent('[fr] Hors cotation');
    expect(statuses[1]).toHaveTextContent('Desk quote spread threshold exceeded');
  });

  it('shows neutral waiting-for-confirmation state on synthetic expiry and clears on late fill', () => {
    const reqId = createMockDealingUuid(0x05);
    render(<DealingStatusChip requestId={reqId} />);

    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        symbol: 'EURUSD',
        phase: 'expired',
        synthetic: true,
      });
    });

    const chip = screen.getByRole('status');
    expect(chip).toHaveAttribute('data-dealing-synthetic', 'true');
    expect(chip).toHaveTextContent('Awaiting dealer confirmation…');
    expect(chip.querySelector('.rtx-dealing-chip__spinner')).not.toBeNull();

    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        seq: 3,
        phase: 'filled',
        orderTicket: 9902,
      });
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
