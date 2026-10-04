import { describe, expect, it } from 'vitest';
import { applyHomebaseAIDefault } from '@/services/settingsService';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import type { AISettings } from '@/services/ai/types';

// Table over the one-time household default: which stored assistant settings
// get switched to Homebase, and which a reader's own choice protects.
const cases: Array<{
  name: string;
  stored: Partial<AISettings>;
  homebase: boolean;
  enabled: boolean;
  provider: AISettings['provider'];
}> = [
  {
    name: 'fresh install on a household build',
    stored: {},
    homebase: true,
    enabled: true,
    provider: 'homebase',
  },
  {
    name: 'stock build stays stock',
    stored: {},
    homebase: false,
    enabled: false,
    provider: 'ollama',
  },
  {
    name: 'reader already chose OpenRouter',
    stored: { enabled: true, provider: 'openrouter' },
    homebase: true,
    enabled: true,
    provider: 'openrouter',
  },
  {
    name: 'reader picked Ollama and enabled it',
    stored: { enabled: true, provider: 'ollama' },
    homebase: true,
    enabled: true,
    provider: 'ollama',
  },
  {
    name: 'reader turned it off after the default applied',
    stored: { enabled: false, provider: 'homebase', homebaseDefaultApplied: true },
    homebase: true,
    enabled: false,
    provider: 'homebase',
  },
  {
    name: 'reader went back to stock Ollama off after the default',
    stored: { enabled: false, provider: 'ollama', homebaseDefaultApplied: true },
    homebase: true,
    enabled: false,
    provider: 'ollama',
  },
];

describe('applyHomebaseAIDefault', () => {
  it.each(cases)('$name', ({ stored, homebase, enabled, provider }) => {
    const ai: AISettings = { ...DEFAULT_AI_SETTINGS, ...stored };
    applyHomebaseAIDefault(ai, homebase);
    expect({ enabled: ai.enabled, provider: ai.provider }).toEqual({ enabled, provider });
  });
});
