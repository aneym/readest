import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { isValidScheduleTime, type ThemeSchedule } from '@/utils/themeSchedule';
import { SettingLabel } from '../primitives';

interface ThemeScheduleSettingsProps {
  schedule: ThemeSchedule;
  /** Whether Scheduled Mode is currently resolving to the dark palette. */
  isDarkNow: boolean;
  onScheduleChange: (schedule: ThemeSchedule) => void;
  'data-setting-id'?: string;
}

/**
 * Dark-from / Light-from clock rows shown under the Theme Mode selector
 * while Scheduled Mode is active. Native `<input type="time">` so Android
 * opens its own picker; times are device-local wall clock (DST and travel
 * follow the OS clock, no location permission needed).
 */
const ThemeScheduleSettings: React.FC<ThemeScheduleSettingsProps> = ({
  schedule,
  isDarkNow,
  onScheduleChange,
  'data-setting-id': settingId,
}) => {
  const _ = useTranslation();

  const update = (key: keyof ThemeSchedule) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    // Android's picker commits a complete value; an empty string is the
    // user clearing the field, which we ignore rather than store.
    if (!isValidScheduleTime(value)) return;
    onScheduleChange({ ...schedule, [key]: value });
  };

  const rows: { key: keyof ThemeSchedule; label: string }[] = [
    { key: 'darkStart', label: _('Dark From') },
    { key: 'lightStart', label: _('Light From') },
  ];

  return (
    <div data-setting-id={settingId} className='space-y-4'>
      {rows.map(({ key, label }) => (
        <label key={key} className='flex cursor-pointer items-center justify-between px-4'>
          <SettingLabel>{label}</SettingLabel>
          <input
            type='time'
            value={schedule[key]}
            onChange={update(key)}
            aria-label={label}
            className='input input-sm eink-bordered bg-base-200 text-base-content h-9 rounded-full px-3 text-end'
          />
        </label>
      ))}
      <div className='text-base-content/65 px-4 text-[0.8em] leading-snug'>
        {isDarkNow
          ? _('Dark now; switches to light at {{time}}', { time: schedule.lightStart })
          : _('Light now; switches to dark at {{time}}', { time: schedule.darkStart })}
      </div>
    </div>
  );
};

export default ThemeScheduleSettings;
