'use client';

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import type { RecordSyncClient } from '@/services/sync/homebase/recordSyncClient';
import { resolveRecordSyncClient } from '@/services/sync/homebase/resolveRecordSyncClient';
import { subscribeHomebasePaired } from '@/services/sync/homebase/pairingSignal';
import { useHomebaseSyncStatus } from '@/services/sync/homebase/syncStatus';

const syncClient = resolveRecordSyncClient();

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

const retryDelayMs = (failures: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(0, failures - 1), 10));

interface SyncContextType {
  syncClient: RecordSyncClient;
}

const SyncContext = createContext<SyncContextType>({ syncClient });

export const SyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useEffect(() => {
    if (!syncClient.flushOutbox) return;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let draining = false;
    let stopped = false;
    const schedule = () => {
      if (stopped || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        drain();
      }, retryDelayMs(failures));
    };
    const settle = (failed: boolean) => {
      draining = false;
      const waiting = failed || useHomebaseSyncStatus.getState().pending > 0;
      failures = waiting ? failures + 1 : 0;
      if (waiting) schedule();
    };
    const drain = (options?: { resendBlocked?: boolean }) => {
      if (stopped) return;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      draining = true;
      void syncClient.flushOutbox?.(options).then(
        (result) => settle(Boolean(result?.stoppedBy)),
        () => settle(true),
      );
    };
    const onOnline = () => drain();
    const onVisible = () => {
      if (document.visibilityState === 'visible') drain();
    };
    drain({ resendBlocked: true });
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribePaired = subscribeHomebasePaired(() => drain());
    const unsubscribeQueue = useHomebaseSyncStatus.subscribe((state, previous) => {
      if (!draining && state.pending > 0 && state.pending !== previous.pending) schedule();
    });
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribePaired();
      unsubscribeQueue();
    };
  }, []);
  const value = useMemo(() => ({ syncClient }), []);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
};

export const useSyncContext = () => useContext(SyncContext);
