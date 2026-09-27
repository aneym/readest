import { useTranslation } from '@/hooks/useTranslation';
import type { SearchResult } from '@/services/homebase/immersion/types';
import { actionsFor, halfLabel, type ResultAction } from './requestModel';

export default function RequestResultRow({
  result,
  requested,
  error,
  busy,
  onAction,
}: {
  result: SearchResult;
  requested: boolean;
  error: boolean;
  busy: boolean;
  onAction: (action: ResultAction) => void;
}) {
  const _ = useTranslation();
  return (
    <li className='border-base-content/20 flex gap-3 border-b py-3'>
      {result.coverUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className='h-16 w-11 shrink-0 object-cover' src={result.coverUrl} alt='' />
      )}
      <div className='min-w-0 flex-1'>
        <p className='font-semibold'>{result.title}</p>
        <p className='text-base-content/70 text-sm'>{result.author}</p>
        <p className='text-base-content/70 text-xs'>
          {_('Ebook')}: {_(halfLabel(result.ebook))} · {_('Audiobook')}:{' '}
          {_(halfLabel(result.audiobook))}
        </p>
        {error && <p role='alert'>{_("Couldn't send. Try again.")}</p>}
        {requested ? (
          <span role='status'>{_('Requested')}</span>
        ) : (
          <div className='mt-2 flex flex-wrap gap-2'>
            {actionsFor(result).map((action) => (
              <button
                key={action.label}
                type='button'
                disabled={busy}
                className='btn btn-sm btn-outline'
                onClick={() => onAction(action)}
              >
                {_(action.label)}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
