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
  private token: string;
  private httpFetch: typeof fetch;
  private client: ReturnType<typeof createAnthropic>;

  constructor() {
    const base = getHomebaseBaseUrl();
    if (!base) {
      throw new Error('This build has no Homebase server');
    }
    this.baseUrl = `${base}/ai`;
    this.token = readPairedToken();
    if (!this.token) {
      throw new Error('Pair this device with Homebase to use the assistant');
    }
    this.httpFetch = getAIFetch();
    this.client = createAnthropic({
      baseURL: `${this.baseUrl}/v1`,
      authToken: this.token,
      fetch: this.httpFetch,
    });
    aiLogger.provider.init('homebase', HOMEBASE_DEFAULT_MODEL);
  }

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
      const response = await this.httpFetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
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
