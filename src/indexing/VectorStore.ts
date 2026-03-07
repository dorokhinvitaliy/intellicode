import * as fs from 'fs';
import * as path from 'path';

export interface CodeChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  type: 'function' | 'class' | 'method' | 'module' | 'block' | 'comment';
  symbolName?: string;
  embedding?: number[];
  metadata: {
    imports?: string[];
    exports?: string[];
    dependencies?: string[];
    lastModified?: number;
  };
}

export interface SearchResult {
  chunk: CodeChunk;
  score: number;
}

export class VectorStore {
  private chunks: Map<string, CodeChunk> = new Map();
  private storagePath: string;
  private isDirty = false;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.loadFromDisk();
  }

  async addChunk(chunk: CodeChunk): Promise<void> {
    this.chunks.set(chunk.id, chunk);
    this.isDirty = true;
  }

  async addChunks(chunks: CodeChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
    }
    this.isDirty = true;
  }

  async removeByFile(filePath: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.filePath === filePath) {
        this.chunks.delete(id);
      }
    }
    this.isDirty = true;
  }

  async search(queryEmbedding: number[], topK: number = 10): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const chunk of this.chunks.values()) {
      if (!chunk.embedding) continue;
      const score = this.cosineSimilarity(queryEmbedding, chunk.embedding);
      results.push({ chunk, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async hybridSearch(
    queryEmbedding: number[],
    queryText: string,
    topK: number = 10
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const queryTokens = this.tokenize(queryText.toLowerCase());

    for (const chunk of this.chunks.values()) {
      if (!chunk.embedding) continue;

      const vectorScore = this.cosineSimilarity(queryEmbedding, chunk.embedding);
      const keywordScore = this.keywordScore(queryTokens, chunk.content.toLowerCase());
      const combinedScore = 0.7 * vectorScore + 0.3 * keywordScore;

      results.push({ chunk, score: combinedScore });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async searchBySymbol(symbolName: string): Promise<CodeChunk[]> {
    const results: CodeChunk[] = [];
    const lowerName = symbolName.toLowerCase();

    for (const chunk of this.chunks.values()) {
      if (chunk.symbolName?.toLowerCase().includes(lowerName)) {
        results.push(chunk);
      }
    }
    return results;
  }

  getChunksForFile(filePath: string): CodeChunk[] {
    const results: CodeChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.filePath === filePath) {
        results.push(chunk);
      }
    }
    return results.sort((a, b) => a.startLine - b.startLine);
  }

  getDependencyGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();

    for (const chunk of this.chunks.values()) {
      if (chunk.metadata.dependencies && chunk.metadata.dependencies.length > 0) {
        const existing = graph.get(chunk.filePath) || [];
        graph.set(chunk.filePath, [
          ...new Set([...existing, ...chunk.metadata.dependencies]),
        ]);
      }
    }
    return graph;
  }

  getStats() {
    const files = new Set<string>();
    for (const chunk of this.chunks.values()) {
      files.add(chunk.filePath);
    }

    return {
      totalChunks: this.chunks.size,
      totalFiles: files.size,
      filesList: Array.from(files),
      hasEmbeddings: Array.from(this.chunks.values()).filter(c => c.embedding).length,
    };
  }

  async clear(): Promise<void> {
    this.chunks.clear();
    this.isDirty = true;
    await this.saveToDisk();
  }

  async saveToDisk(): Promise<void> {
    if (!this.isDirty) return;

    const dir = this.storagePath;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = JSON.stringify(Array.from(this.chunks.entries()), null, 0);
    fs.writeFileSync(path.join(dir, 'vector_store.json'), data, 'utf-8');
    this.isDirty = false;
  }

  private loadFromDisk(): void {
    const filePath = path.join(this.storagePath, 'vector_store.json');
    if (!fs.existsSync(filePath)) return;

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const entries = JSON.parse(data);
      this.chunks = new Map(entries);
    } catch {
      console.warn('Не удалось загрузить vector store, создаём новый');
      this.chunks = new Map();
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }

  private keywordScore(queryTokens: string[], text: string): number {
    const textTokens = new Set(this.tokenize(text));
    let matches = 0;
    for (const token of queryTokens) {
      if (textTokens.has(token)) matches++;
    }
    return queryTokens.length > 0 ? matches / queryTokens.length : 0;
  }

  private tokenize(text: string): string[] {
    return text.split(/[\s\W_]+/).filter(t => t.length > 2);
  }
}
