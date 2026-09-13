'use client';

import React, { createContext, useContext, useMemo } from 'react';
import type { RecordSyncClient } from '@/services/sync/homebase/recordSyncClient';
import { resolveRecordSyncClient } from '@/services/sync/homebase';

const syncClient = resolveRecordSyncClient();

interface SyncContextType {
  syncClient: RecordSyncClient;
}

const SyncContext = createContext<SyncContextType>({ syncClient });

export const SyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = useMemo(() => ({ syncClient }), []);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
};

export const useSyncContext = () => useContext(SyncContext);
