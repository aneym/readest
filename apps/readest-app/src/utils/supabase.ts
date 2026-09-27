import { createClient } from '@supabase/supabase-js';
import { getRuntimeConfig } from '@/services/runtimeConfig';
import { isHouseholdBuild } from '@/services/household';

const supabaseUrl =
  getRuntimeConfig()?.supabaseUrl ||
  process.env['SUPABASE_URL'] ||
  process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
  atob(process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_URL_BASE64']!);
const supabaseAnonKey =
  getRuntimeConfig()?.supabaseAnonKey ||
  process.env['SUPABASE_ANON_KEY'] ||
  process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
  atob(process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_KEY_BASE64']!);

// Household devices pair with Homebase and never hold a Supabase session. By
// default the client restores a persisted session on construction and, if it
// has expired, refreshes it over the network, so a household boot would call
// the Supabase host just by importing this module. Nothing is persisted,
// restored or refreshed there instead.
export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey,
  isHouseholdBuild()
    ? { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    : undefined,
);

export const createSupabaseClient = (accessToken?: string) => {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : {},
    },
  });
};

export const createSupabaseAdminClient = () => {
  const supabaseAdminKey = process.env['SUPABASE_ADMIN_KEY'] || '';
  return createClient(supabaseUrl, supabaseAdminKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};
