'use client';

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import type { RecordSyncClient } from '@/services/sync/homebase/recordSyncClient';
import { resolveRecordSyncClient } from '@/services/sync/homebase';
import { subscribeHomebasePaired } from '@/services/sync/homebase/pairingSignal';

const syncClient = resolveRecordSyncClient();

interface SyncContextType {
  syncClient: RecordSyncClient;
}

const SyncContext = createContext<SyncContextType>({ syncClient });

export const SyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useEffect(() => {
    if (!syncClient.flushOutbox) return;
    let lastFailureAt = -Infinity;
    const drain = (eventTriggered = false) => {
      if (eventTriggered && Date.now() - lastFailureAt < 30_000) return;
      void syncClient.flushOutbox?.().then(
        (result) => {
          if (result?.stoppedBy) lastFailureAt = Date.now();
        },
        () => {
          lastFailureAt = Date.now();
        },
      );
    };
    const onOnline = () => drain(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') drain(true);
    };
    drain();
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribePaired = subscribeHomebasePaired(() => drain());
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribePaired();
    };
  }, []);
  const value = useMemo(() => ({ syncClient }), []);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
};

export const useSyncContext = () => useContext(SyncContext);
