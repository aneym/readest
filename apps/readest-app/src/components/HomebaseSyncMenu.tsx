import { useState } from 'react';
import { useSyncContext } from '@/context/SyncContext';
import { useHomebaseSyncStatus, reportSyncError } from '@/services/sync/homebase/syncStatus';
import { isHomebaseSyncEnabled } from '@/services/sync/homebase/config';
import { useTranslation } from '@/hooks/useTranslation';

/** Shared library/reader menu: request receipts, not data-change cursors. */
export default function HomebaseSyncMenu({ onSync }: { onSync: () => void | Promise<unknown> }) {
  const _ = useTranslation();
  const { syncClient } = useSyncContext();
  const status = useHomebaseSyncStatus();
  const [manual, setManual] = useState(false);
  if (!isHomebaseSyncEnabled()) return null;
  const running = manual || status.active > 0;
  const syncNow = async () => {
    if (running) return;
    setManual(true);
    useHomebaseSyncStatus.setState({ error: null });
    try {
      const flushed = await syncClient.flushOutbox?.();
      if (flushed?.stoppedBy) return;
      await onSync();
    } catch (error) {
      reportSyncError(error);
    } finally {
      setManual(false);
    }
  };
  return (
    <div
      className='eink-bordered border-base-300 my-1 rounded-md border p-3 text-sm'
      aria-label={_('Homebase sync')}
    >
      <button
        role='menuitem'
        className='btn btn-contrast w-full'
        disabled={running}
        onClick={() => void syncNow()}
      >
        {running ? _('Syncing…') : _('Sync now')}
      </button>
      <div
        role='status'
        aria-live='polite'
        className='mt-2 space-y-1 whitespace-normal break-words'
      >
        <p>
          {running
            ? _('Sync running')
            : status.error
              ? _('Sync needs attention')
              : status.pending
                ? _('Changes waiting to sync')
                : _('Sync idle')}
        </p>
        <p>{_('{{count}} pending changes', { count: status.pending })}</p>
        {status.retrying > 0 && (
          <p>{_('{{count}} changes retrying', { count: status.retrying })}</p>
        )}
        {status.authPaused > 0 && (
          <p>{_('{{count}} changes paused until sign-in', { count: status.authPaused })}</p>
        )}
        {status.blocked > 0 && (
          <p>{_('{{count}} blocked changes retained on this device', { count: status.blocked })}</p>
        )}
        <p>
          {status.lastSuccessAt
            ? _('Last successful server sync: {{time}}', {
                time: new Date(status.lastSuccessAt).toLocaleString(),
              })
            : _('Last successful server sync: not yet recorded')}
        </p>
        {status.error && <p role='alert'>{_(status.error)}</p>}
        {status.blocked > 0 && (
          <p>{_('Some changes were rejected. Contact support before clearing any data.')}</p>
        )}
        {status.rejectedReasons.map((reason, index) => (
          <p key={`${index}:${reason}`}>{reason}</p>
        ))}
      </div>
    </div>
  );
}
