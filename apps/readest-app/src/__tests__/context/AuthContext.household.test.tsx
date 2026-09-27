import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  onAuthStateChange: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('@/utils/supabase', () => ({ supabase: { auth } }));

import { AuthProvider, useAuth } from '@/context/AuthContext';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '1');
  localStorage.clear();
  Object.values(auth).forEach((method) => method.mockClear());
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it('restores a production Homebase session without contacting Supabase', async () => {
  const token = 'homebase.jwt.token';
  const user = {
    id: 'alex',
    aud: 'readest-sync',
    app_metadata: {},
    user_metadata: { homebase: true },
    created_at: '2026-01-01T00:00:00Z',
  };
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));

  function Session() {
    const session = useAuth();
    return <output>{JSON.stringify({ token: session.token, user: session.user })}</output>;
  }
  render(
    <AuthProvider>
      <Session />
    </AuthProvider>,
  );

  await waitFor(() => {
    expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toEqual({ token, user });
  });
  expect(auth.onAuthStateChange).not.toHaveBeenCalled();
  expect(auth.refreshSession).not.toHaveBeenCalled();
  expect(auth.signOut).not.toHaveBeenCalled();
  expect(localStorage.getItem('token')).toBe(token);
  expect(localStorage.getItem('user')).toBe(JSON.stringify(user));
});
