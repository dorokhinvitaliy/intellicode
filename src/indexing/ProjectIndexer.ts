import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VectorStore, CodeChunk } from './VectorStore';
import { LLMClient } from '../llm/LLMClient';

export interface IndexerConfig {
  excludePatterns: string[];
  chunkSize: number;
  chunkOverlap: number;
}

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  indexedFiles: string[];
  lastIndexed: Date | null;
}

export class ProjectIndexer {
  private vectorStore: VectorStore;
  private llmClient: LLMClient;
  private config: IndexerConfig;
  private cancelled = false;
  private stats: IndexStats = {
    totalFiles: 0,
    totalChunks: 0,
    indexedFiles: [],
    lastIndexed: null,
  };

  private static SUPPORTED_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs',
    '.cpp', '.c', '.h', '.hpp', '.cs', '.rb', '.php', '.swift',
    '.kt', '.scala', '.vue', '.svelte', '.html', '.css', '.scss',
    '.sql', '.graphql', '.proto', '.yaml', '.yml', '.toml',
    '.md', '.json', '.xml',
  ]);

  private static IGNORE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next',
    '__pycache__', '.venv', 'venv', 'env', '.env',
    'coverage', '.nyc_output', '.cache', '.parcel-cache',
    'target', 'bin', 'obj', '.idea', '.vs',
    'vendor', 'bower_components', '.svn', '.hg',
  ]);

  private static IGNORE_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store', 'Thumbs.db',
  ]);

  constructor(vectorStore: VectorStore, llmClient: LLMClient, config: IndexerConfig) {
    this.vectorStore = vectorStore;
    this.llmClient = llmClient;
    this.config = config;
  }

  async indexWorkspace(
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    this.cancelled = false;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('IntelliCode Fabric: Откройте папку проекта для индексации');
      return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    progress?.report({ message: 'Сканирование файлов...' });

    // Ищем файлы рекурсивно
    const files = this.findFilesRecursive(rootPath);
    this.stats.totalFiles = files.length;

    if (files.length === 0) {
      vscode.window.showWarningMessage('IntelliCode Fabric: Файлы для индексации не найдены');
      return;
    }

    progress?.report({ message: `Найдено ${files.length} файлов. Разбиение на чанки...` });

    const allChunks: CodeChunk[] = [];

    for (let i = 0; i < files.length; i++) {
      if (this.cancelled) { break; }

      const file = files[i];
      const relativePath = path.relative(rootPath, file);
      progress?.report({
        message: `[${i + 1}/${files.length}] ${relativePath}`,
        increment: (1 / files.length) * 50,
      });

      try {
        const stat = fs.statSync(file);
        const lastModified = stat.mtimeMs;

        // Caching: Skip if file hasn't changed since last index
        let shouldIndex = true;
        const existingChunks = this.vectorStore.getChunksForFile(file);
        if (existingChunks.length > 0) {
          const cachedMtime = existingChunks[0].metadata?.lastModified || 0;
          if (cachedMtime === lastModified) {
            shouldIndex = false;
          }
        }

        if (shouldIndex) {
          await this.vectorStore.removeByFile(file); // Clear old chunks
          const chunks = this.chunkFile(file);
          chunks.forEach(c => c.metadata.lastModified = lastModified);
          allChunks.push(...chunks);
        }
      } catch (err) {
        console.warn(`Ошибка обработки ${file}:`, err);
      }
    }

    // Создаём эмбеддинги
    progress?.report({ message: `Создание эмбеддингов для ${allChunks.length} чанков...` });

    const batchSize = 20;
    for (let i = 0; i < allChunks.length; i += batchSize) {
      if (this.cancelled) { break; }

      const batch = allChunks.slice(i, i + batchSize);
      const texts = batch.map(c => this.createEmbeddingText(c));

      try {
        const embeddings = await this.llmClient.createEmbeddings(texts);
        for (let j = 0; j < batch.length; j++) {
          batch[j].embedding = embeddings[j].embedding;
        }
      } catch (error) {
        // Fallback: используем локальные эмбеддинги
        console.warn('API embeddings failed, using local fallback:', error);
        for (let j = 0; j < batch.length; j++) {
          const localEmb = this.llmClient.createLocalEmbedding(texts[j]);
          batch[j].embedding = localEmb.embedding;
        }
      }

      progress?.report({
        message: `Эмбеддинги: ${Math.min(i + batchSize, allChunks.length)}/${allChunks.length}`,
        increment: (batchSize / allChunks.length) * 50,
      });
    }

    await this.vectorStore.addChunks(allChunks);
    await this.vectorStore.saveToDisk();

    this.stats.totalChunks = this.vectorStore.getAllChunks().length;
    this.stats.indexedFiles = files;
    this.stats.lastIndexed = new Date();
  }

  async reindexFile(filePath: string): Promise<void> {
    const ext = path.extname(filePath);
    if (!ProjectIndexer.SUPPORTED_EXTENSIONS.has(ext)) { return; }

    await this.vectorStore.removeByFile(filePath);
    await this.indexFile(filePath);
  }

  async indexFile(filePath: string): Promise<void> {
    const ext = path.extname(filePath);
    if (!ProjectIndexer.SUPPORTED_EXTENSIONS.has(ext)) { return; }

    try {
      const chunks = this.chunkFile(filePath);
      const texts = chunks.map(c => this.createEmbeddingText(c));

      try {
        const embeddings = await this.llmClient.createEmbeddings(texts);
        for (let i = 0; i < chunks.length; i++) {
          chunks[i].embedding = embeddings[i].embedding;
        }
      } catch {
        for (let i = 0; i < chunks.length; i++) {
          const localEmb = this.llmClient.createLocalEmbedding(texts[i]);
          chunks[i].embedding = localEmb.embedding;
        }
      }

      await this.vectorStore.addChunks(chunks);
      await this.vectorStore.saveToDisk();
    } catch (err) {
      console.warn(`Ошибка индексации ${filePath}:`, err);
    }
  }

  async removeFile(filePath: string): Promise<void> {
    await this.vectorStore.removeByFile(filePath);
    await this.vectorStore.saveToDisk();
  }

  cancel(): void {
    this.cancelled = true;
  }

  getStats(): IndexStats {
    return { ...this.stats };
  }

  // ─── Рекурсивный поиск файлов (без glob) ──────────────────────────

  private findFilesRecursive(dir: string): string[] {
    const results: string[] = [];
    this.walkDir(dir, results, 0);
    return results;
  }

  private walkDir(dir: string, results: string[], depth: number): void {
    if (depth > 15) { return; } // Защита от слишком глубокой рекурсии

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Нет доступа к директории
    }

    for (const entry of entries) {
      if (this.cancelled) { return; }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Пропускаем игнорируемые директории
        if (ProjectIndexer.IGNORE_DIRS.has(entry.name)) { continue; }
        if (entry.name.startsWith('.') && entry.name !== '.github') { continue; }

        // Проверяем пользовательские exclude паттерны
        if (this.isExcluded(entry.name)) { continue; }

        this.walkDir(fullPath, results, depth + 1);
      } else if (entry.isFile()) {
        // Пропускаем игнорируемые файлы
        if (ProjectIndexer.IGNORE_FILES.has(entry.name)) { continue; }

        // Проверяем пользовательские exclude паттерны
        if (this.isExcluded(entry.name)) { continue; }

        const ext = path.extname(entry.name);
        if (!ProjectIndexer.SUPPORTED_EXTENSIONS.has(ext)) { continue; }

        // Пропускаем минифицированные файлы
        if (entry.name.endsWith('.min.js') || entry.name.endsWith('.min.css')) { continue; }
        if (entry.name.endsWith('.map')) { continue; }

        // Пропускаем слишком большие файлы (>100KB)
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 100 * 1024) { continue; }
          if (stat.size === 0) { continue; }
        } catch {
          continue;
        }

        results.push(fullPath);
      }
    }
  }

  private isExcluded(name: string): boolean {
    for (const pattern of this.config.excludePatterns) {
      if (!pattern) continue;
      // Convert basic glob to regex
      const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.');

      const regex = new RegExp(`^${regexPattern}$`, 'i');
      if (regex.test(name)) {
        return true;
      }
    }
    return false;
  }

  // ─── Разбиение файла на чанки ──────────────────────────

  private chunkFile(filePath: string): CodeChunk[] {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    if (!content.trim()) { return []; }

    const ext = path.extname(filePath);
    const language = this.getLanguageFromExt(ext);
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];

    // Попытка семантического разбиения
    const semanticChunks = this.extractSemanticChunks(content, language, filePath);

    if (semanticChunks.length > 0) {
      chunks.push(...semanticChunks);
    } else {
      // Fallback: оконное разбиение
      const windowSize = Math.min(this.config.chunkSize, 80);
      const overlap = Math.min(this.config.chunkOverlap, 10);

      for (let i = 0; i < lines.length; i += Math.max(windowSize - overlap, 1)) {
        const chunkLines = lines.slice(i, i + windowSize);
        const chunkContent = chunkLines.join('\n');

        if (chunkContent.trim().length < 10) { continue; }

        chunks.push({
          id: `${filePath}:${i}:${i + chunkLines.length}`,
          filePath,
          content: chunkContent,
          startLine: i,
          endLine: i + chunkLines.length,
          language,
          type: 'block',
          metadata: {},
        });
      }
    }

    // Обзорный чанк файла
    const overview = this.createFileOverview(content, filePath, language);
    if (overview) { chunks.push(overview); }

    return chunks;
  }

  private extractSemanticChunks(
    content: string,
    language: string,
    filePath: string
  ): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const lines = content.split('\n');

    const jsLangs = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];

    if (jsLangs.includes(language)) {
      const patterns = [
        { regex: /^(export\s+)?(async\s+)?function\s+(\w+)/gm, type: 'function' as const },
        { regex: /^(export\s+)?(default\s+)?class\s+(\w+)/gm, type: 'class' as const },
        { regex: /^(export\s+)?interface\s+(\w+)/gm, type: 'class' as const },
        { regex: /^(export\s+)?type\s+(\w+)/gm, type: 'class' as const },
        { regex: /^(export\s+)?const\s+(\w+)\s*=\s*(async\s+)?\(/gm, type: 'function' as const },
      ];

      const boundaries: { line: number; name: string; type: CodeChunk['type'] }[] = [];

      for (const { regex, type } of patterns) {
        let match;
        while ((match = regex.exec(content)) !== null) {
          const lineNum = content.substring(0, match.index).split('\n').length - 1;
          // Get the last capturing group that has a value
          const name = match[3] || match[2] || match[1] || 'anonymous';
          boundaries.push({ line: lineNum, name: name.trim(), type });
        }
      }

      boundaries.sort((a, b) => a.line - b.line);

      for (let i = 0; i < boundaries.length; i++) {
        const start = Math.max(0, boundaries[i].line - 2); // Include preceding comments
        const end = i < boundaries.length - 1
          ? boundaries[i + 1].line - 1
          : lines.length - 1;

        const chunkContent = lines.slice(start, end + 1).join('\n');
        if (chunkContent.trim().length < 10) { continue; }

        chunks.push({
          id: `${filePath}:${start}:${end}:${boundaries[i].name}`,
          filePath,
          content: chunkContent,
          startLine: start,
          endLine: end,
          language,
          type: boundaries[i].type,
          symbolName: boundaries[i].name,
          metadata: {},
        });
      }
    }

    if (language === 'python') {
      const pyPatterns = [
        { regex: /^(async\s+)?def\s+(\w+)/gm, type: 'function' as const },
        { regex: /^class\s+(\w+)/gm, type: 'class' as const },
      ];

      const boundaries: { line: number; name: string; type: CodeChunk['type'] }[] = [];

      for (const { regex, type } of pyPatterns) {
        let match;
        while ((match = regex.exec(content)) !== null) {
          const lineNum = content.substring(0, match.index).split('\n').length - 1;
          const name = match[2] || match[1] || 'anonymous';
          boundaries.push({ line: lineNum, name, type });
        }
      }

      boundaries.sort((a, b) => a.line - b.line);

      for (let i = 0; i < boundaries.length; i++) {
        const start = boundaries[i].line;
        const end = i < boundaries.length - 1
          ? boundaries[i + 1].line - 1
          : lines.length - 1;

        const chunkContent = lines.slice(start, end + 1).join('\n');
        if (chunkContent.trim().length < 10) { continue; }

        chunks.push({
          id: `${filePath}:${start}:${end}:${boundaries[i].name}`,
          filePath,
          content: chunkContent,
          startLine: start,
          endLine: end,
          language,
          type: boundaries[i].type,
          symbolName: boundaries[i].name,
          metadata: {},
        });
      }
    }

    return chunks;
  }

  private createFileOverview(
    content: string,
    filePath: string,
    language: string
  ): CodeChunk | null {
    const lines = content.split('\n');
    const imports: string[] = [];
    const exports: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('import ')) { imports.push(trimmed); }
      if (trimmed.startsWith('export ')) { exports.push(trimmed); }
      if (trimmed.startsWith('from ')) { imports.push(trimmed); }
      if (trimmed.startsWith('require(')) { imports.push(trimmed); }
      if (trimmed.startsWith('module.exports')) { exports.push(trimmed); }
    }

    if (imports.length === 0 && exports.length === 0) { return null; }

    const overviewContent = [
      `// File: ${filePath}`,
      `// Imports:`,
      ...imports.slice(0, 20),
      `// Exports:`,
      ...exports.slice(0, 20),
    ].join('\n');

    return {
      id: `${filePath}:overview`,
      filePath,
      content: overviewContent,
      startLine: 0,
      endLine: 0,
      language,
      type: 'module',
      symbolName: path.basename(filePath),
      metadata: {
        imports,
        exports,
        dependencies: this.extractDependencies(imports),
      },
    };
  }

  private extractDependencies(imports: string[]): string[] {
    const deps: string[] = [];
    for (const imp of imports) {
      const match = imp.match(/from\s+['"](.*?)['"]/);
      if (match) { deps.push(match[1]); }
      const reqMatch = imp.match(/require\(['"](.*?)['"]\)/);
      if (reqMatch) { deps.push(reqMatch[1]); }
    }
    return [...new Set(deps)];
  }

  private createEmbeddingText(chunk: CodeChunk): string {
    const parts = [
      `File: ${path.basename(chunk.filePath)}`,
      chunk.symbolName ? `Symbol: ${chunk.symbolName}` : '',
      `Type: ${chunk.type}`,
      `Language: ${chunk.language}`,
      chunk.content,
    ];
    return parts.filter(Boolean).join('\n');
  }

  private getLanguageFromExt(ext: string): string {
    const map: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescriptreact',
      '.js': 'javascript', '.jsx': 'javascriptreact',
      '.py': 'python', '.java': 'java', '.go': 'go',
      '.rs': 'rust', '.cpp': 'cpp', '.c': 'c',
      '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
      '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala',
      '.vue': 'vue', '.svelte': 'svelte',
      '.html': 'html', '.css': 'css', '.scss': 'scss',
      '.sql': 'sql', '.graphql': 'graphql',
      '.md': 'markdown', '.json': 'json',
      '.yaml': 'yaml', '.yml': 'yaml',
      '.xml': 'xml', '.toml': 'toml',
      '.proto': 'protobuf', '.h': 'c', '.hpp': 'cpp',
    };
    return map[ext] || 'plaintext';
  }
}
