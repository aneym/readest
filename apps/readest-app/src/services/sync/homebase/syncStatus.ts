import { create } from 'zustand';
import { HomebaseSyncError } from './adapter';

const SUCCESS_KEY = 'readest-homebase-last-successful-sync';
export const PRIVATE_SERVER_UNAVAILABLE =
  'Private server unavailable. Check your connection and Tailscale, then try Sync now. Downloaded books remain available offline.';

export const syncErrorMessage = (error: unknown): string => {
  if (error instanceof HomebaseSyncError && error.code === 'AUTH_FAILED') {
    return 'Sync authorization failed. Sign in again, then try Sync now. Your local books and queued changes are kept.';
  }
  if (error instanceof HomebaseSyncError && error.code === 'NETWORK')
    return PRIVATE_SERVER_UNAVAILABLE;
  // Do not surface server bodies, signed URLs, or credentials in the menu.
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
  rejectedCount: 0,
  rejectedRows: {},
  rejectedReasons: [],
  lastSuccessAt: readSuccess(),
  error: null,
}));

export const reportPushAck = (
  sent: { family: string; id: string }[],
  rejected: { family: string; id: string; reason: string }[] = [],
) =>
  useHomebaseSyncStatus.setState((s) => {
    const rejectedRows = { ...s.rejectedRows };
    const rejectedKeys = new Set(rejected.map((row) => `${row.family}/${row.id}`));
    for (const row of sent) {
      const key = `${row.family}/${row.id}`;
      if (!rejectedKeys.has(key)) delete rejectedRows[key];
    }
    for (const row of rejected) rejectedRows[`${row.family}/${row.id}`] = row.reason;
    const rejectedCount = Object.keys(rejectedRows).length;
    return {
      rejectedRows,
      rejectedCount,
      blocked: s.blocked - s.rejectedCount + rejectedCount,
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
  } catch {
    /* Reading must survive unavailable storage. */
  }
};
