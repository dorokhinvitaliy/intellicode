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

  private static SYSTEM_PROMPT = `You are IntelliCode Fabric — an AI development assistant.
You have full access to the project codebase through a RAG system.

Your capabilities:
1. Answer questions about the project using real code context
2. Generate code that follows the project's style and patterns
3. Explain complex code
4. Suggest refactoring
5. Find bugs and vulnerabilities
6. Create and edit files (use special markers for file operations)

For file operations, use these markers:
- To create a file: <<<CREATE_FILE path="relative/path">>>content<<<END_FILE>>>
- To edit a file: <<<EDIT_FILE path="relative/path">>>new content<<<END_FILE>>>
- To delete a file: <<<DELETE_FILE path="relative/path"/>>>
- To run a command: <<<EXECUTE command="npm install express"/>>>

Rules:
- Always reference files and line numbers when discussing code
- Generate code that follows the project's coding style
- If context is insufficient, say so
- Use markdown formatting
- Wrap code in \`\`\` blocks with language identifier
- Answer in the same language the user writes in`;

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

  async handleMessage(userMessage: string): Promise<{
    response: string;
    relevantFiles: string[];
    searchResults: SearchResult[];
  }> {
    const queryEmbedding = await this.llmClient.createEmbedding(userMessage);
    const searchResults = await this.vectorStore.hybridSearch(
      queryEmbedding.embedding,
      userMessage,
      10
    );

    const context = this.buildContext(searchResults);
    const relevantFiles = [...new Set(searchResults.map(r => r.chunk.filePath))];

    const messages: ChatMessage[] = [
      { role: 'system', content: ChatHandler.SYSTEM_PROMPT },
      ...this.conversationHistory.slice(-10),
      {
        role: 'user',
        content: `Project codebase context:\n${context}\n\n---\n\nUser question: ${userMessage}`,
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

    return { response, relevantFiles, searchResults };
  }

  async *handleMessageStream(userMessage: string): AsyncGenerator<{
    type: 'context' | 'token' | 'done';
    data: string;
    relevantFiles?: string[];
  }> {
    const queryEmbedding = await this.llmClient.createEmbedding(userMessage);
    const searchResults = await this.vectorStore.hybridSearch(
      queryEmbedding.embedding,
      userMessage,
      10
    );

    const context = this.buildContext(searchResults);
    const relevantFiles = [...new Set(searchResults.map(r => r.chunk.filePath))];

    yield {
      type: 'context',
      data: `Found ${searchResults.length} relevant code fragments`,
      relevantFiles,
    };

    const messages: ChatMessage[] = [
      { role: 'system', content: ChatHandler.SYSTEM_PROMPT },
      ...this.conversationHistory.slice(-10),
      {
        role: 'user',
        content: `Project codebase context:\n${context}\n\n---\n\nUser question: ${userMessage}`,
      },
    ];

    let fullResponse = '';
    for await (const token of this.llmClient.chatStream(messages)) {
      fullResponse += token;
      yield { type: 'token', data: token };
    }

    this.conversationHistory.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: fullResponse }
    );

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

  private buildContext(searchResults: SearchResult[]): string {
    if (searchResults.length === 0) {
      return '(No indexed code context available. Run project indexing first.)';
    }

    return searchResults
      .map((result, i) => {
        const chunk = result.chunk;
        return `--- Fragment ${i + 1} (score: ${result.score.toFixed(3)}) ---\nFile: ${chunk.filePath} (lines ${chunk.startLine}-${chunk.endLine})\nType: ${chunk.type}${chunk.symbolName ? `, Name: ${chunk.symbolName}` : ''}\n\n${chunk.content}\n`;
      })
      .join('\n');
  }

  private extractCodeBlock(text: string): string {
    const match = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
    return match ? match[1].trim() : text.trim();
  }
}
