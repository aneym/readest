import clsx from 'clsx';
import React, { useState } from 'react';
import { IoCheckmarkCircle } from 'react-icons/io5';
import { useTranslation } from '@/hooks/useTranslation';
import type { DiscoverWork } from '@/services/discover/types';

export const isWorkOwned = (work: DiscoverWork): boolean =>
  !!(work.owned?.ebook || work.owned?.audiobook);

interface DiscoverCoverProps {
  work: Pick<DiscoverWork, 'title' | 'authors' | 'coverUrl'>;
  className?: string;
}

/**
 * A 2:3 cover. With no art, or art that fails to load (always, offline), it
 * falls back to a typeset cover so the grid never shows a broken image.
 *
 * The web build is cross-origin isolated (COEP require-corp), so art is first
 * requested with CORS, which Open Library answers. A host without CORS gets a
 * second, plain request, which works in the app's webview.
 */
export const DiscoverCover: React.FC<DiscoverCoverProps> = ({ work, className }) => {
  const [attempt, setAttempt] = useState<'cors' | 'plain' | 'failed'>('cors');
  const showArt = !!work.coverUrl && attempt !== 'failed';
  return (
    <div
      className={clsx(
        'border-base-content/10 eink:border-base-content bg-base-200 eink:bg-base-100 relative aspect-[2/3] w-full overflow-hidden rounded-md border',
        className,
      )}
    >
      {showArt ? (
        <img
          key={attempt}
          src={work.coverUrl!}
          alt=''
          crossOrigin={attempt === 'cors' ? 'anonymous' : undefined}
          loading='lazy'
          decoding='async'
          referrerPolicy='no-referrer'
          onError={() => setAttempt(attempt === 'cors' ? 'plain' : 'failed')}
          className='h-full w-full object-cover'
        />
      ) : (
        <div className='flex h-full w-full flex-col justify-between p-2.5 text-start'>
          <span className='line-clamp-4 font-serif text-sm font-semibold leading-snug [overflow-wrap:anywhere]'>
            {work.title}
          </span>
          {work.authors[0] && (
            <span className='text-base-content/70 line-clamp-2 text-[11px] leading-tight'>
              {work.authors[0]}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

interface DiscoverWorkCardProps {
  work: DiscoverWork;
  onOpen: (work: DiscoverWork) => void;
  className?: string;
}

const DiscoverWorkCard: React.FC<DiscoverWorkCardProps> = ({ work, onOpen, className }) => {
  const _ = useTranslation();
  const owned = isWorkOwned(work);
  const author = work.authors[0] ?? '';
  const label = [work.title, author, owned ? _('On shelf') : ''].filter(Boolean).join(', ');
  return (
    <li className={clsx('flex min-w-0', className)}>
      <button
        type='button'
        aria-label={label}
        onClick={() => onOpen(work)}
        className='focus-visible:outline-base-content flex w-full min-w-0 flex-col gap-2 rounded-md text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4'
      >
        <DiscoverCover work={work} />
        <span className='flex min-w-0 flex-col gap-0.5 px-0.5'>
          <span className='line-clamp-2 text-sm font-semibold leading-snug'>{work.title}</span>
          {author && (
            <span className='text-base-content/70 line-clamp-1 text-xs leading-snug'>{author}</span>
          )}
          {owned && (
            <span className='mt-0.5 flex items-center gap-1 text-xs font-medium'>
              <IoCheckmarkCircle aria-hidden className='shrink-0' size={14} />
              {_('On shelf')}
            </span>
          )}
        </span>
      </button>
    </li>
  );
};

export default DiscoverWorkCard;
