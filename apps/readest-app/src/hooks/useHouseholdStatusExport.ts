import { useEffect, useRef, useState } from 'react';
import { isHouseholdBuild } from '@/services/household';
import { readPairedDevice } from '@/services/householdPairing';
import { useHomebaseSyncStatus } from '@/services/sync/homebase/syncStatus';

declare global {
  interface Window {
    HomebaseHousehold?: { setSyncStatus(json: string): void };
  }
}

/** Publish only aggregate status; never send identity, credentials, or book metadata. */
export function useHouseholdStatusExport(): void {
  const { active, pending, error, lastSuccessAt } = useHomebaseSyncStatus();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [identityVersion, setIdentityVersion] = useState(0);
  const lastValue = useRef<string | null>(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const refreshIdentity = () => setIdentityVersion((version) => version + 1);
    window.addEventListener('storage', refreshIdentity);
    window.addEventListener('focus', refreshIdentity);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener('storage', refreshIdentity);
      window.removeEventListener('focus', refreshIdentity);
    };
  }, []);

  useEffect(() => {
    if (!isHouseholdBuild() || !window.HomebaseHousehold) return;

    const publish = () => {
      try {
        const state = !readPairedDevice()
          ? 'unpaired'
          : !online
            ? 'offline'
            : error
              ? 'error'
              : active > 0
                ? 'syncing'
                : 'idle';
        const value = { pending, last_sync_at: lastSuccessAt ?? 0, state };
        const key = JSON.stringify(value);
        if (key === lastValue.current) return;
        window.HomebaseHousehold?.setSyncStatus(
          JSON.stringify({ ...value, updated_at: Date.now() }),
        );
        lastValue.current = key;
      } catch {
        // A missing/tearing-down native bridge or unavailable storage must not affect reading.
      }
    };

    const timer = window.setTimeout(publish, 1000);
    return () => window.clearTimeout(timer);
  }, [active, pending, error, lastSuccessAt, online, identityVersion]);
}
