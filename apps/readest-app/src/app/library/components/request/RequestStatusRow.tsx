import { useTranslation } from '@/hooks/useTranslation';
import type { RequestRecord } from '@/services/homebase/immersion/types';
import { statusLine } from './requestModel';

export default function RequestStatusRow({
  record,
  isBwEink,
  busy,
  onConfirm,
  onRealign,
}: {
  record: RequestRecord;
  isBwEink: boolean;
  busy: boolean;
  onConfirm: (pairId: string) => void;
  onRealign: (pairId: string) => void;
}) {
  const _ = useTranslation();
  const { pair } = record;
  return (
    <li className='border-base-content/20 border-b py-3'>
      <p className='font-semibold'>{record.title}</p>
      <p className='text-base-content/70 text-sm'>{record.author}</p>
      <p role='status' className='text-sm'>
        {_(statusLine(record, { isBwEink }))}
      </p>
      {pair.pairId && (pair.state === 'candidate' || pair.state === 'ready-to-swap') && (
        <button
          className='btn btn-sm btn-outline mt-2'
          disabled={busy}
          onClick={() => onConfirm(pair.pairId!)}
        >
          {_(pair.state === 'candidate' ? 'Confirm match' : 'Use narrated edition')}
        </button>
      )}
      {pair.pairId && pair.state === 'failed' && (
        <button
          className='btn btn-sm btn-outline mt-2'
          disabled={busy}
          onClick={() => onRealign(pair.pairId!)}
        >
          {_('Retry alignment')}
        </button>
      )}
    </li>
  );
}
