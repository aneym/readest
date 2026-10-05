import clsx from 'clsx';
import React, { useEffect, useState } from 'react';
import { isHouseholdBuild } from '@/services/household';
import { useThemeStore } from '@/store/themeStore';
import { useTranslation } from '@/hooks/useTranslation';

const Spinner: React.FC<{
  loading: boolean;
  className?: string;
  bookOpen?: boolean;
}> = ({ loading, className, bookOpen = false }) => {
  const _ = useTranslation();
  const { safeAreaInsets } = useThemeStore();
  const householdEink =
    typeof document !== 'undefined' &&
    isHouseholdBuild() &&
    document.documentElement.getAttribute('data-eink') === 'true';
  const delayed = bookOpen || householdEink;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!loading || !delayed) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 600);
    return () => clearTimeout(timer);
  }, [loading, delayed]);
  if (!loading || (delayed && !visible)) return null;

  return (
    <div
      className='absolute left-1/2 top-4 -translate-x-1/2 transform text-center'
      style={{
        paddingTop: `${(safeAreaInsets?.top || 0) + 64}px`,
      }}
      role='status'
    >
      {!householdEink && (
        <span
          className={clsx(
            'loading loading-lg not-eink:loading-dots eink:loading-spinner',
            className,
          )}
        ></span>
      )}
      <span className={householdEink ? '' : 'sr-only'}>{_('Loading...')}</span>
    </div>
  );
};

export default Spinner;
