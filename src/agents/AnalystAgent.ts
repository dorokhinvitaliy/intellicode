import { LLMClient, ChatMessage } from '../llm/LLMClient';
import { VectorStore } from '../indexing/VectorStore';

export interface AnalysisResult {
  summary: string;
  affectedFiles: string[];
  dependencies: string[];
  risks: string[];
  suggestedApproach: string;
  codePatterns: string[];
  contextChunks: string[];
}

export class AnalystAgent {
  private llmClient: LLMClient;
  private vectorStore: VectorStore;

  private static SYSTEM_PROMPT = `You are the Analyst Agent in a multi-agent development system.
Your task is to deeply analyze the developer's request and existing code.

You must determine:
1. Which files and modules will be affected
2. Which dependencies need to be considered
3. What risks exist when making changes
4. What approach is best to use
5. What coding patterns are adopted in the project

Response in JSON format:
{
  "summary": "brief task analysis",
  "affectedFiles": ["file1.ts", "file2.ts"],
  "dependencies": ["module1", "module2"],
  "risks": ["risk1", "risk2"],
  "suggestedApproach": "approach description",
  "codePatterns": ["pattern1", "pattern2"]
}`;

  constructor(llmClient: LLMClient, vectorStore: VectorStore) {
    this.llmClient = llmClient;
    this.vectorStore = vectorStore;
  }

  async analyze(
    task: string,
    existingCode: string,
    language: string,
    filePath: string
  ): Promise<AnalysisResult> {
    const queryEmbedding = await this.llmClient.createEmbedding(
      `${task} ${existingCode.substring(0, 300)}`
    );
    const searchResults = await this.vectorStore.hybridSearch(
      queryEmbedding.embedding,
      task,
      8
    );

    const context = searchResults
      .map(r => `[${r.chunk.filePath}:${r.chunk.startLine}] ${r.chunk.content}`)
      .join('\n---\n');

    const depGraph = this.vectorStore.getDependencyGraph();
    const fileDeps = depGraph.get(filePath) || [];

    const messages: ChatMessage[] = [
      { role: 'system', content: AnalystAgent.SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Task: ${task}

Current file: ${filePath} (language: ${language})
File dependencies: ${fileDeps.join(', ') || 'none'}

Existing code:
\`\`\`${language}
${existingCode}
\`\`\`

Project context (from RAG):
${context || '(no indexed context available)'}

Analyze the task and return JSON.`,
      },
    ];

    const response = await this.llmClient.chat(messages, { temperature: 0.2 });

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || '{}');
      return {
        summary: parsed.summary || '',
        affectedFiles: parsed.affectedFiles || [filePath],
        dependencies: parsed.dependencies || fileDeps,
        risks: parsed.risks || [],
        suggestedApproach: parsed.suggestedApproach || '',
        codePatterns: parsed.codePatterns || [],
        contextChunks: searchResults.map(r => r.chunk.content),
      };
    } catch {
      return {
        summary: response,
        affectedFiles: [filePath],
        dependencies: fileDeps,
        risks: [],
        suggestedApproach: '',
        codePatterns: [],
        contextChunks: [],
      };
    }
  }
}
