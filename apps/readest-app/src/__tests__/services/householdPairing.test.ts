import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HomebasePairingError,
  pairHomebaseDevice,
  readPairedDevice,
} from '@/services/householdPairing';

const token = `header.${btoa(JSON.stringify({ sub: 'alex', did: 'palma2-readest', exp: 1800000000 }))}.signature`;
const user = {
  id: 'alex',
  aud: 'readest-sync',
  app_metadata: {},
  user_metadata: { homebase: true },
  created_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_HOMEBASE_API_BASE_URL', 'https://reader.homebase.example');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Homebase pairing', () => {
  it('posts a normalized pairing code and persists the device label', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token, user: { id: 'alex' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pairHomebaseDevice({ code: 'ab-cd efgh', deviceId: 'palma2-readest', label: 'Palma 2' }),
    ).resolves.toEqual({ token, profileId: 'alex' });
    expect(fetchMock).toHaveBeenCalledWith('https://reader.homebase.example/reader/auth/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingCode: 'ABCDEFGH',
        deviceId: 'palma2-readest',
        label: 'Palma 2',
      }),
    });
    expect(localStorage.getItem('homebase-device-label')).toBe('Palma 2');
  });

  it('distinguishes an invalid code from a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false }));
    await expect(
      pairHomebaseDevice({ code: 'ABCDEFGH', deviceId: 'palma2-readest' }),
    ).rejects.toMatchObject({ code: 'invalid-code' } satisfies Partial<HomebasePairingError>);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(
      pairHomebaseDevice({ code: 'ABCDEFGH', deviceId: 'palma2-readest' }),
    ).rejects.toMatchObject({ code: 'network' } satisfies Partial<HomebasePairingError>);
  });

  it('reads the production Homebase identity and rejects non-Homebase users', () => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    expect(readPairedDevice()).toEqual({
      profileId: 'alex',
      deviceId: 'palma2-readest',
      label: null,
      expiresAt: 1800000000 * 1000,
    });

    localStorage.setItem('user', JSON.stringify({ ...user, user_metadata: {} }));
    expect(readPairedDevice()).toBeNull();
  });
});
