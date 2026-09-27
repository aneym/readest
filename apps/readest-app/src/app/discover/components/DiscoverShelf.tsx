import clsx from 'clsx';
import React, { useId, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { DiscoverWork } from '@/services/discover/types';
import DiscoverWorkCard from './DiscoverWorkCard';

/**
 * Collapsed, a shelf shows two rows at every width: 2 or 3 columns on a phone
 * (6 covers), then 4, 5, 6 and 7 columns (8, 10, 12, 14 covers). Hiding is
 * CSS-only so the count follows the viewport without measuring it.
 */
const hiddenWhenCollapsed = (index: number): string | undefined => {
  if (index < 6) return undefined;
  if (index < 8) return 'hidden sm:flex';
  if (index < 10) return 'hidden md:flex';
  if (index < 12) return 'hidden lg:flex';
  if (index < 14) return 'hidden xl:flex';
  return 'hidden';
};

/** Hides the "Show all" button at widths where every cover already fits. */
const showAllHiddenAt = (count: number): string | undefined => {
  if (count <= 8) return 'sm:hidden';
  if (count <= 10) return 'md:hidden';
  if (count <= 12) return 'lg:hidden';
  if (count <= 14) return 'xl:hidden';
  return undefined;
};

interface DiscoverShelfProps {
  title: string;
  reason?: string | null;
  works: DiscoverWork[];
  onOpenWork: (work: DiscoverWork) => void;
  /** Search results start expanded; browse shelves start at two rows. */
  collapsible?: boolean;
  /** Small trailing note beside the title, such as "Saved 2 hours ago". */
  note?: string;
}

const DiscoverShelf: React.FC<DiscoverShelfProps> = ({
  title,
  reason,
  works,
  onOpenWork,
  collapsible = true,
  note,
}) => {
  const _ = useTranslation();
  const headingId = useId();
  const [expanded, setExpanded] = useState(!collapsible);
  if (works.length === 0) return null;
  const canExpand = collapsible && !expanded && works.length > 6;
  return (
    <section aria-labelledby={headingId} className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5'>
        <div className='flex min-w-0 flex-col gap-0.5'>
          <h2 id={headingId} className='text-base font-semibold leading-snug'>
            {title}
          </h2>
          {reason && <p className='text-base-content/70 text-sm leading-snug'>{reason}</p>}
        </div>
        {note && <p className='text-base-content/70 text-xs tabular-nums'>{note}</p>}
      </div>
      <ul className='grid grid-cols-3 gap-x-4 gap-y-6 max-[379px]:grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7'>
        {works.map((work, index) => (
          <DiscoverWorkCard
            key={`${work.key}:${index}`}
            work={work}
            onOpen={onOpenWork}
            className={expanded ? undefined : hiddenWhenCollapsed(index)}
          />
        ))}
      </ul>
      {canExpand && (
        <button
          type='button'
          onClick={() => setExpanded(true)}
          className={clsx(
            'border-base-content/20 eink:border-base-content h-11 self-start rounded-full border px-4 text-sm font-medium',
            showAllHiddenAt(works.length),
          )}
        >
          {_('Show all {{count}}', { count: works.length })}
        </button>
      )}
    </section>
  );
};

export default DiscoverShelf;
