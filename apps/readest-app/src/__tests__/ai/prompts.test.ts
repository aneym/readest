import { describe, expect, test } from 'vitest';
import {
  PAGE_CONTEXT_MAX_CHARS,
  buildSystemPrompt,
  formatPageContext,
} from '@/services/ai/prompts';
import { buildReedySystemPrompt } from '@/services/ai/adapters/TauriChatAdapter';

// Alex's ask (2026-09-04): while reading on the Palma with internet, ask a
// question directly as you go, even when the book has no context for it. The
// old prompt forbade any answer outside the book and told the reader to index
// first; the new one carries the visible page and allows general knowledge
// while keeping the no-spoiler rule.
describe('AI system prompts: page context and general questions', () => {
  const page = {
    chapterTitle: 'Chapter 3 - Resume target',
    text: 'QA-C3-P07 Resume target paragraph 7.',
  };

  test('formatPageContext wraps the visible page with its chapter', () => {
    const block = formatPageContext(page);
    expect(block).toContain('<CURRENT_PAGE chapter="Chapter 3 - Resume target">');
    expect(block).toContain('QA-C3-P07');
    expect(block).toContain('</CURRENT_PAGE>');
  });

  test('formatPageContext is empty without text and caps long pages', () => {
    expect(formatPageContext(undefined)).toBe('');
    expect(formatPageContext({ chapterTitle: null, text: '   ' })).toBe('');
    const long = formatPageContext({
      chapterTitle: null,
      text: 'x'.repeat(PAGE_CONTEXT_MAX_CHARS + 500),
    });
    expect(long.length).toBeLessThan(PAGE_CONTEXT_MAX_CHARS + 60);
    expect(long).not.toContain('chapter=');
  });

  test('legacy prompt carries the page, allows general knowledge, keeps no-spoiler', () => {
    const prompt = buildSystemPrompt('A Little Hatred', 'Joe Abercrombie', [], 42, page);
    expect(prompt).toContain('QA-C3-P07');
    expect(prompt).toContain('Your own general knowledge');
    expect(prompt).toContain('beyond page 42');
    expect(prompt).not.toContain('decline all other topics');
    expect(prompt).not.toContain('NEVER use your training knowledge');
    expect(prompt).toContain('No indexed passages for this book');
  });

  test('legacy prompt without page context has no CURRENT_PAGE block', () => {
    const prompt = buildSystemPrompt('A Little Hatred', '', [], 1);
    expect(prompt).not.toContain('</CURRENT_PAGE>');
  });

  test('Reedy prompt carries the page and answers unindexed questions instead of deflecting', () => {
    const prompt = buildReedySystemPrompt('A Little Hatred', 'Joe Abercrombie', 42, page);
    expect(prompt).toContain('QA-C3-P07');
    expect(prompt).toContain('answer from the current page and your own knowledge');
    expect(prompt).not.toContain("this book hasn't been indexed yet");
    expect(prompt).toContain('lookupPassage');
  });
});
