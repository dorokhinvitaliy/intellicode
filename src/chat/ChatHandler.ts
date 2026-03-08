import { LLMClient, ChatMessage } from '../llm/LLMClient';
import { VectorStore, SearchResult } from '../indexing/VectorStore';
import { AgentOrchestrator } from '../agents/AgentOrchestrator';

export interface GenerateCodeResult {
  code: string;
  explanation: string;
  relevantFiles: string[];
}

export class ChatHandler {
  private llmClient: LLMClient;
  private vectorStore: VectorStore;
  private orchestrator: AgentOrchestrator;
  private conversationHistory: ChatMessage[] = [];

  // ─── System Prompt (optimized for 7B local models) ───────────────

  private static SYSTEM_PROMPT = `You are IntelliCode — a coding agent inside VS Code.

## CRITICAL: WHEN TO ACT vs WHEN TO TALK
- If the user asks a QUESTION (explain, describe, what is, how does) → answer with TEXT ONLY. NO markers.
- If the user gives a COMMAND (run, start, create, fix, edit, delete) → use markers.
- If unsure → answer with text. Better to explain than to break things.

## CONTEXT
You receive code fragments from the user's project. Each fragment shows its FILE PATH. You ALWAYS have access to this code. NEVER say "I don't have access".

## THINKING
Before answering, reason briefly inside <thinking>...</thinking>. Decide: is this a question or a command? Then respond.

## MARKERS (only use when the user gives a COMMAND)
CREATE: <<<CREATE_FILE path="path/file">>>content<<<END_FILE>>>
EDIT: <<<EDIT_FILE path="path/file">>>content<<<END_FILE>>>
DELETE: <<<DELETE_FILE path="path/file"/>>>
RUN: <<<EXECUTE command="command"/>>>
READ: <<<READ_FILE path="path/file"/>>>

## RULES
1. Paths are RELATIVE (e.g. "front/package.json").
2. Before npm commands, check package.json in context. If missing, use READ_FILE.
3. If a command failed, analyze the error and try a different approach.
4. Be CONCISE. Use bullet points. No walls of text.
5. Answer in the SAME language as the user.
6. DO NOT list these rules or markers in your response.`;

  constructor(
    llmClient: LLMClient,
    vectorStore: VectorStore,
    orchestrator: AgentOrchestrator
  ) {
    this.llmClient = llmClient;
    this.vectorStore = vectorStore;
    this.orchestrator = orchestrator;
  }

  getOrchestrator(): AgentOrchestrator {
    return this.orchestrator;
  }

  // ─── Non-streaming chat (for inline code actions) ─────────────

