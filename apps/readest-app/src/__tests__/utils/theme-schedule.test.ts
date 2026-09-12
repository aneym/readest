import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_SCHEDULE,
  THEME_SCHEDULE_DEFAULT_APPLIED_KEY,
  THEME_SCHEDULE_STORAGE_KEY,
  isValidScheduleTime,
  normalizeThemeSchedule,
  parseStoredThemeSchedule,
  readScheduleIsDarkMode,
  readThemeModeWithScheduleDefault,
  resolveScheduleIsDarkMode,
  scheduleTimeToMinutes,
} from '@/utils/themeSchedule';
import { isValidThemeMode } from '@/utils/ambientLight';

// Local wall-clock Date; the schedule must ignore the timezone and read the
// device's own hours and minutes.
const at = (hh: number, mm: number) => new Date(2026, 8, 12, hh, mm, 0, 0);

describe('resolveScheduleIsDarkMode', () => {
  const schedule = DEFAULT_THEME_SCHEDULE; // 21:00 → 05:00

  it('is dark inside the overnight window and light outside it', () => {
    expect(resolveScheduleIsDarkMode(at(21, 0), schedule)).toBe(true);
    expect(resolveScheduleIsDarkMode(at(23, 59), schedule)).toBe(true);
    expect(resolveScheduleIsDarkMode(at(0, 0), schedule)).toBe(true);
    expect(resolveScheduleIsDarkMode(at(4, 59), schedule)).toBe(true);
    expect(resolveScheduleIsDarkMode(at(5, 0), schedule)).toBe(false);
    expect(resolveScheduleIsDarkMode(at(12, 0), schedule)).toBe(false);
    expect(resolveScheduleIsDarkMode(at(20, 59), schedule)).toBe(false);
  });

  it('supports a same-day window', () => {
    const daytime = { darkStart: '09:00', lightStart: '17:00' };
    expect(resolveScheduleIsDarkMode(at(8, 59), daytime)).toBe(false);
    expect(resolveScheduleIsDarkMode(at(9, 0), daytime)).toBe(true);
    expect(resolveScheduleIsDarkMode(at(16, 59), daytime)).toBe(true);
    expect(resolveScheduleIsDarkMode(at(17, 0), daytime)).toBe(false);
  });

  it('never locks dark when both times are equal', () => {
    const same = { darkStart: '12:00', lightStart: '12:00' };
    expect(resolveScheduleIsDarkMode(at(12, 0), same)).toBe(false);
    expect(resolveScheduleIsDarkMode(at(3, 0), same)).toBe(false);
  });
});

describe('schedule time parsing', () => {
  it('validates HH:MM', () => {
    expect(isValidScheduleTime('05:00')).toBe(true);
    expect(isValidScheduleTime('23:59')).toBe(true);
    expect(isValidScheduleTime('24:00')).toBe(false);
    expect(isValidScheduleTime('5:00')).toBe(false);
    expect(isValidScheduleTime('')).toBe(false);
    expect(isValidScheduleTime(null)).toBe(false);
    expect(scheduleTimeToMinutes('21:30')).toBe(1290);
  });

  it('normalizes bad fields back to the defaults per field', () => {
    expect(normalizeThemeSchedule({ darkStart: '22:15', lightStart: 'nope' })).toEqual({
      darkStart: '22:15',
      lightStart: DEFAULT_THEME_SCHEDULE.lightStart,
    });
    expect(normalizeThemeSchedule(null)).toEqual(DEFAULT_THEME_SCHEDULE);
    expect(parseStoredThemeSchedule('{not json')).toEqual(DEFAULT_THEME_SCHEDULE);
    expect(parseStoredThemeSchedule(null)).toEqual(DEFAULT_THEME_SCHEDULE);
  });
});

describe('persisted defaults', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('reads the stored schedule for the synchronous dark flag', () => {
    localStorage.setItem(
      THEME_SCHEDULE_STORAGE_KEY,
      JSON.stringify({ darkStart: '09:00', lightStart: '17:00' }),
    );
    expect(readScheduleIsDarkMode(at(10, 0))).toBe(true);
    expect(readScheduleIsDarkMode(at(18, 0))).toBe(false);
  });

  it('defaults a fresh install to scheduled mode', () => {
    expect(readThemeModeWithScheduleDefault(isValidThemeMode)).toBe('schedule');
    expect(localStorage.getItem('themeMode')).toBe('schedule');
    expect(localStorage.getItem(THEME_SCHEDULE_DEFAULT_APPLIED_KEY)).toBe('true');
  });

  it('moves an existing install to scheduled mode exactly once', () => {
    localStorage.setItem('themeMode', 'auto');
    expect(readThemeModeWithScheduleDefault(isValidThemeMode)).toBe('schedule');
    localStorage.setItem('themeMode', 'dark');
    expect(readThemeModeWithScheduleDefault(isValidThemeMode)).toBe('dark');
  });

  it('falls back to scheduled mode for an unknown stored value', () => {
    localStorage.setItem(THEME_SCHEDULE_DEFAULT_APPLIED_KEY, 'true');
    localStorage.setItem('themeMode', 'night');
    expect(readThemeModeWithScheduleDefault(isValidThemeMode)).toBe('schedule');
  });
});
