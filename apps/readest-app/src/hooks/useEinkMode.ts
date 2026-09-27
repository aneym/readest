import { useCallback } from 'react';
import { useThemeStore } from '@/store/themeStore';
import { getThemeCode } from '@/utils/style';

export const useEinkMode = () => {
  const applyEinkMode = useCallback((isEink: boolean) => {
    if (isEink) {
      document.body.classList.add('no-transitions');
    } else {
      document.body.classList.remove('no-transitions');
    }
    document.documentElement.setAttribute('data-eink', isEink.toString());
    useThemeStore.setState({ themeCode: getThemeCode() });
  }, []);

  return { applyEinkMode };
};
