import { LLMClient, ChatMessage } from '../llm/LLMClient';
import { VectorStore } from '../indexing/VectorStore';
import { AnalysisResult } from './AnalystAgent';

export interface TestResult {
  testCode: string;
  testFramework: string;
  testCount: number;
  scenarios: string[];
  filePath: string;
}

export class TesterAgent {
  private llmClient: LLMClient;
  private vectorStore: VectorStore;

  private static SYSTEM_PROMPT = `You are the Tester Agent in a multi-agent development system.
You receive code and analysis, and generate comprehensive unit tests.

Rules:
1. Use the appropriate framework (Jest for JS/TS, pytest for Python, etc.)
2. Cover happy path, edge cases, error cases
3. Use mocks for external dependencies
4. Write descriptive test names
5. Group tests logically (describe/context blocks)
6. Add setup/teardown where needed

Response in JSON format:
{
  "testFramework": "jest",
  "scenarios": ["scenario 1 description", "..."],
  "testCode": "full test code"
}`;

  constructor(llmClient: LLMClient, vectorStore: VectorStore) {
    this.llmClient = llmClient;
    this.vectorStore = vectorStore;
  }

  async generateTests(
    code: string,
    analysis: AnalysisResult,
    language: string,
    filePath: string
  ): Promise<TestResult> {
    // Find existing test patterns in the project
    const testQuery = await this.llmClient.createEmbedding('test describe it expect mock');
    const existingTests = await this.vectorStore.search(testQuery.embedding, 3);
    const testExamples = existingTests
      .map(r => r.chunk.content)
      .join('\n---\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: TesterAgent.SYSTEM_PROMPT },
      {
        role: 'user',
        content: `## Code to test
\`\`\`${language}
${code}
\`\`\`

## Analysis
- Dependencies to mock: ${analysis.dependencies.join(', ')}
- Risks: ${analysis.risks.join(', ')}

## Existing tests in project (for style reference)
${testExamples || 'No existing tests found'}

## Parameters
- Language: ${language}
- File: ${filePath}

Generate complete unit tests in JSON format.`,
      },
    ];

    const response = await this.llmClient.chat(messages, {
      temperature: 0.2,
      maxTokens: 4096,
    });

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || '{}');

      const testCode = parsed.testCode || this.extractCode(response);
      const scenarios = parsed.scenarios || [];

      return {
        testCode,
        testFramework: parsed.testFramework || this.detectFramework(language),
        testCount: (testCode.match(/it\(|test\(|def test_/g) || []).length,
        scenarios,
        filePath: this.getTestFilePath(filePath),
      };
    } catch {
      const testCode = this.extractCode(response);
      return {
        testCode,
        testFramework: this.detectFramework(language),
        testCount: (testCode.match(/it\(|test\(|def test_/g) || []).length,
        scenarios: [],
        filePath: this.getTestFilePath(filePath),
      };
    }
  }

  private extractCode(response: string): string {
    const match = response.match(/```(?:\w+)?\n([\s\S]*?)```/);
    return match ? match[1].trim() : response;
  }

  private detectFramework(language: string): string {
    const map: Record<string, string> = {
      typescript: 'jest', javascript: 'jest',
      python: 'pytest', java: 'junit',
      go: 'testing', rust: 'cargo test',
      csharp: 'xunit',
    };
    return map[language] || 'jest';
  }

  private getTestFilePath(filePath: string): string {
    const ext = filePath.match(/\.[^.]+$/)?.[0] || '.ts';
    return filePath.replace(ext, `.test${ext}`);
  }
}
