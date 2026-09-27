import { getHomebaseBaseUrl } from '@/services/sync/homebase/config';

export type HomebasePairingErrorCode = 'not-configured' | 'invalid-code' | 'network' | 'server';

export class HomebasePairingError extends Error {
  constructor(
    public code: HomebasePairingErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HomebasePairingError';
  }
}

export const HOMEBASE_DEVICE_LABEL_KEY = 'homebase-device-label';

export function normalizePairingCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export async function pairHomebaseDevice(input: {
  code: string;
  deviceId: string;
  label?: string;
}): Promise<{ token: string; profileId: string }> {
  const baseUrl = getHomebaseBaseUrl();
  if (!baseUrl) throw new HomebasePairingError('not-configured');

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/reader/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingCode: normalizePairingCode(input.code),
        deviceId: input.deviceId,
        ...(input.label ? { label: input.label } : {}),
      }),
    });
  } catch {
    throw new HomebasePairingError('network');
  }

  if (response.status === 401) throw new HomebasePairingError('invalid-code');
  if (!response.ok) throw new HomebasePairingError('server');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HomebasePairingError('server');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('token' in body) ||
    typeof body.token !== 'string' ||
    !('user' in body) ||
    !body.user ||
    typeof body.user !== 'object' ||
    !('id' in body.user) ||
    typeof body.user.id !== 'string'
  ) {
    throw new HomebasePairingError('server');
  }
  if (input.label) localStorage.setItem(HOMEBASE_DEVICE_LABEL_KEY, input.label);
  return { token: body.token, profileId: body.user.id };
}

export interface PairedDevice {
  profileId: string;
  deviceId: string | null;
  label: string | null;
  expiresAt: number | null;
}

export function readPairedDevice(): PairedDevice | null {
  if (typeof localStorage === 'undefined') return null;
  const token = localStorage.getItem('token');
  const rawUser = localStorage.getItem('user');
  if (!token || !rawUser) return null;
  try {
    const user = JSON.parse(rawUser) as { id?: unknown; user_metadata?: { homebase?: unknown } };
    if (user?.user_metadata?.homebase !== true || typeof user.id !== 'string') return null;
    let profileId = user.id;
    let deviceId: string | null = null;
    let expiresAt: number | null = null;
    try {
      const payload = JSON.parse(
        atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')),
      ) as {
        sub?: unknown;
        did?: unknown;
        exp?: unknown;
      };
      if (typeof payload.sub === 'string') profileId = payload.sub;
      if (typeof payload.did === 'string') deviceId = payload.did;
      if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
        expiresAt = payload.exp * 1000;
      }
    } catch {
      // Older or undecodable tokens still have a stored Homebase identity.
    }
    return {
      profileId,
      deviceId,
      label: localStorage.getItem(HOMEBASE_DEVICE_LABEL_KEY),
      expiresAt,
    };
  } catch {
    return null;
  }
}

export function suggestDeviceId(label: string, clientId: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'reader'}-${clientId
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 6)
    .toLowerCase()}`;
}