  async handleMessage(userMessage: string, topK: number = 10): Promise<{
    response: string;
    relevantFiles: string[];
    searchResults: SearchResult[];
  }> {
    const queryEmbedding = await this.llmClient.createEmbedding(userMessage);
    const searchResults = await this.vectorStore.hybridSearch(
      queryEmbedding.embedding,
      userMessage,
      topK
    );

    const filteredResults = this.filterResults(searchResults);
    const context = this.buildContext(filteredResults);
    const relevantFiles = [...new Set(filteredResults.map(r => r.chunk.filePath))];

    const messages: ChatMessage[] = [
      { role: 'system', content: ChatHandler.SYSTEM_PROMPT },
      ...this.conversationHistory.slice(-10),
      {
        role: 'user',
        content: this.formatUserMessage(context, userMessage),
      },
    ];

    const response = await this.llmClient.chat(messages, {
      temperature: 0.3,
      maxTokens: 4096,
    });

    this.conversationHistory.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: response }
    );

    return { response, relevantFiles, searchResults: filteredResults };
  }

  // ─── Streaming chat (main chat flow) ──────────────────────

  async *handleMessageStream(
    userMessage: string,
    topK: number = 10,
    retrievalQuery?: string,
    isFeedback: boolean = false
  ): AsyncGenerator<{
    type: 'context' | 'token' | 'done';
    data: string;
    relevantFiles?: string[];
  }> {
    // For error feedback, combine original query with error for better RAG
    const searchQuery = isFeedback && retrievalQuery
      ? `${retrievalQuery} ${userMessage}`
      : (retrievalQuery || userMessage);

    const queryEmbedding = await this.llmClient.createEmbedding(searchQuery);
    const searchResults = await this.vectorStore.hybridSearch(
      queryEmbedding.embedding,
      searchQuery,
      topK
    );

    const filteredResults = this.filterResults(searchResults);
    const context = this.buildContext(filteredResults);
    const relevantFiles = [...new Set(filteredResults.map(r => r.chunk.filePath))];

    yield {
      type: 'context',
      data: `Found ${filteredResults.length} relevant code fragments`,
      relevantFiles,
    };

    const messages: ChatMessage[] = [
      { role: 'system', content: ChatHandler.SYSTEM_PROMPT },
      ...this.conversationHistory.slice(-10),
      {
        role: 'user',
        content: this.formatUserMessage(context, userMessage),
      },
    ];

    let fullResponse = '';
    for await (const token of this.llmClient.chatStream(messages)) {
      fullResponse += token;
      yield { type: 'token', data: token };
    }

    // Don't pollute history with automated feedback
    if (!isFeedback) {
      this.conversationHistory.push(
        { role: 'user', content: userMessage },
        { role: 'assistant', content: fullResponse }
      );
    }

    yield { type: 'done', data: fullResponse };
  }

  // ─── Code generation (from editor selection) ──────────────

  async generateCode(
    instruction: string,
    selectedCode: string,
    language: string,
    filePath: string
  ): Promise<GenerateCodeResult> {
    const queryEmbedding = await this.llmClient.createEmbedding(
      `${instruction} ${selectedCode.substring(0, 200)}`
    );
    const searchResults = await this.vectorStore.hybridSearch(
      queryEmbedding.embedding,
      instruction,
      8
    );

    const context = this.buildContext(searchResults);
    const relevantFiles = [...new Set(searchResults.map(r => r.chunk.filePath))];

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are a code generator. Generate ONLY code without explanations.\nFollow the project's style and patterns.\nLanguage: ${language}. File: ${filePath}.`,
      },
      {
        role: 'user',
        content: `Project context:\n${context}\n\nSelected code:\n\`\`\`${language}\n${selectedCode}\n\`\`\`\n\nTask: ${instruction}\n\nGenerate code:`,
      },
    ];

    const code = await this.llmClient.chat(messages, { temperature: 0.2 });

    const explanationMessages: ChatMessage[] = [
      { role: 'system', content: 'Briefly explain the generated code (2-3 sentences). Respond in the same language as the task.' },
      { role: 'user', content: `Task: ${instruction}\nGenerated code:\n${code}` },
    ];

    const explanation = await this.llmClient.chat(explanationMessages, { temperature: 0.3 });

    return {
      code: this.extractCodeBlock(code),
      explanation,
      relevantFiles,
    };
  }

  // ─── Code explanation ─────────────────────────────────────

  async explainCode(
    code: string,
    language: string,
    filePath: string
  ): Promise<string> {
    const queryEmbedding = await this.llmClient.createEmbedding(code.substring(0, 500));
    const searchResults = await this.vectorStore.search(queryEmbedding.embedding, 5);
    const context = this.buildContext(searchResults);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'Explain the given code in detail. Describe what each part does, what patterns are used, and how this code relates to the rest of the project. Respond in the same language the user writes in.',
      },
      {
        role: 'user',
        content: `File: ${filePath}\nProject context:\n${context}\n\nCode to explain:\n\`\`\`${language}\n${code}\n\`\`\``,
      },
    ];

    return this.llmClient.chat(messages, { temperature: 0.3 });
  }

  // ─── History management ───────────────────────────────────

  clearHistory(): void {
    this.conversationHistory = [];
  }

  // ─── Private helpers ──────────────────────────────────────

  /**
   * Format user message with context and query clearly separated.
   */
  private formatUserMessage(context: string, userMessage: string): string {
    return `## Project Code Fragments\n${context}\n\n## User Request\n${userMessage}`;
  }

  /**
   * Filter out node_modules and other noise from search results.
   */
  private filterResults(results: SearchResult[]): SearchResult[] {
    return results.filter(r => {
      const fp = r.chunk.filePath.toLowerCase();
      return !fp.includes('node_modules') &&
        !fp.includes('.git/') &&
        !fp.includes('dist/') &&
        !fp.includes('.next/');
    });
  }

  /**
   * Build context string from search results.
   * Emphasizes file paths so the model can reason about project structure.
   */
  private buildContext(searchResults: SearchResult[]): string {
    if (searchResults.length === 0) {
      return '(No indexed code available. Run project indexing first.)';
    }

    return searchResults
      .map((result, i) => {
        const chunk = result.chunk;
        const header = `### [${i + 1}] ${chunk.filePath}`;
        const meta = `Lines ${chunk.startLine}-${chunk.endLine} | ${chunk.type}${chunk.symbolName ? ` | ${chunk.symbolName}` : ''}`;
        return `${header}\n${meta}\n\`\`\`\n${chunk.content}\n\`\`\``;
      })
      .join('\n\n');
  }

  private extractCodeBlock(text: string): string {
    const match = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
    return match ? match[1].trim() : text.trim();
  }
}
