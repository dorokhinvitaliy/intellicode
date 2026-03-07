import { LLMClient, ChatMessage } from '../llm/LLMClient';
import { AnalysisResult } from './AnalystAgent';

export interface CodeResult {
  code: string;
  language: string;
  filePath: string;
  explanation: string;
  insertPosition?: { line: number; character: number };
}

export class CoderAgent {
  private llmClient: LLMClient;

  private static SYSTEM_PROMPT = `You are the Coder Agent in a multi-agent development system.
You receive analysis from the Analyst Agent and generate high-quality code.

Rules:
1. Follow the project's coding style (naming, patterns)
2. Account for all dependencies and imports
3. Write clean, documented code
4. Use patterns identified by the analyst
5. Add JSDoc/docstring comments
6. Handle edge cases and errors

Generate ONLY code wrapped in \`\`\`.`;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  async generate(
    task: string,
    analysis: AnalysisResult,
    language: string,
    filePath: string
  ): Promise<CodeResult> {
    const styleExamples = analysis.contextChunks.slice(0, 3).join('\n---\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: CoderAgent.SYSTEM_PROMPT },
      {
        role: 'user',
        content: `## Task
${task}

## Analysis from Analyst Agent
- Approach: ${analysis.suggestedApproach}
- Affected files: ${analysis.affectedFiles.join(', ')}
- Dependencies: ${analysis.dependencies.join(', ')}
- Project patterns: ${analysis.codePatterns.join(', ')}
- Risks: ${analysis.risks.join(', ')}

## Code style examples from project
${styleExamples}

## Parameters
- Language: ${language}
- File: ${filePath}

Generate code:`,
      },
    ];

    const response = await this.llmClient.chat(messages, {
      temperature: 0.2,
      maxTokens: 4096,
    });

    const code = this.extractCode(response);

    return {
      code,
      language,
      filePath,
      explanation: this.extractExplanation(response),
    };
  }

  private extractCode(response: string): string {
    const match = response.match(/```(?:\w+)?\n([\s\S]*?)```/);
    return match ? match[1].trim() : response.trim();
  }

  private extractExplanation(response: string): string {
    const parts = response.split(/```/);
    return parts.length > 2 ? parts[parts.length - 1].trim() : '';
  }
}
