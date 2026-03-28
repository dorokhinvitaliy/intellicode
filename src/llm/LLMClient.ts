import * as vscode from 'vscode';

export interface LLMConfig {
  provider: string;
  apiKey: string;
  endpoint: string;
  model: string;
  embeddingModel: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EmbeddingResult {
  embedding: number[];
  tokensUsed: number;
}

/**
 * Универсальный LLM-клиент.
 * Поддерживает: OpenAI, Anthropic, Ollama (без API-ключа), Custom endpoint.
 * Если API недоступен — используется локальный fallback для эмбеддингов.
 */
export class LLMClient {
  private config: LLMConfig;
  private embeddingDimension = 384;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  updateConfig(config: LLMConfig): void {
    this.config = config;
  }

  /** Проверяет, можно ли вызывать LLM */
  isReady(): boolean {
    if (this.config.provider === 'ollama') {
      return true; // Ollama не требует ключа
    }
    if (this.config.provider === 'custom') {
      return !!this.config.endpoint;
    }
    return !!this.config.apiKey;
  }

  /** Возвращает base URL для текущего провайдера */
  private getBaseURL(): string {
    switch (this.config.provider) {
      case 'ollama':
        return this.config.endpoint || 'http://localhost:11434/v1';
      case 'openai':
        return this.config.endpoint || 'https://api.openai.com/v1';
      case 'anthropic':
        return this.config.endpoint || 'https://api.anthropic.com';
      case 'custom':
        return this.config.endpoint;
      default:
        return 'https://api.openai.com/v1';
    }
  }

  /** Возвращает API-ключ (для Ollama — пустая строка допустима) */
  private getApiKey(): string {
    if (this.config.provider === 'ollama') {
      return this.config.apiKey || 'ollama'; // Ollama не требует ключ
    }
    return this.config.apiKey;
  }

  /** Возвращает модель по умолчанию для провайдера */
  private getDefaultModel(): string {
    switch (this.config.provider) {
      case 'ollama':
        return this.config.model || 'llama3.2';
      case 'anthropic':
        return this.config.model || 'claude-3-5-sonnet-20241022';
      case 'openai':
        return this.config.model || 'gpt-4o';
      default:
        return this.config.model || 'gpt-4o';
    }
  }

  async chat(messages: ChatMessage[], options?: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    if (!this.isReady()) {
      vscode.window.showErrorMessage(
        'IntelliCode Fabric: Настройте LLM провайдер в настройках расширения. ' +
        'Для Ollama установите провайдер "ollama" (API-ключ не нужен).'
      );
      throw new Error('LLM не настроен. Откройте настройки: Ctrl+, → intellicodeFabric');
    }

    if (this.config.provider === 'anthropic') {
      return this.chatAnthropic(messages, options);
    }

    return this.chatOpenAICompatible(messages, options);
  }

  async *chatStream(messages: ChatMessage[], options?: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<string> {
    if (!this.isReady()) {
      throw new Error('LLM не настроен');
    }

    const baseURL = this.getBaseURL();
    const apiKey = this.getApiKey();
    const model = this.getDefaultModel();

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey && apiKey !== 'ollama') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) { return; }
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
        const data = trimmed.slice(6);
        if (data === '[DONE]') { return; }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
  }

  async createEmbedding(text: string): Promise<EmbeddingResult> {
    // Для Ollama используем отдельный API
    if (this.config.provider === 'ollama') {
      return this.createEmbeddingOllama(text);
    }

    // Если API недоступен, используем локальный fallback
    if (!this.isReady()) {
      return this.createLocalEmbedding(text);
    }

    try {
      return await this.createEmbeddingAPI(text);
    } catch (error) {
      console.warn('API embedding failed, using local fallback:', error);
      return this.createLocalEmbedding(text);
    }
  }

  async createEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    if (this.config.provider === 'ollama') {
      const results: EmbeddingResult[] = [];
      for (const text of texts) {
        results.push(await this.createEmbeddingOllama(text));
      }
      return results;
    }

    if (!this.isReady()) {
      return texts.map(t => this.createLocalEmbedding(t));
    }

