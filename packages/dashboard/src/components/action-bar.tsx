import { useState } from 'preact/hooks';
import type { FetchedPR, ActionRequest } from '../types';

interface ActionBarProps {
  pr: FetchedPR;
  isShelved: boolean;
  onAction: (action: ActionRequest) => Promise<void>;
}

export function ActionBar({ pr, isShelved, onAction }: ActionBarProps) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleAction(action: ActionRequest): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await onAction(action);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  const overrideLabel = pr.status === 'needs_addressing' ? 'Move to Waiting' : 'Move to Need Attention';
  const overrideTarget = pr.status === 'needs_addressing' ? 'waiting' : 'attention';

  return (
    <div class="action-bar">
      {actionError && (
        <p class="action-error" role="alert">
          {actionError}
        </p>
      )}

      <button
        class={`action-btn ${isShelved ? 'action-btn--unshelve' : 'action-btn--shelve'}`}
        disabled={busy}
        onClick={() =>
          handleAction({
            action: 'move',
            url: pr.url,
            target: isShelved ? 'auto' : 'shelved',
          })
        }
      >
        {isShelved ? 'Unshelve' : 'Shelve'}
      </button>

      <button
        class="action-btn action-btn--override"
        disabled={busy}
        onClick={() =>
          handleAction({
            action: 'move',
            url: pr.url,
            target: overrideTarget,
          })
        }
      >
        {overrideLabel}
      </button>
    </div>
  );
}
