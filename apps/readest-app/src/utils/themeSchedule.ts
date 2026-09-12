import type { ThemeMode } from '@/styles/themes';

/**
 * Scheduled Mode: the page theme follows a fixed daily clock instead of the
 * OS appearance. Times are wall-clock "HH:MM" in the device's local timezone,
 * so travel and DST are handled by the OS clock with no location permission.
 */
export interface ThemeSchedule {
  /** Local time at which the dark palette starts, "HH:MM". */
  darkStart: string;
  /** Local time at which the light palette starts, "HH:MM". */
  lightStart: string;
}

export const DEFAULT_THEME_SCHEDULE: ThemeSchedule = { darkStart: '21:00', lightStart: '05:00' };

export const THEME_SCHEDULE_STORAGE_KEY = 'themeSchedule';

/** Set once the schedule default has been applied to an existing install. */
export const THEME_SCHEDULE_DEFAULT_APPLIED_KEY = 'themeScheduleDefaultApplied';

/** Poll interval for the schedule clock while the app is visible. */
export const THEME_SCHEDULE_TICK_MS = 30_000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidScheduleTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** "HH:MM" → minutes since local midnight. */
export function scheduleTimeToMinutes(time: string): number {
  const match = TIME_RE.exec(time);
  if (!match) throw new Error(`invalid schedule time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether `now` (local wall clock) falls inside the dark window.
 *
 * The window runs from darkStart up to (not including) lightStart and may
 * wrap past midnight (21:00 → 05:00). Equal times mean an always-light
 * schedule, so a misconfiguration can never lock the reader in dark.
 */
export function resolveScheduleIsDarkMode(now: Date, schedule: ThemeSchedule): boolean {
  const dark = scheduleTimeToMinutes(schedule.darkStart);
  const light = scheduleTimeToMinutes(schedule.lightStart);
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (dark === light) return false;
  if (dark < light) return minutes >= dark && minutes < light;
  return minutes >= dark || minutes < light;
}

export function normalizeThemeSchedule(value: unknown): ThemeSchedule {
  if (value && typeof value === 'object') {
    const { darkStart, lightStart } = value as Partial<ThemeSchedule>;
    return {
      darkStart: isValidScheduleTime(darkStart) ? darkStart : DEFAULT_THEME_SCHEDULE.darkStart,
      lightStart: isValidScheduleTime(lightStart) ? lightStart : DEFAULT_THEME_SCHEDULE.lightStart,
    };
  }
  return { ...DEFAULT_THEME_SCHEDULE };
}

export function parseStoredThemeSchedule(stored: string | null): ThemeSchedule {
  if (!stored) return { ...DEFAULT_THEME_SCHEDULE };
  try {
    return normalizeThemeSchedule(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_THEME_SCHEDULE };
  }
}

export function readStoredThemeSchedule(): ThemeSchedule {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_THEME_SCHEDULE };
  }
  return parseStoredThemeSchedule(localStorage.getItem(THEME_SCHEDULE_STORAGE_KEY));
}

export function persistThemeSchedule(schedule: ThemeSchedule) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  localStorage.setItem(THEME_SCHEDULE_STORAGE_KEY, JSON.stringify(schedule));
}

/**
 * Current dark flag for Scheduled Mode from persisted settings and the
 * device clock. Used wherever the theme is resolved synchronously (theme
 * store init, early data-theme paint, `getThemeCode`).
 */
export function readScheduleIsDarkMode(now: Date = new Date()): boolean {
  return resolveScheduleIsDarkMode(now, readStoredThemeSchedule());
}

/**
 * Persisted theme mode with Scheduled Mode as the household default.
 *
 * Fresh installs get 'schedule'. An existing install is moved to 'schedule'
 * exactly once (marked by THEME_SCHEDULE_DEFAULT_APPLIED_KEY); any mode the
 * user picks afterwards is kept.
 */
export function readThemeModeWithScheduleDefault(
  isValid: (value: string | null) => value is ThemeMode,
): ThemeMode {
  if (typeof window === 'undefined' || !window.localStorage) return 'schedule';
  const applied = localStorage.getItem(THEME_SCHEDULE_DEFAULT_APPLIED_KEY) === 'true';
  if (!applied) {
    localStorage.setItem(THEME_SCHEDULE_DEFAULT_APPLIED_KEY, 'true');
    localStorage.setItem('themeMode', 'schedule');
    return 'schedule';
  }
  const stored = localStorage.getItem('themeMode');
  return isValid(stored) ? stored : 'schedule';
}
