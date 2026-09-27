import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getThemeCode } from '@/utils/style';
import { themes } from '@/styles/themes';

const defaultTheme = themes.find((theme) => theme.name === 'default')!;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('themeColor', 'default');
  document.documentElement.dataset['eink'] = 'true';
});

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset['eink'];
});

describe('getThemeCode on e-ink', () => {
  it('provides true black and white for the resolved dark reader and PDF colors', () => {
    localStorage.setItem('themeMode', 'dark');
    const code = getThemeCode();
    expect(code.bg).toBe('#000000');
    expect(code.fg).toBe('#ffffff');
    expect(code.primary).toBe(defaultTheme.colors.dark.primary);
  });

  it('keeps palette colors in light mode and on LCD in dark mode', () => {
    localStorage.setItem('themeMode', 'light');
    expect(getThemeCode()).toMatchObject({
      bg: defaultTheme.colors.light['base-100'],
      fg: defaultTheme.colors.light['base-content'],
    });
    localStorage.setItem('themeMode', 'dark');
    delete document.documentElement.dataset['eink'];
    expect(getThemeCode()).toMatchObject({
      bg: defaultTheme.colors.dark['base-100'],
      fg: defaultTheme.colors.dark['base-content'],
    });
  });
});
