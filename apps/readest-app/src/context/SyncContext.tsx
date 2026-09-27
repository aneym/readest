'use client';

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import type { RecordSyncClient } from '@/services/sync/homebase/recordSyncClient';
import { resolveRecordSyncClient } from '@/services/sync/homebase';

const syncClient = resolveRecordSyncClient();

interface SyncContextType {
  syncClient: RecordSyncClient;
}

const SyncContext = createContext<SyncContextType>({ syncClient });

export const SyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useEffect(() => {
    if (!syncClient.flushOutbox) return;
    const drain = () => void syncClient.flushOutbox?.().catch(() => undefined);
    const onVisible = () => {
      if (document.visibilityState === 'visible') drain();
    };
    drain();
    window.addEventListener('online', drain);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', drain);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  const value = useMemo(() => ({ syncClient }), []);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
};

export const useSyncContext = () => useContext(SyncContext);