    try {
      return await this.createEmbeddingsAPI(texts);
    } catch (error) {
      console.warn('API embeddings failed, using local fallback:', error);
      return texts.map(t => this.createLocalEmbedding(t));
    }
  }

  // ─── OpenAI-compatible chat ──────────────────────────

  private async chatOpenAICompatible(messages: ChatMessage[], options?: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const baseURL = this.getBaseURL();
    const apiKey = this.getApiKey();
    const model = this.getDefaultModel();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey && apiKey !== 'ollama') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: options?.temperature ?? 0.3,
        max_tokens: options?.maxTokens ?? 4096,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM error ${response.status}: ${errText}`);
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }

  // ─── Anthropic ──────────────────────────

  private async chatAnthropic(messages: ChatMessage[], options?: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const apiKey = this.getApiKey();
    const model = this.getDefaultModel();

    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: options?.maxTokens ?? 4096,
        system: systemMessage?.content || '',
        messages: chatMessages,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic error ${response.status}: ${errText}`);
    }

    const data = await response.json() as any;
    return data.content?.[0]?.text || '';
  }

  // ─── Embeddings ──────────────────────────

  private async createEmbeddingAPI(text: string): Promise<EmbeddingResult> {
    const baseURL = this.getBaseURL();
    const apiKey = this.getApiKey();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey && apiKey !== 'ollama') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.embeddingModel || 'text-embedding-3-small',
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error ${response.status}`);
    }

    const data = await response.json() as any;
    return {
      embedding: data.data[0].embedding,
      tokensUsed: data.usage?.total_tokens || 0,
    };
  }

  private async createEmbeddingsAPI(texts: string[]): Promise<EmbeddingResult[]> {
    const baseURL = this.getBaseURL();
    const apiKey = this.getApiKey();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey && apiKey !== 'ollama') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const results: EmbeddingResult[] = [];
    const batchSize = 100;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await fetch(`${baseURL}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.embeddingModel || 'text-embedding-3-small',
          input: batch,
        }),
      });

      if (!response.ok) {
        throw new Error(`Embedding API error ${response.status}`);
      }

      const data = await response.json() as any;
      for (const item of data.data) {
        results.push({
          embedding: item.embedding,
          tokensUsed: Math.floor((data.usage?.total_tokens || 0) / batch.length),
        });
      }
    }

    return results;
  }

  private async createEmbeddingOllama(text: string): Promise<EmbeddingResult> {
    const endpoint = this.config.endpoint || 'http://localhost:11434';
    // Удаляем /v1 если есть
    const baseUrl = endpoint.replace(/\/v1\/?$/, '');
    const embModel = this.config.embeddingModel || 'nomic-embed-text';

    try {
      const response = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: embModel,
          prompt: text,
        }),
      });

      if (!response.ok) {
        console.warn(`Ollama embedding failed (${response.status}), using local fallback`);
        return this.createLocalEmbedding(text);
      }

      const data = await response.json() as any;
      if (data.embedding && data.embedding.length > 0) {
        this.embeddingDimension = data.embedding.length;
        return { embedding: data.embedding, tokensUsed: 0 };
      }

      return this.createLocalEmbedding(text);
    } catch (error) {
      console.warn('Ollama embedding not available, using local fallback:', error);
      return this.createLocalEmbedding(text);
    }
  }

  // ─── Локальные эмбеддинги (fallback) ──────────────────────────

  /**
   * Простой хэш-based embedding для работы без внешнего API.
   * Создает стабильный вектор из текста используя character n-grams.
   * Не идеальный, но позволяет базовый семантический поиск.
   */
  createLocalEmbedding(text: string): EmbeddingResult {
    const dim = this.embeddingDimension;
    const embedding = new Array(dim).fill(0);
    const normalized = text.toLowerCase().replace(/[^\w\s]/g, ' ');
    const tokens = normalized.split(/\s+/).filter(t => t.length > 1);

    // Unigram hashing
    for (const token of tokens) {
      const hash = this.hashString(token);
      const idx = Math.abs(hash) % dim;
      embedding[idx] += 1.0;

      // Bigram character features
      for (let i = 0; i < token.length - 1; i++) {
        const bigram = token.substring(i, i + 2);
        const bHash = this.hashString(bigram);
        const bIdx = Math.abs(bHash) % dim;
        embedding[bIdx] += 0.5;
      }

      // Trigram character features
      for (let i = 0; i < token.length - 2; i++) {
        const trigram = token.substring(i, i + 3);
        const tHash = this.hashString(trigram);
        const tIdx = Math.abs(tHash) % dim;
        embedding[tIdx] += 0.3;
      }
    }

    // L2 normalize
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        embedding[i] /= norm;
      }
    }

    return { embedding, tokensUsed: 0 };
  }

  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }
}
