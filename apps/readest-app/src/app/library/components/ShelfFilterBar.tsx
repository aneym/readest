import clsx from 'clsx';
import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { SHELF_FILTER_IDS, type ShelfFilterId } from '../shelf/shelfFilters';

interface ShelfFilterBarProps {
  value: ShelfFilterId;
  counts: Record<ShelfFilterId, number>;
  onChange: (value: ShelfFilterId) => void;
  className?: string;
}

/**
 * One row of large chips under the library header. Sized for e-ink and a
 * thumb: 44px tall targets, no hover-only affordances, no animation. Chips
 * with nothing behind them stay visible but muted so the row never jumps
 * around as books arrive.
 */
const ShelfFilterBar: React.FC<ShelfFilterBarProps> = ({ value, counts, onChange, className }) => {
  const _ = useTranslation();
  const labels: Record<ShelfFilterId, string> = {
    reading: _('Reading'),
    fiction: _('Fiction'),
    nonfiction: _('Nonfiction'),
    volumes: _('Volumes'),
    all: _('All'),
    finished: _('Finished'),
  };
  return (
    <div
      role='radiogroup'
      aria-label={_('Shelf Filter')}
      data-testid='shelf-filter-bar'
      className={clsx(
        'no-scrollbar flex w-full items-center gap-2 overflow-x-auto px-4 py-2',
        className,
      )}
    >
      {SHELF_FILTER_IDS.map((id) => {
        const active = id === value;
        const count = counts[id];
        return (
          <button
            key={id}
            type='button'
            role='radio'
            aria-checked={active}
            data-shelf-filter={id}
            onClick={() => onChange(id)}
            className={clsx(
              'flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-base font-medium',
              active
                ? 'border-base-content bg-base-content text-base-100'
                : 'border-base-content/30 bg-base-100 text-base-content',
              !active && count === 0 && 'opacity-50',
            )}
          >
            <span>{labels[id]}</span>
            <span
              className={clsx(
                'rounded-full px-1.5 text-xs tabular-nums',
                active ? 'bg-base-100/20' : 'bg-base-content/10',
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default ShelfFilterBar;
