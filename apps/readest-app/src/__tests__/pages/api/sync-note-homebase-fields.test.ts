import { expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ inserted: vi.fn() }));
vi.mock('@/utils/access', () => ({
  validateUserAndToken: async () => ({ user: { id: 'u1' }, token: 'token' }),
}));
vi.mock('@/utils/supabase', () => ({
  createSupabaseClient: () => ({
    from: (table: string) => ({
      select: () => ({
        or: async () => ({ data: [], error: null }),
      }),
      insert: (rows: unknown[]) => {
        if (table === 'book_notes') mocks.inserted(rows);
        return { select: async () => ({ data: rows, error: null }) };
      },
    }),
  }),
}));

import { POST } from '@/pages/api/sync';

it('writes note content but never Homebase-only columns to Supabase book_notes', async () => {
  mocks.inserted.mockClear();
  const req = new Request('https://reader.example/api/sync', {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify({
      notes: [
        {
          bookHash: 'book',
          id: 'note',
          type: 'annotation',
          note: 'text',
          createdAt: 1000,
          updatedAt: 2000,
          hbKind: 'voice',
          hbAudioSha256: 'abc',
          hbAudioDurationMs: 42,
          hbTranscriptSource: 'asr',
        },
      ],
    }),
  }) as NextRequest;
  const response = await POST(req);
  expect(response.status).toBe(200);
  expect(mocks.inserted).toHaveBeenCalledTimes(1);
  const [note] = mocks.inserted.mock.calls[0]![0] as Record<string, unknown>[];
  expect(note).toMatchObject({ id: 'note', note: 'text', book_hash: 'book' });
  expect(Object.keys(note!).filter((key) => key.startsWith('hb'))).toEqual([]);
});
