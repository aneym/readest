import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { AIProvider, AIProviderName } from '../types';
import { aiLogger } from '../logger';
import { AI_TIMEOUTS } from '../utils/retry';
import { getAIFetch } from '../utils/httpFetch';
import { getHomebaseBaseUrl } from '@/services/sync/homebase/config';

export const HOMEBASE_DEFAULT_MODEL = 'claude-sonnet-5-5';

const readPairedToken = (): string =>
  typeof localStorage !== 'undefined' ? (localStorage.getItem('token') ?? '') : '';

/**
 * The household server's assistant route. It speaks the Anthropic Messages
 * API, authenticates this device by its paired Homebase token, and forwards to
 * the house model gateway with the server's own model choice, so no provider
 * key lives on the device.
 *
 * Chat only: the route serves no embeddings, so book indexing is unavailable
 * and answers come from the visible page plus the model's own knowledge.
 */
export class HomebaseProvider implements AIProvider {
  id: AIProviderName = 'homebase';
  name = 'Homebase';
  requiresAuth = false;

  private baseUrl: string;
  private httpFetch: typeof fetch;
  private client: ReturnType<typeof createAnthropic>;

  // Never throws: the AI tab builds the provider while it renders, so an
  // unpaired device or a build without a server fails on the request instead.
  constructor() {
    this.baseUrl = `${getHomebaseBaseUrl()}/ai`;
    this.httpFetch = getAIFetch();
    this.client = createAnthropic({
      baseURL: `${this.baseUrl}/v1`,
      // Selects Bearer auth; pairedFetch swaps in the current token per request.
      authToken: 'paired-device',
      fetch: this.pairedFetch,
    });
    aiLogger.provider.init('homebase', HOMEBASE_DEFAULT_MODEL);
  }

  private pairedFetch: typeof fetch = (input, init) => {
    if (!getHomebaseBaseUrl()) {
      return Promise.reject(new Error('This build has no Homebase server'));
    }
    const token = readPairedToken();
    if (!token) {
      return Promise.reject(new Error('Pair this device with Homebase to use the assistant'));
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return this.httpFetch(input, { ...init, headers });
  };

  getModel(): LanguageModel {
    // The server overrides the model; the id only labels the request.
    return this.client(HOMEBASE_DEFAULT_MODEL);
  }

  // The retrieval backends build their embedding model when the AI tab
  // mounts, so this must not throw until something actually embeds.
  getEmbeddingModel(): EmbeddingModel {
    return {
      specificationVersion: 'v3',
      modelId: 'none',
      provider: 'homebase',
      maxEmbeddingsPerCall: 1,
      supportsParallelCalls: false,
      async doEmbed() {
        throw new Error('Homebase does not serve embeddings');
      },
    } as EmbeddingModel;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.pairedFetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(AI_TIMEOUTS.HEALTH_CHECK),
      });
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      return true;
    } catch (e) {
      aiLogger.provider.error('homebase', `healthCheck failed: ${(e as Error).message}`);
      return false;
    }
  }
}
