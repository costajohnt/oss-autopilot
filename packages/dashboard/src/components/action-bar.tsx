import { useState } from 'preact/hooks';
import type { FetchedPR, ActionRequest } from '../types';

interface ActionBarProps {
  pr: FetchedPR;
  isShelved: boolean;
  onAction: (action: ActionRequest) => Promise<void>;
}

export function ActionBar({ pr, isShelved, onAction }: ActionBarProps) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeReason, setSnoozeReason] = useState('');
  const [snoozeDays, setSnoozeDays] = useState(1);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleAction(action: ActionRequest): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      await onAction(action);
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="action-bar">
      {actionError && <p class="action-error">{actionError}</p>}

      <button
        class={`action-btn ${isShelved ? 'action-btn--unshelve' : 'action-btn--shelve'}`}
        disabled={busy}
        onClick={() =>
          handleAction({
            action: isShelved ? 'unshelve' : 'shelve',
            url: pr.url,
          })
        }
      >
        {isShelved ? 'Unshelve' : 'Shelve'}
      </button>

      {pr.ciStatus === 'failing' && (
        <>
          <button
            class="action-btn action-btn--snooze"
            disabled={busy}
            onClick={() => setSnoozeOpen(!snoozeOpen)}
          >
            Snooze CI
          </button>
          <button
            class="action-btn action-btn--unsnooze"
            disabled={busy}
            onClick={() =>
              handleAction({
                action: 'unsnooze',
                url: pr.url,
              })
            }
          >
            Unsnooze
          </button>
        </>
      )}

      {snoozeOpen && (
        <div class="snooze-form">
          <input
            class="snooze-input"
            type="text"
            placeholder="Reason (optional)"
            value={snoozeReason}
            onInput={(e) => setSnoozeReason((e.target as HTMLInputElement).value)}
          />
          <label class="snooze-label">
            Days:
            <input
              class="snooze-input snooze-input--days"
              type="number"
              min={1}
              max={30}
              value={snoozeDays}
              onInput={(e) =>
                setSnoozeDays(Math.max(1, parseInt((e.target as HTMLInputElement).value, 10) || 1))
              }
            />
          </label>
          <button
            class="action-btn action-btn--confirm"
            disabled={busy}
            onClick={async () => {
              const ok = await handleAction({
                action: 'snooze',
                url: pr.url,
                reason: snoozeReason || undefined,
                days: snoozeDays,
              });
              if (ok) {
                setSnoozeOpen(false);
                setSnoozeReason('');
                setSnoozeDays(1);
              }
            }}
          >
            Confirm Snooze
          </button>
        </div>
      )}
    </div>
  );
}
