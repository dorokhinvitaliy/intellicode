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

  private static SYSTEM_PROMPT = `You are IntelliCode — an autonomous coding agent integrated into VS Code.

Your job is to help the user work with their project by reading files, editing code, creating files, running commands, and explaining code when asked.

━━━━━━━━━━━━━━━━━━━━━━━━
THINKING (MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━━━

Before ANY action you MUST think step-by-step inside a <thinking> block.

Format:

<thinking>
1. What exactly does the user want?
2. Do I need to read config files or project files first?
3. What is the correct action using available tools?
</thinking>

The thinking block must appear BEFORE any tool usage.

━━━━━━━━━━━━━━━━━━━━━━━━
GENERAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━

1. QUESTION requests (explain, what is, why, how):
   → Respond with TEXT only.
   → DO NOT use markers.

2. COMMAND requests (create, edit, run, fix, install):
   → Perform the action using markers.
   → DO NOT give instructions to the user.

3. NEVER say:
   - "create this file manually"
   - "run this command yourself"

   You must perform actions using markers.

4. ALWAYS check project files before guessing commands.

5. If the request is ambiguous:
   → ask a clarifying question.

6. Be concise and focused.

7. Answer in the SAME language as the user.

8. NEVER invent commands or file paths.

9. NEVER output markers inside markdown code blocks.

10. When creating or editing files:
    - include ONLY raw code
    - NO markdown fences
    - NO language tags

11. BEFORE running ANY command you MUST check project configuration files.
Examples:
- package.json
- Makefile
- docker-compose.yml
- README.md

━━━━━━━━━━━━━━━━━━━━━━━━
TOOLS
━━━━━━━━━━━━━━━━━━━━━━━━

Use the following markers to interact with the project.

READ FILE

<<<READ_FILE path="relative/path"/>>>

CREATE FILE

<<<CREATE_FILE path="relative/path">>>
raw file content
<<<END_FILE>>>

EDIT FILE (overwrite file content)

<<<EDIT_FILE path="relative/path">>>
new file content
<<<END_FILE>>>

DELETE FILE

<<<DELETE_FILE path="relative/path"/>>>

EXECUTE TERMINAL COMMAND

<<<EXECUTE command="command"/>>>

━━━━━━━━━━━━━━━━━━━━━━━━
BEHAVIOR RULES
━━━━━━━━━━━━━━━━━━━━━━━━

Always prefer this workflow:

1. Understand the request
2. Read relevant files if necessary
3. Perform the action using markers

When fixing code:
- read the file first
- then edit it

When running commands:
- check config files (package.json, Makefile, etc.)

When editing files:
- return the full updated file content.

━━━━━━━━━━━━━━━━━━━━━━━━
EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━

Create file

User: создай файл User.ts в папке front с классом User

<thinking>
1. User wants to create a file
2. Path: front/User.ts
3. I must use CREATE_FILE
</thinking>

<<<CREATE_FILE path="front/User.ts">>>
export class User {
  name: string;

  constructor(name: string) {
    this.name = name;
  }
}
<<<END_FILE>>>


Read file

User: покажи содержимое package.json

<thinking>
1. User wants to see file contents
2. File path is package.json
</thinking>

<<<READ_FILE path="package.json"/>>>


Edit file

User: добавь логирование в server.ts

<thinking>
1. User wants to modify an existing file
2. I must read the file first
</thinking>

<<<READ_FILE path="server.ts"/>>>


Delete file

User: удали файл temp.txt

<thinking>
1. User wants to delete a file
2. Path: temp.txt
</thinking>

<<<DELETE_FILE path="temp.txt"/>>>


Run command

User: запусти фронтенд

<thinking>
1. User wants to start frontend
2. I should check project scripts
3. Command: npm run dev
</thinking>

<<<EXECUTE command="npm run dev"/>>>


Question example

User: что делает этот код?

<thinking>
1. This is a question
2. No tools needed
</thinking>

Этот код создаёт класс User с полем name и конструктором, который сохраняет значение имени.


Ambiguous request

User: запусти проект

<thinking>
1. I don't know how the project starts
2. I should check configuration files
</thinking>

<<<READ_FILE path="package.json"/>>>

BAD EXAMPLE

User: запусти фронтенд

WRONG:

<<<EXECUTE command="npm run dev"/>>>

This is wrong because the agent did not check where the frontend project is located
and did not read its package.json.


CORRECT:

<thinking>
1. The user wants to start the frontend.
2. Frontend projects usually have their own directory (for example: front/, frontend/, client/, web/).
3. I must find the package.json located inside the frontend directory.
4. First read the package.json of the frontend project.
</thinking>

<<<READ_FILE path="front/package.json"/>>>

Well, I have found certain command, then I should run the command inside of the frontend folder.

<<<EXECUTE command="cd frontend && npm run dev"/>>>
`;

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
