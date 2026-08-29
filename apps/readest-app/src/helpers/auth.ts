import { User } from '@supabase/supabase-js';
import { supabase } from '@/utils/supabase';

interface UseAuthCallbackOptions {
  accessToken?: string | null;
  refreshToken?: string | null;
  login: (accessToken: string, user: User) => void;
  navigate: (path: string) => void;
  type?: string | null;
  next?: string;
  error?: string | null;
  errorCode?: string | null;
  errorDescription?: string | null;
}

export interface OAuthCallbackParams {
  accessToken: string | null;
  refreshToken: string | null;
  type: string | null;
  next: string | null;
  error: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

// OAuth callbacks may carry data in the URL fragment (implicit flow tokens) or
// the query string (provider/GoTrue errors), so we read from both.
export function parseOAuthCallbackUrl(url: string): OAuthCallbackParams {
  const hashParams = new URLSearchParams(url.match(/#(.*)/)?.[1] ?? '');
  const queryParams = new URLSearchParams(url.match(/\?([^#]*)/)?.[1] ?? '');
  const getParam = (key: string) => hashParams.get(key) ?? queryParams.get(key);
  return {
    accessToken: getParam('access_token'),
    refreshToken: getParam('refresh_token'),
    type: getParam('type'),
    next: getParam('next'),
    error: getParam('error'),
    errorCode: getParam('error_code'),
    errorDescription: getParam('error_description'),
  };
}

/**
 * Homebase device pairing: the token is a Homebase-issued JWT, not a Supabase
 * session, so Supabase must not validate it. Build the minimal user identity
 * from the JWT payload (sub = Homebase profile id) and log in directly —
 * login() persists localStorage 'token'/'user', which getAccessToken() and the
 * Homebase sync adapter read.
 */
export function handleHomebaseCallback({
  accessToken,
  login,
  navigate,
}: Pick<UseAuthCallbackOptions, 'accessToken' | 'login' | 'navigate'>) {
  if (!accessToken) {
    navigate('/auth/error');
    return;
  }
  try {
    const payloadPart = accessToken.split('.')[1] ?? '';
    const payload = JSON.parse(atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: string;
    };
    if (!payload.sub) throw new Error('homebase token payload has no sub');
    const now = new Date().toISOString();
    const user = {
      id: payload.sub,
      aud: 'readest-sync',
      app_metadata: {},
      user_metadata: { homebase: true },
      created_at: now,
    } as User;
    login(accessToken, user);
    navigate('/library');
  } catch (err) {
    console.error('Homebase pairing token rejected:', err);
    navigate('/auth/error');
  }
}

export function handleAuthCallback({
  accessToken,
  refreshToken,
  login,
  navigate,
  type,
  next = '/',
  error,
}: UseAuthCallbackOptions) {
  async function finalizeSession() {
    if (error) {
      navigate('/auth/error');
      return;
    }

    if (!accessToken || !refreshToken) {
      navigate('/library');
      return;
    }

    const { error: err } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (err) {
      console.error('Error setting session:', err);
      navigate('/auth/error');
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      login(accessToken, user);
      if (type === 'recovery') {
        navigate('/auth/recovery');
        return;
      }
      navigate(next);
    } else {
      console.error('Error fetching user data');
      navigate('/auth/error');
    }
  }

  finalizeSession();
}
