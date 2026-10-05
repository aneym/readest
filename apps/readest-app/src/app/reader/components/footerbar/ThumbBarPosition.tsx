import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useMedianPageDurationSecs } from '@/hooks/useMedianPageDurationSecs';
import { convertPagesToTimeRemainingMinutes } from '@/app/library/utils/libraryUtils';

interface ThumbBarPositionProps {
  bookKey: string;
}

/**
 * Where you are, on top of the household thumb bar: "p. N of M" and the time
 * left in the chapter, then a bordered progress bar. Page numbers and the
 * time estimate come from the same sources as the on-page footer
 * (ProgressBar), so the two never disagree.
 */
export const ThumbBarPosition = ({ bookKey }: ThumbBarPositionProps) => {
  const _ = useTranslation();
  const progress = useBookProgress(bookKey);
  const { getView } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const bookData = getBookData(bookKey);
  const medianPageDurationSecs = useMedianPageDurationSecs(bookData?.book?.hash) ?? undefined;

  const isFixedLayout = !!bookData?.isFixedLayout;
  const pageInfo = isFixedLayout ? progress?.section : progress?.pageinfo;
  if (!pageInfo || pageInfo.total <= 0 || pageInfo.current < 0) return null;

  const { page: current = 0, pages: total = 0 } = getView(bookKey)?.renderer || {};
  const pagesLeft = isFixedLayout
    ? Math.max(pageInfo.total - pageInfo.current, 1)
    : Math.min(Math.max(total - current, 1), pageInfo.total - pageInfo.current);
  const showTimeLeft = pagesLeft > 0 && (total > 0 || isFixedLayout);
  const minutes = convertPagesToTimeRemainingMinutes(pagesLeft, medianPageDurationSecs);
  const timeLeft = showTimeLeft
    ? isFixedLayout
      ? _('{{time}} min left in book', { time: minutes })
      : _('{{time}} min left in chapter', { time: minutes })
    : '';
  const fraction = progress?.fraction ?? (pageInfo.current + 1) / pageInfo.total;
  const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);

  return (
    <div className='px-4 pt-2.5'>
      <div className='flex items-baseline justify-between gap-2 text-[11px] tabular-nums'>
        <span>
          {_('p. {{current}} of {{total}}', {
            current: pageInfo.current + 1,
            total: pageInfo.total,
          })}
        </span>
        {timeLeft && <span className='truncate'>{timeLeft}</span>}
      </div>
      <div
        role='progressbar'
        aria-label={_('Reading Progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className='border-base-content relative mt-1.5 h-1.5 border'
      >
        <div
          className='bg-base-content absolute inset-y-0 start-0'
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};
