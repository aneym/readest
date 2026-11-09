import { create } from 'zustand';
import { HomebaseSyncError } from './adapter';
import { recordRejectionKey, rejectionKey, type OutboxEntry } from './outbox';
import type { HomebaseRejection } from './types';

const SUCCESS_KEY = 'readest-homebase-last-successful-sync';
export const PRIVATE_SERVER_UNAVAILABLE =
  'Private server unavailable. Check your connection and Tailscale, then try Sync now. Downloaded books remain available offline.';

export const syncErrorMessage = (error: unknown): string => {
  if (error instanceof HomebaseSyncError && error.code === 'AUTH_FAILED') {
    return 'Homebase no longer accepts this device. Pair it again from the Homebase menu, then try Sync now. Your local books and queued changes are kept.';
  }
  if (error instanceof HomebaseSyncError && error.code === 'NETWORK')
    return PRIVATE_SERVER_UNAVAILABLE;
  return 'Sync failed. Try Sync now again. Your local books and queued changes are kept.';
};

const readSuccess = (): number | null => {
  try {
    const value = Number(globalThis.localStorage?.getItem(SUCCESS_KEY));
    return Number.isFinite(value) && value > 0 && value <= Date.now() ? value : null;
  } catch {
    return null;
  }
};

export const useHomebaseSyncStatus = create<{
  active: number;
  pending: number;
  retrying: number;
  authPaused: number;
  blocked: number;
  poisonedKeys: string[];
  rejectedCount: number;
  rejectedRows: Record<string, string>;
  rejectedReasons: string[];
  lastSuccessAt: number | null;
  error: string | null;
}>(() => ({
  active: 0,
  pending: 0,
  retrying: 0,
  authPaused: 0,
  blocked: 0,
  poisonedKeys: [],
  rejectedCount: 0,
  rejectedRows: {},
  rejectedReasons: [],
  lastSuccessAt: readSuccess(),
  error: null,
}));

const blockedCount = (poisonedKeys: string[], rejectedRows: Record<string, string>): number =>
  new Set([...poisonedKeys, ...Object.keys(rejectedRows)]).size;

export const reportOutboxQueue = (entries: OutboxEntry[]) =>
  useHomebaseSyncStatus.setState((s) => {
    const poisonedKeys = entries
      .filter((e) => e.poisoned)
      .map((e) => recordRejectionKey(e.channel, e.record));
    return {
      pending: entries.filter((e) => !e.poisoned).length,
      retrying: entries.filter(
        (e) => !e.poisoned && e.attempts > 0 && e.lastErrorCode !== 'AUTH_FAILED',
      ).length,
      authPaused: entries.filter((e) => !e.poisoned && e.lastErrorCode === 'AUTH_FAILED').length,
      poisonedKeys,
      blocked: blockedCount(poisonedKeys, s.rejectedRows),
    };
  });

export const reportPushAck = (sentKeys: string[], rejected: HomebaseRejection[] = []) =>
  useHomebaseSyncStatus.setState((s) => {
    const rejectedRows = { ...s.rejectedRows };
    for (const key of sentKeys) delete rejectedRows[key];
    for (const row of rejected) rejectedRows[rejectionKey(row.family, row.id)] = row.reason;
    const rejectedCount = Object.keys(rejectedRows).length;
    return {
      rejectedRows,
      rejectedCount,
      blocked: blockedCount(s.poisonedKeys, rejectedRows),
      rejectedReasons: Object.entries(rejectedRows)
        .slice(-5)
        .map(([key, reason]) => `${key}: ${reason}`),
    };
  });

export const beginSyncRequest = () =>
  useHomebaseSyncStatus.setState((s) => ({ active: s.active + 1 }));
export const endSyncRequest = () =>
  useHomebaseSyncStatus.setState((s) => ({ active: Math.max(0, s.active - 1) }));
export const reportSyncError = (error: unknown) =>
  useHomebaseSyncStatus.setState({ error: syncErrorMessage(error) });
export const reportSyncSuccess = () => {
  const lastSuccessAt = Date.now();
  useHomebaseSyncStatus.setState({ lastSuccessAt });
  try {
    globalThis.localStorage?.setItem(SUCCESS_KEY, String(lastSuccessAt));
  } catch {}
};
