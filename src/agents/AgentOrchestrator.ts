import { LLMClient } from '../llm/LLMClient';
import { VectorStore } from '../indexing/VectorStore';
import { AnalystAgent, AnalysisResult } from './AnalystAgent';
import { CoderAgent, CodeResult } from './CoderAgent';
import { TesterAgent, TestResult } from './TesterAgent';
import { RefactorAgent, RefactorResult } from './RefactorAgent';

export interface OrchestratorResult {
  analysis: AnalysisResult;
  code?: CodeResult;
  tests?: TestResult;
  refactored?: RefactorResult;
  summary: string;
}

export class AgentOrchestrator {
  private analyst: AnalystAgent;
  private coder: CoderAgent;
  private tester: TesterAgent;
  private refactorAgent: RefactorAgent;

  constructor(llmClient: LLMClient, vectorStore: VectorStore) {
    this.analyst = new AnalystAgent(llmClient, vectorStore);
    this.coder = new CoderAgent(llmClient);
    this.tester = new TesterAgent(llmClient, vectorStore);
    this.refactorAgent = new RefactorAgent(llmClient);
  }

  async runFullPipeline(
    task: string,
    existingCode: string,
    language: string,
    filePath: string,
    onProgress?: (stage: string, message: string) => void
  ): Promise<OrchestratorResult> {
    onProgress?.('analyst', 'Analyzing task and existing code...');
    const analysis = await this.analyst.analyze(task, existingCode, language, filePath);

    onProgress?.('coder', 'Generating code based on analysis...');
    const code = await this.coder.generate(task, analysis, language, filePath);

    onProgress?.('tester', 'Generating unit tests...');
    const tests = await this.tester.generateTests(code.code, analysis, language, filePath);

    const summary = this.generateSummary(task, analysis, code, tests);

    return { analysis, code, tests, summary };
  }

  async runRefactorAgent(
    code: string,
    instruction: string,
    language: string,
    filePath: string
  ): Promise<RefactorResult> {
    const analysis = await this.analyst.analyze(instruction, code, language, filePath);
    return this.refactorAgent.refactor(code, instruction, analysis, language, filePath);
  }

  async runTestGeneratorAgent(
    code: string,
    language: string,
    filePath: string
  ): Promise<TestResult> {
    const analysis = await this.analyst.analyze(
      'Generate unit tests', code, language, filePath
    );
    return this.tester.generateTests(code, analysis, language, filePath);
  }

  async runCodeGenPipeline(
    task: string,
    context: string,
    language: string,
    filePath: string
  ): Promise<{ analysis: AnalysisResult; code: CodeResult }> {
    const analysis = await this.analyst.analyze(task, context, language, filePath);
    const code = await this.coder.generate(task, analysis, language, filePath);
    return { analysis, code };
  }

  private generateSummary(
    task: string,
    analysis: AnalysisResult,
    code: CodeResult,
    tests: TestResult
  ): string {
    return `## Task Result

**Task:** ${task}

### Analysis
${analysis.summary}

### Generated Code
- File: ${code.filePath}
- Affected files: ${analysis.affectedFiles.join(', ')}
- Risks: ${analysis.risks.join('; ') || 'None identified'}

### Tests
- Tests generated: ${tests.testCount}
- Coverage scenarios: ${tests.scenarios.join(', ')}
`;
  }
}
