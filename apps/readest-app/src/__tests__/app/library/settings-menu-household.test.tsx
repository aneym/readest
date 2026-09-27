import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsMenu from '@/app/library/components/SettingsMenu';

const push = vi.fn();
const close = vi.fn();
const useAuthMock = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isMobileApp: false } }),
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, options?: Record<string, string | number>) =>
    key.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? '')),
}));
vi.mock('@/hooks/useQuotaStats', () => ({
  useQuotaStats: () => ({ userProfilePlan: 'pro', quotas: [] }),
}));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (n: number) => n }));
vi.mock('@/hooks/useTransferQueue', () => ({
  useTransferQueue: () => ({
    stats: { active: 0, pending: 0, failed: 0 },
    hasActiveTransfers: false,
    setIsTransferQueueOpen: vi.fn(),
  }),
}));
vi.mock('@/components/HomebaseSyncMenu', () => ({ default: () => null }));
vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isTauriAppPlatform: () => false,
  isWebAppPlatform: () => false,
}));
vi.mock('@/services/sync/file/runLibrarySync', () => ({ getReadyFileSyncBackends: () => [] }));
vi.mock('@/services/sync/cloudSyncProvider', () => ({
  isReadestCloudEnabled: () => false,
  cloudProvidersDisplayName: () => '',
  settingsKeyForBackend: () => '',
}));
vi.mock('@/store/fileSyncStore', () => ({
  useFileSyncStore: (selector: (state: object) => unknown) =>
    selector({ byKind: {}, lastErrorByKind: {} }),
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: () => ({ isSyncing: false, setLibrary: vi.fn() }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: { alwaysOnTop: false, openLastBooks: false, autoImportBooksOnOpen: false },
    setSettingsDialogOpen: vi.fn(),
  }),
}));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ themeMode: 'light', setThemeMode: vi.fn() }),
}));
vi.mock('@/store/appLockStore', () => ({
  useAppLockStore: () => ({ openDialog: vi.fn() }),
}));

const renderMenu = () => render(<SettingsMenu onPullLibrary={vi.fn()} setIsDropdownOpen={close} />);

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  useAuthMock.mockReset();
  push.mockReset();
  close.mockReset();
});

describe('SettingsMenu account entry', () => {
  it('shows the paired Homebase identity without any Readest account entry', () => {
    vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '1');
    const user = { id: 'profile-1', user_metadata: { homebase: true } };
    const token = `header.${btoa(JSON.stringify({ sub: user.id, did: 'palma2-readest', plan: 'pro' }))}.signature`;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    useAuthMock.mockReturnValue({ user, token });
    renderMenu();

    expect(screen.getByText('Homebase: palma2-readest')).toBeTruthy();
    expect(screen.getByText('Not synced yet')).toBeTruthy();
    expect(screen.queryByText('Sign In')).toBeNull();
    expect(screen.queryByText('Logged in')).toBeNull();
    expect(screen.queryByText('Account')).toBeNull();
    fireEvent.click(screen.getByText('Homebase: palma2-readest'));
    expect(push).toHaveBeenCalledWith('/auth');
    expect(close).toHaveBeenCalledWith(false);
  });

  it('offers pairing to an unpaired household device, not Readest sign-in', () => {
    vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '1');
    useAuthMock.mockReturnValue({ user: null });
    renderMenu();

    expect(screen.queryByText('Sign In')).toBeNull();
    fireEvent.click(screen.getByText('Pair with Homebase'));
    expect(push).toHaveBeenCalledWith('/auth');
  });

  it('keeps the Readest sign-in entry for non-household builds', () => {
    vi.stubEnv('NEXT_PUBLIC_HOUSEHOLD_BUILD', '0');
    useAuthMock.mockReturnValue({ user: null });
    renderMenu();

    expect(screen.getByText('Sign In')).toBeTruthy();
    expect(screen.queryByText('Pair with Homebase')).toBeNull();
  });
});
