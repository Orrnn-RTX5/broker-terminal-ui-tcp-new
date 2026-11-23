import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MT_RET_REQUEST_CANCEL,
  MT_RET_REQUEST_DONE,
  WIRE_ACTION_REQUOTE_ACCEPT,
  WIRE_ACTION_REQUOTE_DECLINE,
  WIRE_STATUS_OK,
  decodeRequoteActionFrame,
  encodeOrderRespFrame,
} from '../../services/dealing/binaryDealingCodec';
import { ingestDealingEvent } from '../../services/dealing/dealingEvents';
import { createMockDealingUuid } from '../../services/dealing/dealingMock';
import { DEALING_DECISION_SAFETY_GRACE_MS, type RequoteDecisionTransport } from '../../hooks/useDealingRequest';
import { useDealingStore } from '../../store/useDealingStore';
import { RequoteDialog } from './RequoteDialog';

describe('RequoteDialog', () => {
  beforeEach(() => {
    useDealingStore.getState().reset();
  });

  afterEach(() => {
    useDealingStore.getState().reset();
    vi.useRealTimers();
  });

  it('renders new quote, focuses Decline initially, and sends Action 9 when Accept is clicked', async () => {
    const user = userEvent.setup();
    const reqId = createMockDealingUuid(0x11);
    const rqId = createMockDealingUuid(0x12);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqId,
      clientOrderId: 'bo-dlg-1',
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 2.0,
      digits: 5,
      price: 1.08452,
      phase: 'in_dealing',
      expiresAtMs: now + 10_000,
      serverNowMs: now,
    }, now);

    ingestDealingEvent({
      requestId: reqId,
      phase: 'requoted',
      requoteId: rqId,
      bid: 1.0848,
      ask: 1.08495,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    const transport = vi.fn<RequoteDecisionTransport>((frame) => {
      const decoded = decodeRequoteActionFrame(frame);
      expect(decoded.action).toBe(WIRE_ACTION_REQUOTE_ACCEPT);
      expect(decoded.price).toBe(1.08495);
      expect(decoded.ticket).toBe(0);
      expect(decoded.expiration).toBe(0);
      expect(decoded.extras.dealingRequestUuid).toBe(reqId);
      expect(decoded.extras.dealingRequoteUuid).toBe(rqId);

      return encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: WIRE_STATUS_OK,
        orderTicket: 9001,
        fillPrice: 1.08495,
        symbol: 'EURUSD',
        clientOrderId: 'bo-dlg-1',
        execWire: { retcode: MT_RET_REQUEST_DONE, requestId: reqId, requoteId: rqId },
      });
    });

    render(<RequoteDialog sendRequoteFrame={transport} />);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId('requote-bid')).toHaveTextContent('1.08480');
    expect(screen.getByTestId('requote-ask')).toHaveTextContent('1.08495');
    expect(screen.getByTestId('requote-countdown')).toHaveTextContent('5s');

    const declineBtn = screen.getByRole('button', { name: 'Decline' });
    const acceptBtn = screen.getByRole('button', { name: /Accept @ 1\.08495/ });
    expect(declineBtn).toHaveFocus();

    await user.click(acceptBtn);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('declines on Escape and advances FIFO queue to the next requoted order', async () => {
    const user = userEvent.setup();
    const req1 = createMockDealingUuid(0x21);
    const rq1 = createMockDealingUuid(0x22);
    const req2 = createMockDealingUuid(0x23);
    const rq2 = createMockDealingUuid(0x24);
    const now = Date.now();

    ingestDealingEvent({
      requestId: req1,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rq1,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    ingestDealingEvent({
      requestId: req2,
      accountLogin: 100042,
      symbol: 'XAUUSD',
      side: 'sell',
      volume: 0.5,
      digits: 2,
      bid: 2345.1,
      ask: 2345.6,
      phase: 'requoted',
      requoteId: rq2,
      expiresAtMs: now + 8_000,
      serverNowMs: now,
    }, now);

    const transport = vi.fn<RequoteDecisionTransport>((frame) => {
      const decoded = decodeRequoteActionFrame(frame);
      expect(decoded.action).toBe(WIRE_ACTION_REQUOTE_DECLINE);
      expect(decoded.price).toBe(0);
      return encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_DECLINE,
        status: WIRE_STATUS_OK,
        symbol: 'EURUSD',
        errorCode: 'CLIENT_DECLINED',
        execWire: { retcode: MT_RET_REQUEST_CANCEL, requestId: req1, requoteId: rq1 },
      });
    });

    render(<RequoteDialog sendRequoteFrame={transport} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('EURUSD');

    await user.keyboard('{Escape}');
    expect(transport).toHaveBeenCalledTimes(1);

    // Second queued requote opens immediately with 2-decimal formatting (0.5 -> 0.50)
    expect(screen.getByRole('alertdialog')).toHaveTextContent('XAUUSD');
    expect(screen.getByText('0.50')).toBeInTheDocument();
    expect(screen.getByTestId('requote-bid')).toHaveTextContent('2345.10');
    expect(screen.getByRole('button', { name: /Accept @ 2345\.10/ })).toBeInTheDocument();
  });

  it('never declines on backdrop click, removes X button in favor of Escape description, and ignores Escape and Decline while accepting', async () => {
    const user = userEvent.setup();
    const reqId = createMockDealingUuid(0x51);
    const rqId = createMockDealingUuid(0x52);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqId,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      digits: 5,
      bid: 1.0848,
      ask: 1.08495,
      phase: 'requoted',
      requoteId: rqId,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    let resolveAccept!: (v: ReturnType<typeof encodeOrderRespFrame>) => void;
    const pendingAccept = new Promise<ReturnType<typeof encodeOrderRespFrame>>((resolve) => {
      resolveAccept = resolve;
    });
    const transport = vi.fn<RequoteDecisionTransport>(() => pendingAccept);

    render(<RequoteDialog sendRequoteFrame={transport} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleDescription(/Press Escape to decline/);
    expect(screen.queryByRole('button', { name: 'Close dialog' })).toBeNull();
    const backdrop = document.querySelector('.rtx-requote-backdrop') as HTMLElement;
    expect(backdrop).not.toBeNull();

    // Backdrop click must NOT decline
    await user.click(backdrop);
    expect(transport).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    // Click Accept -> enters accepting (submitting)
    const acceptBtn = screen.getByRole('button', { name: /Accept @ 1\.08495/ });
    await user.click(acceptBtn);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(useDealingStore.getState().requests[reqId].phase).toBe('accepting');

    // Decline and Escape during accepting send nothing
    const declineBtn = screen.getByRole('button', { name: /Declin/i });
    expect(declineBtn).toBeDisabled();

    await user.click(backdrop);
    await user.click(declineBtn);
    await user.keyboard('{Escape}');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(useDealingStore.getState().requests[reqId].phase).toBe('accepting');

    resolveAccept(
      encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: WIRE_STATUS_OK,
        orderTicket: 9099,
        fillPrice: 1.08495,
        symbol: 'EURUSD',
        execWire: { retcode: MT_RET_REQUEST_DONE, requestId: reqId, requoteId: rqId },
      }),
    );
    await act(async () => {
      await pendingAccept;
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('closes hung accepting dialog cleanly after requote.expiresAtMs + 2s safety timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    const reqId = createMockDealingUuid(0x61);
    const rqId = createMockDealingUuid(0x62);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqId,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      digits: 5,
      bid: 1.0848,
      ask: 1.08495,
      phase: 'requoted',
      requoteId: rqId,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    const transport = vi.fn<RequoteDecisionTransport>(() => new Promise<void>(() => {}));
    render(<RequoteDialog sendRequoteFrame={transport} />);

    await act(async () => {
      screen.getByRole('button', { name: /Accept @ 1\.08495/ }).click();
      await Promise.resolve();
    });
    expect(useDealingStore.getState().requests[reqId].phase).toBe('accepting');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5_000 + DEALING_DECISION_SAFETY_GRACE_MS);
      await Promise.resolve();
    });
    expect(useDealingStore.getState().requests[reqId].phase).toBe('expired');
    expect(useDealingStore.getState().requests[reqId].synthetic).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Late filled via 0x3B/0x3A reconciles cleanly over synthetic expiry
    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        seq: 3,
        phase: 'filled',
        orderTicket: 9123,
        price: 1.08495,
      });
    });
    expect(useDealingStore.getState().requests[reqId].phase).toBe('filled');
    expect(useDealingStore.getState().requests[reqId].synthetic).toBe(false);
  });

  it('auto-declines at 0, disables Accept, and shows Requote expired while awaiting server settle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    const reqId = createMockDealingUuid(0x31);
    const rqId = createMockDealingUuid(0x32);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqId,
      accountLogin: 100042,
      symbol: 'USDJPY',
      side: 'buy',
      volume: 1.0,
      digits: 3,
      bid: 154.1,
      ask: 154.15,
      phase: 'requoted',
      requoteId: rqId,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    let resolveDecline!: () => void;
    const pendingDecline = new Promise<void>((resolve) => {
      resolveDecline = resolve;
    });
    const transport = vi.fn<RequoteDecisionTransport>(() => pendingDecline);

    render(<RequoteDialog sendRequoteFrame={transport} />);
    expect(screen.getByTestId('requote-countdown')).toHaveTextContent('5s');

    await act(async () => {
      vi.advanceTimersByTime(5_100);
      await Promise.resolve();
    });

    expect(transport).toHaveBeenCalledTimes(1);
    const decoded = decodeRequoteActionFrame(transport.mock.calls[0][0]);
    expect(decoded.action).toBe(WIRE_ACTION_REQUOTE_DECLINE);
    expect(decoded.price).toBe(0);

    expect(screen.getByTestId('requote-countdown')).toHaveTextContent('0s');
    expect(screen.getByText('Requote expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accept/ })).toBeDisabled();

    resolveDecline();
    await act(async () => {
      await pendingDecline;
    });
  });

  it('N2/N3: skips expired head when autoDeclineOnExpire=false and unblocks 2nd requote if auto-decline retry fails; shows awaiting text on expired accepting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const now = Date.now();

    // Part A: Failed auto-decline retries ONCE, then moves head to synthetic awaiting state so 2nd requote unblocks
    const req1 = createMockDealingUuid(0x71);
    const rq1 = createMockDealingUuid(0x72);
    const req2 = createMockDealingUuid(0x73);
    const rq2 = createMockDealingUuid(0x74);

    ingestDealingEvent({
      requestId: req1,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rq1,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);
    ingestDealingEvent({
      requestId: req2,
      accountLogin: 100042,
      symbol: 'GBPUSD',
      side: 'sell',
      volume: 1,
      digits: 5,
      bid: 1.254,
      ask: 1.2542,
      phase: 'requoted',
      requoteId: rq2,
      expiresAtMs: now + 15_000,
      serverNowMs: now,
    }, now);

    const failingTx = vi.fn<RequoteDecisionTransport>().mockRejectedValue(new Error('socket busy'));
    const { rerender } = render(<RequoteDialog sendRequoteFrame={failingTx} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('EURUSD');

    // Countdown expires -> attempt 1 fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(failingTx).toHaveBeenCalledTimes(1);

    // 250ms retry fires -> attempt 2 also fails -> moves req1 to synthetic expired and unblocks GBPUSD
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(failingTx).toHaveBeenCalledTimes(2);
    expect(useDealingStore.getState().requests[req1].phase).toBe('expired');
    expect(useDealingStore.getState().requests[req1].synthetic).toBe(true);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('GBPUSD');

    // Part B: N2 awaiting text when accepting reaches 0s countdown
    const acceptTx = vi.fn<RequoteDecisionTransport>(() => new Promise<void>(() => {}));
    useDealingStore.getState().reset();
    const t2 = Date.now();
    const accId = createMockDealingUuid(0x75);
    ingestDealingEvent({
      requestId: accId,
      accountLogin: 100042,
      symbol: 'XAUUSD',
      side: 'buy',
      volume: 1,
      digits: 2,
      bid: 2350.1,
      ask: 2350.4,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0x76),
      expiresAtMs: t2 + 2_000,
      serverNowMs: t2,
    }, t2);

    rerender(<RequoteDialog sendRequoteFrame={acceptTx} />);
    await act(async () => {
      screen.getByRole('button', { name: /Accept @ 2350\.40/ }).click();
      await Promise.resolve();
    });
    expect(acceptTx).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(screen.getByText('Awaiting dealer confirmation…')).toBeInTheDocument();

    // Part C: N3 autoDeclineOnExpire=false skips expired head and advances to queued requote without sending decline
    useDealingStore.getState().reset();
    const noCallTx = vi.fn<RequoteDecisionTransport>().mockResolvedValue(undefined);
    const t3 = Date.now();
    const skipId = createMockDealingUuid(0x77);
    const nextId = createMockDealingUuid(0x79);
    ingestDealingEvent({
      requestId: skipId,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0x78),
      expiresAtMs: t3 + 3_000,
      serverNowMs: t3,
    }, t3);
    ingestDealingEvent({
      requestId: nextId,
      accountLogin: 100042,
      symbol: 'GBPUSD',
      side: 'sell',
      volume: 1,
      digits: 5,
      bid: 1.254,
      ask: 1.2542,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0x7a),
      expiresAtMs: t3 + 15_000,
      serverNowMs: t3,
    }, t3);

    rerender(<RequoteDialog autoDeclineOnExpire={false} sendRequoteFrame={noCallTx} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('EURUSD');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    expect(noCallTx).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('GBPUSD');
  });

  it('never renders for EA (ORDER_REASON_EXPERT) orders', () => {
    const reqId = createMockDealingUuid(0x41);
    ingestDealingEvent({
      requestId: reqId,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      isExpert: true,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0x42),
      bid: 1.08,
      ask: 1.0802,
    });

    render(<RequoteDialog />);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Defensive: even when targeted explicitly by requestId, EA orders never open the modal
    render(<RequoteDialog requestId={reqId} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('m4: refuses same-frame stale click when Round 2 lands in the store before React re-renders, then shows the new price', async () => {
    const reqId = createMockDealingUuid(0x9a);
    const rq1 = createMockDealingUuid(0x9b);
    const rq2 = createMockDealingUuid(0x9c);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqId,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      digits: 5,
      seq: 2,
      bid: 1.0848,
      ask: 1.08495,
      phase: 'requoted',
      requoteId: rq1,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    const transport = vi.fn<RequoteDecisionTransport>((frame) => {
      const decoded = decodeRequoteActionFrame(frame);
      return encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: WIRE_STATUS_OK,
        orderTicket: 9991,
        fillPrice: decoded.price,
        symbol: 'EURUSD',
        execWire: { retcode: MT_RET_REQUEST_DONE, requestId: reqId, requoteId: decoded.extras.dealingRequoteUuid },
      });
    });

    render(<RequoteDialog sendRequoteFrame={transport} />);
    const staleAcceptBtn = screen.getByRole('button', { name: /Accept @ 1\.08495/ });

    // Round 2 lands in the exact same frame right before the user's click handler reads the store
    await act(async () => {
      ingestDealingEvent({
        requestId: reqId,
        accountLogin: 100042,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1.0,
        digits: 5,
        seq: 3,
        bid: 1.0862,
        ask: 1.0865,
        phase: 'requoted',
        requoteId: rq2,
        expiresAtMs: now + 8_000,
        serverNowMs: now + 100,
      }, now + 100);
      staleAcceptBtn.click();
      await Promise.resolve();
    });

    // Stale Round 1 click MUST NOT send Accept for rq1; dialog re-renders showing Round 2 price
    expect(transport).not.toHaveBeenCalled();
    const round2AcceptBtn = screen.getByRole('button', { name: /Accept @ 1\.08650/ });
    expect(round2AcceptBtn).toBeInTheDocument();

    // Clicking the rendered Round 2 button sends exact rq2 + 1.08650
    await act(async () => {
      round2AcceptBtn.click();
      await Promise.resolve();
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const decoded = decodeRequoteActionFrame(transport.mock.calls[0][0]);
    expect(decoded.extras.dealingRequoteUuid).toBe(rq2);
    expect(decoded.price).toBe(1.0865);
  });

  it('Item 4: rounds excess server price decimals to digits so rendered button price and sent 0x38 price match identically', async () => {
    const reqId = createMockDealingUuid(0xa5);
    const rqId = createMockDealingUuid(0xa6);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqId,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      digits: 5,
      seq: 1,
      bid: 1.0848123,
      ask: 1.0849567,
      phase: 'requoted',
      requoteId: rqId,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    const transport = vi.fn<RequoteDecisionTransport>((frame) => {
      const decoded = decodeRequoteActionFrame(frame);
      return encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: WIRE_STATUS_OK,
        orderTicket: 9995,
        fillPrice: decoded.price,
        symbol: 'EURUSD',
        execWire: { retcode: MT_RET_REQUEST_DONE, requestId: reqId, requoteId: rqId },
      });
    });

    render(<RequoteDialog sendRequoteFrame={transport} />);
    expect(screen.getByTestId('requote-bid')).toHaveTextContent('1.08481');
    expect(screen.getByTestId('requote-ask')).toHaveTextContent('1.08496');

    const acceptBtn = screen.getByRole('button', { name: 'Accept @ 1.08496' });
    await act(async () => {
      acceptBtn.click();
      await Promise.resolve();
    });

    expect(transport).toHaveBeenCalledTimes(1);
    const decoded = decodeRequoteActionFrame(transport.mock.calls[0][0]);
    expect(decoded.price).toBe(1.08496);
    expect(decoded.price.toFixed(5)).toBe('1.08496');
  });
});
