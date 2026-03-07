import { LLMClient, ChatMessage } from '../llm/LLMClient';
import { AnalysisResult } from './AnalystAgent';

export interface RefactorResult {
  refactoredCode: string;
  changes: RefactorChange[];
  explanation: string;
  pattern?: string;
}

export interface RefactorChange {
  type: 'add' | 'remove' | 'modify';
  description: string;
  before?: string;
  after?: string;
}

export class RefactorAgent {
  private llmClient: LLMClient;

  private static SYSTEM_PROMPT = `You are the Refactor Agent in a multi-agent development system.
You specialize in improving code quality and architecture.

Capabilities:
1. Applying design patterns (Strategy, Observer, Factory, etc.)
2. Simplifying complex code
3. Adding error handling and logging
4. Splitting large functions/classes
5. Improving naming
6. Eliminating code smells
7. Applying SOLID principles

Response in JSON format:
{
  "refactoredCode": "full refactored code",
  "changes": [
    {
      "type": "modify",
      "description": "Change description",
      "before": "was",
      "after": "became"
    }
  ],
  "explanation": "overall refactoring explanation",
  "pattern": "applied pattern (if any)"
}`;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  async refactor(
    code: string,
    instruction: string,
    analysis: AnalysisResult,
    language: string,
    filePath: string
  ): Promise<RefactorResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: RefactorAgent.SYSTEM_PROMPT },
      {
        role: 'user',
        content: `## Refactoring instruction
${instruction}

## Code to refactor
\`\`\`${language}
${code}
\`\`\`

## Analysis
- Project patterns: ${analysis.codePatterns.join(', ')}
- Dependencies: ${analysis.dependencies.join(', ')}
- Suggested approach: ${analysis.suggestedApproach}

## Parameters
- Language: ${language}
- File: ${filePath}

Perform refactoring and return JSON.`,
      },
    ];

    const response = await this.llmClient.chat(messages, {
      temperature: 0.2,
      maxTokens: 4096,
    });

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || '{}');
      return {
        refactoredCode: parsed.refactoredCode || code,
        changes: parsed.changes || [],
        explanation: parsed.explanation || '',
        pattern: parsed.pattern,
      };
    } catch {
      return {
        refactoredCode: this.extractCode(response) || code,
        changes: [],
        explanation: response,
      };
    }
  }

  private extractCode(response: string): string {
    const match = response.match(/```(?:\w+)?\n([\s\S]*?)```/);
    return match ? match[1].trim() : '';
  }
}
