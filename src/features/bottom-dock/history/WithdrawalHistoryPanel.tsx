import { useUiTranslation } from '../../../hooks/useUiTranslation';
import type { HistoryBalanceOperation } from './balanceHistory';

type WithdrawalHistoryPanelProps = {
  withdrawals: readonly HistoryBalanceOperation[];
  loading: boolean;
  error: string | null;
  accountBalance: number | null;
  autoArrange: boolean;
  showGrid: boolean;
  showMilliseconds: boolean;
  formatMoney: (value: number | undefined | null) => string;
  onRetry: () => void;
};

const formatWithdrawalTimestamp = (timeMs: number | null, showMilliseconds: boolean): string => {
  if (timeMs === null || !Number.isFinite(timeMs)) return '—';
  const date = new Date(timeMs);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  const ms = showMilliseconds ? `.${pad(date.getMilliseconds(), 3)}` : '';
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${ms}`;
};

const formatWithdrawalStatus = (status?: string): { label: string; toneClass: string } => {
  const normalized = (status ?? 'completed').trim().toLowerCase();
  if (normalized === 'rejected' || normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled') {
    return {
      label: normalized.charAt(0).toUpperCase() + normalized.slice(1),
      toneClass: 'text-loss',
    };
  }
  if (normalized === 'pending' || normalized === 'processing' || normalized === 'requested' || normalized === 'queued') {
    return {
      label: normalized.charAt(0).toUpperCase() + normalized.slice(1),
      toneClass: 'text-amber-300',
    };
  }
  return {
    label: normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Completed',
    toneClass: 'text-profit',
  };
};

export function WithdrawalHistoryPanel({
  withdrawals,
  loading,
  error,
  accountBalance,
  autoArrange,
  showGrid,
  showMilliseconds,
  formatMoney,
  onRetry,
}: WithdrawalHistoryPanelProps) {
  const tr = useUiTranslation();

  const totalWithdrawal = withdrawals.reduce((sum, op) => sum + op.amount, 0);
  const formatSummaryMoney = (value: number | null) => (
    value === null || !Number.isFinite(value) ? '—' : formatMoney(value)
  );
  const rowDividerClass = 'divide-y divide-zinc-800/90';

  return (
    <>
      {error && withdrawals.length > 0 && (
        <div
          role="status"
          className="rtx-history-status-warning shrink-0 border-b border-amber-700/50 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-300"
        >
          {tr('Partial withdrawal history')}: {error}
        </div>
      )}

      <div
        className="rtx-trade-scroll flex-1 overflow-auto scrollbar-thin scrollbar-thumb-zinc-700"
        aria-label={tr('Withdrawal history records')}
      >
        <table
          className="rtx-trade-table rtx-history-table rtx-withdrawal-history-table w-full text-center border-collapse"
          aria-rowcount={withdrawals.length + 1}
          data-auto-arrange={autoArrange ? 'true' : 'false'}
          data-grid={showGrid ? 'true' : 'false'}
          style={{
            fontFamily: '"Segoe UI", Tahoma, Arial, sans-serif',
            fontVariantNumeric: 'tabular-nums',
            tableLayout: 'fixed',
          }}
        >
          <colgroup>
            {Array.from({ length: 7 }, (_, columnIndex) => (
              <col key={columnIndex} style={{ width: `${100 / 7}%` }} />
            ))}
          </colgroup>
          <thead className="rtx-trade-table__head sticky top-0 bg-[#17181c] text-[#c9cfdb] z-10 font-normal text-[12px] leading-[18px] uppercase border-y border-zinc-700/70 select-none shadow-[0_1px_0_0_rgba(255,255,255,0.04)]">
            <tr className="h-[30px]">
              <th className="px-1.5 py-[3px] text-center">{tr('Time')}</th>
              <th className="px-1.5 py-[3px] text-center">{tr('ID')}</th>
              <th className="px-1.5 py-[3px] text-center">{tr('Type')}</th>
              <th className="px-1.5 py-[3px] text-center">{tr('Method / Comment')}</th>
              <th className="px-1.5 py-[3px] text-center">{tr('Status')}</th>
              <th className="px-1.5 py-[3px] text-center">{tr('Amount')}</th>
              <th className="px-1.5 py-[3px] text-center">{tr('Balance')}</th>
            </tr>
          </thead>
          <tbody className={rowDividerClass}>
            {loading && withdrawals.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-8 text-zinc-400">
                  {tr('Loading withdrawal history...')}
                </td>
              </tr>
            ) : error && withdrawals.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-8 text-zinc-400">
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-loss">{error}</span>
                    <button
                      type="button"
                      onClick={onRetry}
                      className="rounded-sm border border-zinc-600 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
                    >
                      {tr('Retry')}
                    </button>
                  </div>
                </td>
              </tr>
            ) : withdrawals.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-8 text-zinc-400">
                  {tr('No withdrawal history for the selected period')}
                </td>
              </tr>
            ) : (
              withdrawals.map((op, index) => {
                const timeLabel = formatWithdrawalTimestamp(op.time, showMilliseconds);
                const statusInfo = formatWithdrawalStatus(op.status);
                const amountLabel = formatMoney(op.amount);
                const amountWithCurrency = op.currency ? `${amountLabel} ${op.currency}` : amountLabel;
                const balanceLabel = op.balanceAfter !== undefined && Number.isFinite(op.balanceAfter)
                  ? formatMoney(op.balanceAfter)
                  : '—';
                const note = op.method && op.comment && op.method !== op.comment
                  ? `${op.method} — ${op.comment}`
                  : (op.method || op.comment || '—');

                return (
                  <tr
                    key={`${op.id}-${op.time ?? 'na'}`}
                    aria-rowindex={index + 2}
                    className="rtx-trade-row h-[23px] text-[12px] leading-[18px] transition-colors cursor-default hover:bg-zinc-800/50"
                  >
                    <td
                      className="px-1.5 py-[2px] text-center text-zinc-100 whitespace-nowrap"
                      title={tr('Time: {{value0}}', { value0: timeLabel })}
                    >
                      {timeLabel}
                    </td>
                    <td
                      className="px-1.5 py-[2px] text-center text-zinc-100 tabular-nums"
                      title={tr('ID: {{value0}}', { value0: op.id })}
                    >
                      {op.id}
                    </td>
                    <td className="px-1.5 py-[2px] text-center">
                      <span className="text-loss font-normal">{tr('Withdrawal')}</span>
                    </td>
                    <td
                      className="px-1.5 py-[2px] text-center text-zinc-100 truncate"
                      title={note}
                    >
                      {note}
                    </td>
                    <td className={`px-1.5 py-[2px] text-center font-normal ${statusInfo.toneClass}`}>
                      {tr(statusInfo.label)}
                    </td>
                    <td
                      className="px-1.5 py-[2px] text-center font-normal tabular-nums text-loss"
                      title={tr('Amount: {{value0}}', { value0: amountWithCurrency })}
                    >
                      {amountWithCurrency}
                    </td>
                    <td
                      className="px-1.5 py-[2px] text-center text-zinc-100 tabular-nums"
                      title={tr('Balance: {{value0}}', { value0: balanceLabel })}
                    >
                      {balanceLabel}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="rtx-withdrawal-summary-bar shrink-0 z-10">
        <table
          className="rtx-trade-table rtx-history-table w-full text-center border-collapse"
          style={{
            fontFamily: '"Segoe UI", Tahoma, Arial, sans-serif',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <tfoot className="rtx-history-table__foot">
            <tr className="rtx-history-summary-row">
              <td>
                <div role="group" aria-label={tr('Withdrawal history summary')} className="rtx-history-summary-values">
                  <span className="rtx-history-summary-status" aria-hidden="true">
                    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <circle cx="6" cy="6" r="4.5" stroke="currentColor" />
                      <path d="M3.5 6h5" stroke="currentColor" />
                    </svg>
                  </span>
                  <span className="rtx-history-summary-metric">
                    {tr('Withdrawals')}: {withdrawals.length}{' '}
                  </span>
                  <span className="rtx-history-summary-metric">
                    {tr('Withdrawal')}: {error && withdrawals.length === 0 ? '—' : formatMoney(totalWithdrawal)}{' '}
                  </span>
                  <span className="rtx-history-summary-metric">
                    {tr('Balance')}: {formatSummaryMoney(accountBalance)}{' '}
                  </span>
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
