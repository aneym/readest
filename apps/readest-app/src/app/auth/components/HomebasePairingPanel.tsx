'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { handleHomebaseCallback } from '@/helpers/auth';
import { useTranslation } from '@/hooks/useTranslation';
import {
  HOMEBASE_DEVICE_LABEL_KEY,
  HomebasePairingError,
  normalizePairingCode,
  pairHomebaseDevice,
  readPairedDevice,
  suggestDeviceId,
} from '@/services/householdPairing';
import { getHomebaseBaseUrl } from '@/services/sync/homebase/config';
import { getOrCreateHomebaseClientId } from '@/services/sync/homebase/persistence';
import { useHomebaseSyncStatus } from '@/services/sync/homebase/syncStatus';

export default function HomebasePairingPanel() {
  const _ = useTranslation();
  const router = useRouter();
  const { login } = useAuth();
  const baseUrl = getHomebaseBaseUrl();
  const paired = readPairedDevice();
  const lastSuccessAt = useHomebaseSyncStatus((state) => state.lastSuccessAt);
  const [pairAgain, setPairAgain] = useState(false);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState(() =>
    typeof localStorage !== 'undefined'
      ? (localStorage.getItem(HOMEBASE_DEVICE_LABEL_KEY) ?? 'Palma')
      : 'Palma',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const backToLibrary = () => router.push('/library');

  if (!baseUrl) {
    return (
      <main className='bg-base-100 text-base-content mx-auto w-full max-w-lg px-6 py-12'>
        <h1 className='mb-4 text-2xl font-semibold'>{_('Homebase not configured')}</h1>
        <p className='mb-8'>
          {_(
            'This build has no Homebase server set. Rebuild with NEXT_PUBLIC_HOMEBASE_API_BASE_URL.',
          )}
        </p>
        <button className='btn btn-contrast' onClick={backToLibrary}>
          {_('Back to library')}
        </button>
      </main>
    );
  }

  const host = new URL(baseUrl).host;
  const rows = paired && [
    [_('Device'), paired.label ?? paired.deviceId ?? _('Unknown')],
    [_('Device ID'), paired.deviceId ?? _('Unknown')],
    [_('Profile'), paired.profileId],
    [_('Server'), host],
    [_('Last sync'), lastSuccessAt ? new Date(lastSuccessAt).toLocaleString() : _('Not yet')],
    [
      _('Token expires'),
      paired.expiresAt ? new Date(paired.expiresAt).toLocaleString() : _('Unknown'),
    ],
  ];

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const deviceId = paired?.deviceId ?? suggestDeviceId(label, getOrCreateHomebaseClientId());
      const { token } = await pairHomebaseDevice({ code, deviceId, label });
      handleHomebaseCallback({ accessToken: token, login, navigate: router.push });
    } catch (cause) {
      const errorCode = cause instanceof HomebasePairingError ? cause.code : 'server';
      setError(
        errorCode === 'invalid-code'
          ? _('That code is unknown, used or expired. Get a new code.')
          : errorCode === 'network'
            ? _("Can't reach Homebase. Check Tailscale and try again.")
            : _('Homebase rejected the pairing. Try again.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className='bg-base-100 text-base-content mx-auto w-full max-w-lg px-6 py-12'>
      {paired && !pairAgain ? (
        <>
          <h1 className='mb-6 text-2xl font-semibold'>{_('This device is paired')}</h1>
          <dl className='mb-8 space-y-4'>
            {rows &&
              rows.map(([name, value]) => (
                <div key={name} className='border-base-content/20 border-b pb-2'>
                  <dt className='font-semibold'>{name}</dt>
                  <dd className='break-all'>{value}</dd>
                </div>
              ))}
          </dl>
          <div className='flex flex-wrap gap-3'>
            <button className='btn btn-contrast' onClick={backToLibrary}>
              {_('Back to library')}
            </button>
            <button className='btn btn-ghost eink-bordered' onClick={() => setPairAgain(true)}>
              {_('Pair again')}
            </button>
          </div>
        </>
      ) : (
        <>
          <h1 className='mb-4 text-2xl font-semibold'>{_('Pair with Homebase')}</h1>
          <p className='mb-6 break-all'>
            {_('Server')}: {host}
          </p>
          <form onSubmit={submit} className='flex flex-col gap-5'>
            <label className='flex flex-col gap-2'>
              <span>{_('Pairing code')}</span>
              <input
                className='input eink-bordered w-full font-mono tracking-widest'
                value={code}
                onChange={(event) => setCode(normalizePairingCode(event.target.value).slice(0, 8))}
                autoCapitalize='characters'
                autoComplete='off'
                maxLength={8}
                required
              />
            </label>
            <label className='flex flex-col gap-2'>
              <span>{_('Device name')}</span>
              <input
                className='input eink-bordered w-full'
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <p>
              {_(
                'Get a code on the Homebase server: bun scripts/reader-pair.ts --label <device name>. Codes last 10 minutes.',
              )}
            </p>
            {error && (
              <p role='alert' className='text-error'>
                {error}
              </p>
            )}
            <button className='btn btn-contrast' type='submit' disabled={busy || code.length !== 8}>
              {_('Pair')}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
