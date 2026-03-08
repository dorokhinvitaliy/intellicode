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

  // Max chars per context fragment
  private static MAX_FRAGMENT_CHARS = 500;
  // Max total context chars
  private static MAX_CONTEXT_CHARS = 4000;
  // Max history entries (pairs of user+assistant)
  private static MAX_HISTORY = 6;
  // Max chars to store per assistant response in history
  private static MAX_HISTORY_RESPONSE = 200;

  private static SYSTEM_PROMPT = `You are IntelliCode — a coding agent inside VS Code.

CRITICAL: Before ANY action, you MUST think step by step in a <thinking> block:
<thinking>
1. What does the user want?
2. What do the PROJECT CONFIG FILES show? (read them carefully — they have real scripts)
3. Which specific file/script/command matches the request?
4. What is the exact command to run?
</thinking>

RULES:
1. QUESTION (explain, describe, what is, how) → TEXT answer only, no markers.
2. COMMAND (run, start, build, test, fix) → THINK first, then use markers.
3. ALWAYS read the PROJECT CONFIG FILES section — it has the real package.json scripts, pom.xml, etc.
4. Be CONCISE. 2-3 sentences + marker.
5. Answer in the SAME language as the user.
6. NEVER invent commands. If you don't see a script in the config files, use <<<READ_FILE>>> to check first.
7. DO NOT use docker-compose unless the user explicitly asks for docker.

MARKERS (only after thinking):
- Run: <<<EXECUTE command="command"/>>>
- Read file: <<<READ_FILE path="relative/path"/>>>
- Create: <<<CREATE_FILE path="p">>>content<<<END_FILE>>>
- Edit: <<<EDIT_FILE path="p">>>content<<<END_FILE>>>
- Delete: <<<DELETE_FILE path="p"/>>>

EXAMPLES:
User: запусти фронтенд
<thinking>
1. User wants to start frontend
2. PROJECT CONFIG shows front/package.json with scripts: {"dev": "vite"}
3. The right command is: cd front && npm run dev
</thinking>
<<<EXECUTE command="cd front && npm run dev"/>>>

User: запусти бэкенд
<thinking>
1. User wants to start backend
2. PROJECT CONFIG shows back/pom.xml exists → it's a Java/Maven project
3. The right command is: cd back && mvn spring-boot:run
</thinking>
<<<EXECUTE command="cd back && mvn spring-boot:run"/>>>`;

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
      ...this.conversationHistory.slice(-ChatHandler.MAX_HISTORY),
      {
        role: 'user',
        content: this.formatUserMessage(context, userMessage),
      },
    ];

    const response = await this.llmClient.chat(messages, {
      temperature: 0.3,
      maxTokens: 2048,
    });

    this.addToHistory(userMessage, response);
    return { response, relevantFiles, searchResults: filteredResults };
  }

  async *handleMessageStream(
    userMessage: string,
    topK: number = 15,
    retrievalQuery?: string,
    isFeedback: boolean = false
  ): AsyncGenerator<{
    type: 'context' | 'token' | 'done';
    data: string;
    relevantFiles?: string[];
  }> {
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
      ...this.conversationHistory.slice(-ChatHandler.MAX_HISTORY),
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

    if (!isFeedback) {
      this.addToHistory(userMessage, fullResponse);
    }

    yield { type: 'done', data: fullResponse };
  }

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

  clearHistory(): void {
    this.conversationHistory = [];
  }

  // ─── Private helpers ──────────────────────────────────────

  /**
   * USER QUERY GOES FIRST — 7B models pay most attention to the beginning.
   * Context comes after, clearly labeled as reference material.
   */
  private formatUserMessage(context: string, userMessage: string): string {
    // Separate config context (injected by SidebarChatProvider) from the user query
    const configSeparator = '\n\nPROJECT CONFIG FILES';
    let query = userMessage;
    let configBlock = '';

    const configIdx = userMessage.indexOf(configSeparator);
    if (configIdx !== -1) {
      query = userMessage.substring(0, configIdx).trim();
      configBlock = userMessage.substring(configIdx).trim();
    }

    // Structure: Query first → Config files → RAG code
    let result = `USER REQUEST: ${query}`;
    if (configBlock) {
      result += `\n\n${configBlock}`;
    }
    if (context && !context.startsWith('(No indexed')) {
      result += `\n\nREFERENCE CODE:\n${context}`;
    }
    return result;
  }

  /**
   * Truncate AI response before storing in history.
   * Full verbose responses eat the 7B model's context window.
   */
  private addToHistory(userMessage: string, aiResponse: string): void {
    // Strip markers from stored response
    const cleanResponse = aiResponse
      .replace(/<<<[\s\S]*?>>>/g, '')
      .replace(/<thinking[\s\S]*?<\/thinking>/gi, '')
      .trim();

    // Truncate to keep history slim
    const truncated = cleanResponse.length > ChatHandler.MAX_HISTORY_RESPONSE
      ? cleanResponse.substring(0, ChatHandler.MAX_HISTORY_RESPONSE) + '...'
      : cleanResponse;

    this.conversationHistory.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: truncated }
    );

    // Keep history bounded
    while (this.conversationHistory.length > ChatHandler.MAX_HISTORY) {
      this.conversationHistory.shift();
    }
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
        !fp.includes('.next/') &&
        !fp.includes('build/') &&
        !fp.includes('docker-compose') &&
        !fp.includes('compose-env') &&
        !fp.includes('.lock') &&
        !fp.includes('.env');
    });
  }

  /**
   * Build context with size limits to keep 7B model focused.
   */
  private buildContext(searchResults: SearchResult[]): string {
    if (searchResults.length === 0) {
      return '(No indexed code available. Run project indexing first.)';
    }

    let totalChars = 0;
    const fragments: string[] = [];

    for (const result of searchResults) {
      const chunk = result.chunk;
      // Truncate individual fragments
      let content = chunk.content;
      if (content.length > ChatHandler.MAX_FRAGMENT_CHARS) {
        content = content.substring(0, ChatHandler.MAX_FRAGMENT_CHARS) + '\n... (truncated)';
      }

      const fragment = `[${chunk.filePath}] (${chunk.type}${chunk.symbolName ? ': ' + chunk.symbolName : ''})\n${content}`;

      // Check total size limit
      if (totalChars + fragment.length > ChatHandler.MAX_CONTEXT_CHARS) {
        break;
      }

      fragments.push(fragment);
      totalChars += fragment.length;
    }

    return fragments.join('\n---\n');
  }

  private extractCodeBlock(text: string): string {
    const match = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
    return match ? match[1].trim() : text.trim();
  }
}
