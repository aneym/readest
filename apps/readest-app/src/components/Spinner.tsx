import clsx from 'clsx';
import React, { useEffect, useState } from 'react';
import { useThemeStore } from '@/store/themeStore';
import { useTranslation } from '@/hooks/useTranslation';

const Spinner: React.FC<{
  loading: boolean;
  className?: string;
}> = ({ loading, className }) => {
  const _ = useTranslation();
  const { safeAreaInsets } = useThemeStore();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 600);
    return () => clearTimeout(timer);
  }, [loading]);
  if (!loading || !visible) return null;

  return (
    <div
      className={clsx('absolute left-1/2 top-4 -translate-x-1/2 transform text-center', className)}
      style={{
        paddingTop: `${(safeAreaInsets?.top || 0) + 64}px`,
      }}
      role='status'
    >
      <span className='loading loading-lg not-eink:loading-dots eink:hidden'></span>
      <span className='sr-only eink:not-sr-only'>{_('Loading...')}</span>
    </div>
  );
};

export default Spinner;
