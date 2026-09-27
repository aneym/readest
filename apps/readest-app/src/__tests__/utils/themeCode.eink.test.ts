import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { getThemeCode } from '@/utils/style';
import { useThemeStore } from '@/store/themeStore';
import { useEinkMode } from '@/hooks/useEinkMode';
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
  delete window.__READEST_IS_EINK;
});

describe('getThemeCode on e-ink', () => {
  it('provides true black and white for the resolved dark reader and PDF colors', () => {
    localStorage.setItem('themeMode', 'dark');
    const code = getThemeCode();
    expect(code.bg).toBe('#000000');
    expect(code.fg).toBe('#ffffff');
    expect(code.primary).toBe(defaultTheme.colors.dark.primary);
  });

  it('uses the native e-ink contrast default when no theme color is saved', () => {
    localStorage.removeItem('themeColor');
    localStorage.setItem('themeMode', 'light');
    window.__READEST_IS_EINK = true;
    const contrast = themes.find((theme) => theme.name === 'contrast')!;
    expect(getThemeCode()).toMatchObject({
      bg: contrast.colors.light['base-100'],
      fg: contrast.colors.light['base-content'],
      primary: contrast.colors.light.primary,
    });
    delete window.__READEST_IS_EINK;
  });

  it('updates the stored theme code when e-ink is activated after store initialization', () => {
    localStorage.setItem('themeMode', 'dark');
    delete document.documentElement.dataset['eink'];
    useThemeStore.setState({ themeCode: getThemeCode() });
    expect(useThemeStore.getState().themeCode.bg).toBe(defaultTheme.colors.dark['base-100']);
    const { result } = renderHook(useEinkMode);
    result.current.applyEinkMode(true);
    expect(useThemeStore.getState().themeCode).toMatchObject({ bg: '#000000', fg: '#ffffff' });
    result.current.applyEinkMode(false);
    expect(useThemeStore.getState().themeCode.bg).toBe(defaultTheme.colors.dark['base-100']);
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
