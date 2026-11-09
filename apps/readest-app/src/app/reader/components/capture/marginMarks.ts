export type MarginMark = '?' | '✗' | '!';

export const MARGIN_MARKS: ReadonlyArray<{ mark: MarginMark; label: string }> = [
  { mark: '?', label: 'Question' },
  { mark: '✗', label: 'Disagree' },
  { mark: '!', label: 'Key' },
];

export function splitMarkedNote(note: string): { mark: MarginMark | null; body: string } {
  const match = /^([?✗!])(?:\s+|$)/u.exec(note);
  if (!match) return { mark: null, body: note };
  return { mark: match[1] as MarginMark, body: note.slice(match[0].length) };
}

export function joinMarkedNote(mark: MarginMark | null, body: string): string {
  const trimmed = body.trim();
  if (!mark) return trimmed;
  return trimmed ? `${mark} ${trimmed}` : mark;
}
