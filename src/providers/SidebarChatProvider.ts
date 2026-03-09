import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChatHandler } from '../chat/ChatHandler';
import { ProjectIndexer } from '../indexing/ProjectIndexer';
import { FileOperationsHandler, FileOperation } from '../operations/FileOperationsHandler';

export class SidebarChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private chatHandler: ChatHandler;
  private indexer: ProjectIndexer;
  private fileOps: FileOperationsHandler;
  private feedbackDepth = 0;
  private lastUserQuery = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    chatHandler: ChatHandler,
    indexer: ProjectIndexer,
    fileOps: FileOperationsHandler
  ) {
    this.chatHandler = chatHandler;
    this.indexer = indexer;
    this.fileOps = fileOps;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'chat':
          this.feedbackDepth = 0;
          this.lastUserQuery = message.text;
          // Try smart command routing first (bypasses LLM for simple commands)
          if (!await this.trySmartRoute(message.text)) {
            await this.handleChatMessage(message.text);
          }
          break;
        case 'indexProject':
          vscode.commands.executeCommand('intellicodeFabric.indexProject');
          break;
        case 'clearHistory':
          this.chatHandler.clearHistory();
          this.postMessageToWebview({ type: 'historyCleared' });
          break;
        case 'insertCode': {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            editor.edit(editBuilder => {
              editBuilder.insert(editor.selection.active, message.code);
            });
          }
          break;
        }
        case 'copyCode':
          vscode.env.clipboard.writeText(message.code);
          vscode.window.showInformationMessage('Код скопирован в буфер обмена');
          break;
        case 'approveOperation':
          await this.handleFileOperation(message.operation);
          break;
        case 'openSettings':
          vscode.commands.executeCommand(
            'workbench.action.openSettings', 'intellicodeFabric'
          );
          break;
      }
    });
  }

  postMessageToWebview(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private async handleChatMessage(
    text: string,
    isFeedback: boolean = false
  ): Promise<void> {
    this.postMessageToWebview({ type: 'thinking', show: true });

    // Detect if this is a question (not a command) — if so, skip marker parsing
    const isQuestion = !isFeedback && this.isQuestionMessage(text);

    // For commands, inject project config files so the LLM can make informed decisions
    let enrichedText = text;
    if (!isQuestion && !isFeedback) {
      const configContext = this.getProjectConfigContext();
      if (configContext) {
        enrichedText = text + configContext;
      }
    }

    try {
      const retrievalQuery = isFeedback ? this.lastUserQuery : undefined;
      for await (const chunk of this.chatHandler.handleMessageStream(
        enrichedText, 10, retrievalQuery, isFeedback
      )) {
        switch (chunk.type) {
          case 'context':
            this.postMessageToWebview({
              type: 'context',
              message: chunk.data,
              files: chunk.relevantFiles,
            });
            break;
          case 'token':
            this.postMessageToWebview({ type: 'token', text: chunk.data });
            break;
          case 'done': {
            // Only parse markers for command-type messages, not questions
            if (!isQuestion) {
              const ops = this.fileOps.parseOperationsFromResponse(chunk.data);

              // Handle READ_FILE operations
              const readFileOps = this.parseReadFileOps(chunk.data);
              if (readFileOps.length > 0) {
                await this.handleReadFiles(readFileOps);
              }

              const actionOps = ops.filter(op => !(op.type === 'execute' && op.command?.startsWith('READ_FILE:')));
              if (actionOps.length > 0) {
                this.postMessageToWebview({
                  type: 'fileOperations',
                  operations: actionOps,
                });
              }
            }
            this.postMessageToWebview({ type: 'done' });
            break;
          }
        }
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.postMessageToWebview({
        type: 'error',
        message: errMsg,
      });
    }

    this.postMessageToWebview({ type: 'thinking', show: false });
  }

  /**
   * Parse <<<READ_FILE path="..."/>>> markers from AI response.
   */
  private parseReadFileOps(response: string): string[] {
    const paths: string[] = [];
    const regex = /<<<\s*READ_FILE\s+path="([^"]+)"\s*\/?>+/gi;
    let match;
    while ((match = regex.exec(response)) !== null) {
      paths.push(match[1]);
    }
    return paths;
  }

  /**
   * Smart command router: only handles terminal management.
   * For actual commands, falls through to LLM with injected project config.
   */
  private async trySmartRoute(text: string): Promise<boolean> {
    const lower = text.toLowerCase().trim();

    // Only handle stop/kill commands
    const stopPatterns = [
      'останови', 'остановить', 'стоп', 'убей', 'закрой', 'выключи',
      'stop', 'kill', 'terminate', 'shut down', 'shutdown',
    ];
    const isStopCommand = stopPatterns.some(p => lower.startsWith(p) || lower.includes(p));
    if (isStopCommand) {
      this.postMessageToWebview({ type: 'context', message: 'Stopping...', files: [] });

      // Kill IntelliCode terminals
      const terminals = vscode.window.terminals.filter(
        t => t.name.startsWith('IntelliCode:')
      );
      // Kill tracked background processes (spawn)
      const killedProcesses = this.fileOps.killAllProcesses();
      const messages: string[] = [];
      if (terminals.length > 0) {
        for (const t of terminals) {
          t.dispose();
        }
      }
      const totalKilled = terminals.length + killedProcesses;
      if (totalKilled > 0) {
        messages.push(`Остановлено ${totalKilled} процесс(ов).`);
      }

      // Only offer docker-compose if:
      // - No terminals were killed (so user isn't asking about npm processes)
      // - OR user explicitly mentions docker/контейнер/бэк/всё
      const dockerKeywords = ['docker', 'контейнер', 'compose', 'бэк', 'back', 'сервер', 'server', 'всё', 'все', 'all'];
      const wantsDocker = dockerKeywords.some(kw => lower.includes(kw));
      const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const hasCompose = rootPath && (
        fs.existsSync(path.join(rootPath, 'docker-compose.yml')) ||
        fs.existsSync(path.join(rootPath, 'docker-compose.yaml'))
      );

      if (hasCompose && (wantsDocker || terminals.length === 0)) {
        this.postMessageToWebview({
          type: 'token',
          text: (messages.length > 0 ? messages.join('\n') + '\n\n' : '') + 'Найден `docker-compose.yml`. Остановить контейнеры?\n',
        });
        this.postMessageToWebview({
          type: 'fileOperations',
          operations: [{
            type: 'execute',
            command: 'docker-compose down',
            description: 'Остановить Docker контейнеры: docker-compose down',
          }],
        });
      } else if (messages.length > 0) {
        this.postMessageToWebview({ type: 'token', text: messages.join('\n') });
      } else {
        this.postMessageToWebview({
          type: 'token',
          text: 'Нет запущенных процессов для остановки.',
        });
      }
      this.postMessageToWebview({ type: 'done' });
      return true;
    }

    // Everything else → LLM with project config context
    return false;
  }

  /**
   * Scan workspace for project config files and return their contents.
   * This gives the LLM real data to decide which commands to run.
   */
  private getProjectConfigContext(): string {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (!rootPath) return '';

    const configs: string[] = [];

    // Config files — ordered by priority: project configs first, infra last
    // (7B models fixate on first thing they see)
    const configFiles = [
      'package.json', 'pom.xml', 'build.gradle', 'Makefile',
      'requirements.txt', 'docker-compose.yml', 'docker-compose.yaml',
    ];

    // Scan root + first-level subdirectories
    const dirsToScan = ['.'];
    try {
      const entries = fs.readdirSync(rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          dirsToScan.push(entry.name);
        }
      }
    } catch { /* ignore */ }

    for (const dir of dirsToScan) {
      for (const configFile of configFiles) {
        const configPath = path.join(rootPath, dir, configFile);
        if (fs.existsSync(configPath)) {
          try {
            let content = fs.readFileSync(configPath, 'utf-8');
            const relPath = dir === '.' ? configFile : `${dir}/${configFile}`;

            // For package.json, extract only name + scripts (skip dependencies bloat)
            if (configFile === 'package.json') {
              try {
                const pkg = JSON.parse(content);
                const slim: Record<string, unknown> = { name: pkg.name };
                if (pkg.scripts) slim.scripts = pkg.scripts;
                content = JSON.stringify(slim, null, 2);
              } catch { /* use raw if parse fails */ }
            }

            // For docker-compose, extract only service names + ports
            if (configFile.startsWith('docker-compose')) {
              const serviceLines = content.split('\n').filter(
                l => /^\s{2}\w/.test(l) || l.includes('ports:') || /^\s{6}-\s/.test(l)
              );
              if (serviceLines.length > 0) {
                content = 'services:\n' + serviceLines.join('\n');
              }
            }

            // Truncate to keep context focused
            if (content.length > 300) {
              content = content.substring(0, 300) + '\n...(truncated)';
            }

            configs.push(`[${relPath}]\n${content}`);
          } catch { /* skip unreadable */ }
        }
      }
    }

    return configs.length > 0
      ? '\n\nPROJECT CONFIG FILES (use these to determine the correct commands):\n' + configs.join('\n---\n')
      : '';
  }

  /**
   * Detect if user message is a question (not a command).
   * Questions should get text-only answers, no markers.
   */
  private isQuestionMessage(text: string): boolean {
    const lower = text.toLowerCase().trim();
    // Question patterns in Russian and English
    const questionPatterns = [
      'объясни', 'расскажи', 'опиши', 'что такое', 'что это',
      'как работает', 'как устроен', 'покажи структуру', 'какая структура',
      'зачем', 'почему', 'сколько', 'какие', 'какой', 'где ',
      'explain', 'describe', 'what is', 'what are', 'how does',
      'how do', 'tell me', 'show me', 'why ', 'where ',
    ];
    if (lower.includes('?')) return true;
    return questionPatterns.some(p => lower.startsWith(p) || lower.includes(' ' + p));
  }

  /**
   * Read files from disk and send their contents back to the AI.
   */
  private async handleReadFiles(filePaths: string[]): Promise<void> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const fileContents: string[] = [];

    for (const fp of filePaths) {
      const fullPath = path.join(rootPath, fp);
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          fileContents.push(`File: ${fp}\n\`\`\`\n${content}\n\`\`\``);
        } else {
          fileContents.push(`File: ${fp} — NOT FOUND`);
        }
      } catch {
        fileContents.push(`File: ${fp} — READ ERROR`);
      }
    }

    if (fileContents.length > 0 && this.feedbackDepth < 2) {
      this.feedbackDepth++;
      const feedback = `Here are the requested file contents:\n\n${fileContents.join('\n\n')}\n\nNow complete the original task using this information.`;
      await this.handleChatMessage(feedback, true);
    }
  }

  private async handleFileOperation(operation: FileOperation): Promise<void> {
    const result = await this.fileOps.executeDirect(operation);
    this.postMessageToWebview({
      type: 'operationResult',
      result,
    });

    // Show command output in chat if available
    if (result.output && operation.type === 'execute') {
      const displayOutput = result.output.length > 2000
        ? result.output.substring(0, 2000) + '\n... (truncated)'
        : result.output;

      this.postMessageToWebview({
        type: 'commandOutput',
        output: displayOutput,
        command: operation.command || '',
        success: result.success,
      });

      // AI commentary — fire-and-forget
      if (this.feedbackDepth < 1) {
        this.feedbackDepth++;
        const truncatedForAI = result.output.substring(0, 1000);
        const statusWord = result.success ? 'completed successfully' : 'failed';
        const commentary = `Command \`${operation.command}\` ${statusWord}. Output:\n\`\`\`\n${truncatedForAI}\n\`\`\`\nBriefly explain to the user what happened. If there's an error, explain the cause and suggest a fix. Be concise — 2-3 sentences max.`;
        this.handleChatMessage(commentary, true).catch(() => { });
      }
    } else {
      // Re-index if file was created/edited
      if (result.success && operation.filePath && operation.type !== 'delete') {
        const stats = this.indexer.getStats();
        if (stats.lastIndexed) {
          await this.indexer.indexFile(
            path.join(
              vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
              operation.filePath
            )
          );
        }
      }

      // Error feedback — fire-and-forget
      if (!result.success && this.feedbackDepth < 1) {
        this.feedbackDepth++;
        const errorFeedback = `Operation failed: ${result.message}\n\nAnalyze this error and try a different approach.`;
        this.handleChatMessage(errorFeedback, true).catch(() => { });
      }
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IntelliCode Fabric</title>
  <style>
    :root {
      --bg-primary: var(--vscode-sideBar-background);
      --bg-secondary: var(--vscode-editor-background);
      --bg-input: var(--vscode-input-background);
      --fg: var(--vscode-foreground);
      --fg-dim: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-button-background);
      --accent-hover: var(--vscode-button-hoverBackground);
      --accent-fg: var(--vscode-button-foreground);
      --hover-bg: var(--vscode-toolbar-hoverBackground);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --code-bg: var(--vscode-textCodeBlock-background);
      --focus-border: var(--vscode-focusBorder);
      --error: var(--vscode-errorForeground, #f44747);
      --success: #4ec9b0;
      --warn: #cca700;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg-primary);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ─── Header ─── */
    .header {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .header-logo {
      width: 20px; height: 20px;
      fill: none; stroke: var(--accent); stroke-width: 2;
    }
    .header h2 {
      font-size: 12px; font-weight: 600;
      flex: 1; letter-spacing: 0.3px;
      text-transform: uppercase;
    }
    .header-btn {
      background: none; border: none;
      color: var(--fg-dim); cursor: pointer;
      padding: 4px; border-radius: 4px;
      display: flex; align-items: center; justify-content: center;
      width: 26px; height: 26px;
    }
    .header-btn:hover { background: var(--hover-bg); color: var(--fg); }
    .header-btn svg { width: 16px; height: 16px; }

    /* ─── Messages area ─── */
    .messages {
      flex: 1; overflow-y: auto; padding: 12px;
      scroll-behavior: smooth;
    }
    .messages::-webkit-scrollbar { width: 6px; }
    .messages::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.15); border-radius: 3px;
    }

    /* ─── Message ─── */
    .message {
      margin-bottom: 16px;
      animation: slideIn 0.25s ease;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .msg-header {
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 6px;
    }
    .msg-icon {
      width: 16px; height: 16px; flex-shrink: 0;
    }
    .msg-icon-user { fill: none; stroke: #4fc1ff; stroke-width: 2; }
    .msg-icon-ai { fill: none; stroke: #c586c0; stroke-width: 2; }
    .msg-role {
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .msg-role-user { color: #4fc1ff; }
    .msg-role-ai { color: #c586c0; }

    /* ─── Message content (rendered markdown) ─── */
    .msg-content {
      font-size: 13px; line-height: 1.6;
      word-wrap: break-word;
    }
    .msg-content p { margin-bottom: 8px; }
    .msg-content p:last-child { margin-bottom: 0; }
    .msg-content strong { font-weight: 600; color: var(--fg); }
    .msg-content em { font-style: italic; }
    .msg-content h1, .msg-content h2, .msg-content h3 {
      margin: 12px 0 6px 0; font-weight: 600;
    }
    .msg-content h1 { font-size: 16px; }
    .msg-content h2 { font-size: 14px; }
    .msg-content h3 { font-size: 13px; }
    .msg-content ul, .msg-content ol {
      margin: 4px 0 8px 16px;
    }
    .msg-content li { margin-bottom: 3px; }
    .msg-content a {
      color: var(--accent); text-decoration: none;
    }
    .msg-content a:hover { text-decoration: underline; }
    .msg-content blockquote {
      border-left: 3px solid var(--accent);
      padding: 4px 12px; margin: 8px 0;
      color: var(--fg-dim); font-style: italic;
    }

    /* ─── Inline code ─── */
    .msg-content code:not(.code-block-code) {
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      background: var(--code-bg);
      padding: 2px 5px; border-radius: 3px; font-size: 12px;
    }

    /* ─── Code blocks ─── */
    .code-block-wrapper {
      position: relative; margin: 8px 0;
      border-radius: 6px; overflow: hidden;
      background: var(--code-bg);
      border: 1px solid var(--border);
    }
    .code-block-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 10px;
      background: rgba(255,255,255,0.04);
      border-bottom: 1px solid var(--border);
      font-size: 11px; color: var(--fg-dim);
    }
    .code-block-lang {
      font-family: var(--vscode-editor-font-family);
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .code-block-actions { display: flex; gap: 4px; }
    .code-btn {
      font-size: 10px; padding: 2px 8px;
      background: rgba(255,255,255,0.08);
      color: var(--fg-dim); border: none;
      border-radius: 3px; cursor: pointer;
      display: flex; align-items: center; gap: 4px;
    }
    .code-btn:hover { background: rgba(255,255,255,0.14); color: var(--fg); }
    .code-btn svg { width: 12px; height: 12px; }
    .code-block-body {
      padding: 10px 12px; overflow-x: auto;
    }
    .code-block-body pre {
      margin: 0; background: none;
    }
    .code-block-code {
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: 12px; line-height: 1.5;
      white-space: pre; background: none; padding: 0;
    }

    /* ─── Context info ─── */
    .context-info {
      font-size: 11px; color: var(--fg-dim);
      padding: 6px 10px; margin-bottom: 8px;
      background: rgba(255,255,255,0.04);
      border-radius: 4px; border-left: 3px solid var(--accent);
      display: flex; align-items: center; gap: 6px;
    }
    .context-info svg { width: 14px; height: 14px; flex-shrink: 0; }
    .context-files { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .context-file {
      font-size: 10px; padding: 2px 6px;
      background: var(--badge-bg); color: var(--badge-fg);
      border-radius: 3px; font-family: var(--vscode-editor-font-family);
    }

    /* ─── File operations approval ─── */
    .file-ops {
      margin: 8px 0; padding: 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .file-ops-title {
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.5px;
      margin-bottom: 8px; display: flex; align-items: center; gap: 6px;
      color: var(--warn);
    }
    .file-ops-title svg { width: 14px; height: 14px; }
    .file-op-item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; margin-bottom: 4px;
      background: rgba(255,255,255,0.03);
      border-radius: 4px; border: 1px solid rgba(255,255,255,0.06);
    }
    .file-op-icon { width: 14px; height: 14px; flex-shrink: 0; }
    .file-op-icon-create { stroke: var(--success); }
    .file-op-icon-edit { stroke: #4fc1ff; }
    .file-op-icon-delete { stroke: var(--error); }
    .file-op-icon-execute { stroke: var(--warn); }
    .file-op-desc { flex: 1; font-size: 12px; }
    .file-op-approve, .file-op-reject {
      padding: 3px 10px; font-size: 11px; border: none;
      border-radius: 3px; cursor: pointer;
    }
    .file-op-approve {
      background: var(--success); color: #000; font-weight: 600;
    }
    .file-op-approve:hover { filter: brightness(1.15); }
    .file-op-reject {
      background: rgba(255,255,255,0.1); color: var(--fg-dim);
    }
    .file-op-reject:hover { background: rgba(255,255,255,0.15); }

    /* ─── Operation result ─── */
    .op-result {
      font-size: 11px; padding: 6px 10px; margin: 4px 0;
      border-radius: 4px; display: flex; align-items: center; gap: 6px;
    }
    .op-result svg { width: 14px; height: 14px; flex-shrink: 0; }
    .op-result-success {
      background: rgba(78, 201, 176, 0.12);
      border-left: 3px solid var(--success);
      color: var(--success);
    }
    .op-result-error {
      background: rgba(244, 71, 71, 0.12);
      border-left: 3px solid var(--error);
      color: var(--error);
    }

    /* ─── Command output ─── */
    .cmd-output {
      margin: 6px 0;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .cmd-output-header {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px;
      font-size: 11px; font-weight: 600;
      background: rgba(255,255,255,0.04);
      cursor: pointer; user-select: none;
    }
    .cmd-output-header svg { width: 12px; height: 12px; flex-shrink: 0; }
    .cmd-output-success .cmd-output-header { color: var(--success); border-left: 3px solid var(--success); }
    .cmd-output-error .cmd-output-header { color: var(--error); border-left: 3px solid var(--error); }
    .cmd-output-body {
      padding: 8px 10px;
      font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
      font-size: 11px;
      line-height: 1.4;
      background: rgba(0,0,0,0.3);
      color: var(--fg-dim);
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .cmd-output-cmd {
      font-size: 10px; color: var(--fg-dim); opacity: 0.7;
      margin-left: auto;
    }

    /* ─── Thinking indicator ─── */
    .thinking {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; color: var(--fg-dim); font-size: 12px;
      flex-shrink: 0;
    }
    .thinking-dots { display: flex; gap: 3px; }
    .thinking-dots span {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--accent);
      animation: pulse 1.4s infinite both;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes pulse {
      0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }

    /* ─── Input area ─── */
    .input-area {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .input-wrapper { display: flex; gap: 8px; }
    textarea {
      flex: 1;
      background: var(--bg-input);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      resize: none;
      min-height: 38px;
      max-height: 120px;
      line-height: 1.4;
    }
    textarea:focus { outline: none; border-color: var(--focus-border); }
    textarea::placeholder { color: var(--fg-dim); }
    .send-btn {
      background: var(--accent);
      color: var(--accent-fg);
      border: none; border-radius: 6px;
      padding: 0 14px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    .send-btn:hover { background: var(--accent-hover); }
    .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .send-btn svg { width: 18px; height: 18px; }

    /* ─── Welcome ─── */
    .welcome {
      text-align: center; padding: 20px 16px;
      color: var(--fg-dim);
    }
    .welcome-icon { margin-bottom: 12px; }
    .welcome-icon svg { width: 40px; height: 40px; stroke: var(--accent); }
    .welcome h3 { font-size: 14px; color: var(--fg); margin-bottom: 6px; }
    .welcome p { font-size: 12px; line-height: 1.5; margin-bottom: 12px; }
    .welcome-actions { display: flex; flex-direction: column; gap: 6px; }
    .welcome-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--border);
      color: var(--fg); border-radius: 4px;
      padding: 8px 12px; cursor: pointer; font-size: 12px;
      text-align: left; display: flex; align-items: center; gap: 8px;
      transition: background 0.15s;
    }
    .welcome-btn:hover { background: rgba(255,255,255,0.1); }
    .welcome-btn svg { width: 14px; height: 14px; flex-shrink: 0; }
    /* ─── Thinking block (collapsible) ─── */
    .thinking-block {
      margin: 8px 0;
      border: 1px solid rgba(197, 134, 192, 0.25);
      border-radius: 6px;
      background: rgba(197, 134, 192, 0.06);
      overflow: hidden;
    }
    .thinking-block summary {
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 600;
      color: #c586c0;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .thinking-block summary:hover {
      background: rgba(197, 134, 192, 0.1);
    }
    .thinking-block .thinking-content {
      padding: 6px 12px 10px;
      font-size: 12px;
      color: var(--fg-dim);
      border-top: 1px solid rgba(197, 134, 192, 0.15);
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="header">
    <svg class="header-logo" viewBox="0 0 24 24">
      <path d="M12 2L2 7l10 5 10-5-10-5z" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M2 17l10 5 10-5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M2 12l10 5 10-5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <h2>IntelliCode Fabric</h2>
    <button class="header-btn" onclick="indexProject()" title="Переиндексировать проект">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 1 1-6.22-8.56"/>
        <polyline points="21 3 21 9 15 9"/>
      </svg>
    </button>
    <button class="header-btn" onclick="openSettings()" title="Настройки">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
      </svg>
    </button>
    <button class="header-btn" onclick="clearHistory()" title="Очистить чат">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>
    </button>
  </div>

  <div class="messages" id="messages">
    <div class="welcome" id="welcome">
      <div class="welcome-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
          <path d="M2 17l10 5 10-5"/>
          <path d="M2 12l10 5 10-5"/>
        </svg>
      </div>
      <h3>IntelliCode Fabric</h3>
      <p>AI-ассистент с полным доступом к кодовой базе проекта. Задавайте вопросы, генерируйте код, рефакторьте.</p>
      <div class="welcome-actions">
        <button class="welcome-btn" onclick="indexProject()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          Индексировать проект
        </button>
        <button class="welcome-btn" onclick="insertPrompt('Объясни структуру этого проекта')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          Объясни структуру проекта
        </button>
        <button class="welcome-btn" onclick="openSettings()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          Настроить LLM провайдер
        </button>
      </div>
    </div>
  </div>

  <div class="thinking" id="thinking" style="display:none">
    <div class="thinking-dots"><span></span><span></span><span></span></div>
    <span>Анализирую запрос...</span>
  </div>

  <div class="input-area">
    <div class="input-wrapper">
      <textarea id="input" placeholder="Спросите о проекте..." rows="1"
        onkeydown="handleKeyDown(event)" oninput="autoResize(this)"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Отправить (Enter)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const thinkingEl = document.getElementById('thinking');
    const sendBtn = document.getElementById('sendBtn');
    const welcomeEl = document.getElementById('welcome');
    let currentAssistantEl = null;
    let currentAssistantText = '';
    let isStreaming = false;

    // ─── Markdown Parser ────────────────────────────

    function stripFileOpMarkers(text) {
      // Build chars to avoid breaking HTML parsing
      var L = String.fromCharCode(60);
      var R = String.fromCharCode(62);
      var S = String.fromCharCode(92) + 's'; // \s for regex
      var SS = String.fromCharCode(92) + 'S'; // \S for regex
      var SL = String.fromCharCode(92) + '/'; // \/ for regex
      // CREATE_FILE and EDIT_FILE blocks (with content)
      text = text.replace(new RegExp(L + '{1,}' + S + '*(?:CREATE|EDIT)_FILE' + S + '+path="[^"]*"' + S + '*' + R + '{2,}[' + S + SS + ']*?(?:' + L + '{1,}' + S + '*(?:END_FILE|/(?:CREATE|EDIT)_FILE)' + S + '*' + R + '{2,}|$)', 'gi'), '');
      // DELETE_FILE
      text = text.replace(new RegExp(L + '{1,}' + S + '*DELETE_FILE' + S + '+path="[^"]*"' + S + '*' + SL + '?' + S + '*' + R + '{1,}', 'gi'), '');
      // EXECUTE
      text = text.replace(new RegExp(L + '{1,}' + S + '*EXECUTE' + S + '+command="[^"]*"' + S + '*' + SL + '?' + S + '*' + R + '{1,}', 'gi'), '');
      // READ_FILE
      text = text.replace(new RegExp(L + '{1,}' + S + '*READ_FILE' + S + '+path="[^"]*"' + S + '*' + SL + '?' + S + '*' + R + '{1,}', 'gi'), '');
      // END_FILE orphans
      text = text.replace(new RegExp(L + '{1,}' + S + '*(?:END_FILE|/(?:CREATE|EDIT)_FILE)' + S + '*' + R + '{1,}', 'gi'), '');
      // XML-style closing: </CREATE_FILE>
      text = text.replace(new RegExp(L + '/(?:CREATE_FILE|EDIT_FILE|DELETE_FILE|EXECUTE|READ_FILE|END_FILE)' + S + '*' + R, 'gi'), '');
      // Partial markers at end of stream
      text = text.replace(new RegExp(L + '{1,}' + S + '*(?:CREATE_FILE|EDIT_FILE|DELETE_FILE|EXECUTE|READ_FILE)[^' + R + ']*$', 'gi'), '');
      // Stray << or <<<
      text = text.replace(new RegExp(L + '{2,}' + S + '*$', 'g'), '');
      return text.trim();
    }

    function renderMarkdown(text) {
      // Strip file operation markers before rendering
      text = stripFileOpMarkers(text);

      // Handle <thinking> blocks using indexOf (no regex escaping issues)
      var L = String.fromCharCode(60);
      var R = String.fromCharCode(62);
      var thinkOpen = L + 'thinking' + R;
      var thinkClose = L + '/thinking' + R;
      var thinkingHtml = '';
      var visibleText = text;

      var tStart = text.toLowerCase().indexOf(thinkOpen.toLowerCase());
      if (tStart !== -1) {
        var tEnd = text.toLowerCase().indexOf(thinkClose.toLowerCase(), tStart);
        if (tEnd !== -1) {
          // Closed thinking block
          var before = text.substring(0, tStart);
          var thinkContent = text.substring(tStart + thinkOpen.length, tEnd);
          var after = text.substring(tEnd + thinkClose.length);
          thinkingHtml = L + 'details class="thinking-block"' + R + L + 'summary' + R + String.fromCharCode(0xD83D, 0xDCAD) + ' Reasoning' + L + '/summary' + R + L + 'div class="thinking-content"' + R + escapeHtml(thinkContent.trim()) + L + '/div' + R + L + '/details' + R;
          visibleText = before + after;
        } else {
          // Unclosed thinking block (streaming)
          var before2 = text.substring(0, tStart);
          var thinkContent2 = text.substring(tStart + thinkOpen.length);
          thinkingHtml = L + 'details class="thinking-block" open' + R + L + 'summary' + R + String.fromCharCode(0xD83D, 0xDCAD) + ' Reasoning...' + L + '/summary' + R + L + 'div class="thinking-content"' + R + escapeHtml(thinkContent2.trim()) + L + '/div' + R + L + '/details' + R;
          visibleText = before2;
        }
      }

      // Escape HTML for the visible part
      var html = escapeHtml(visibleText);

      // Prepend thinking block
      if (thinkingHtml) {
        html = thinkingHtml + html;
      }


      // Code blocks: \`\`\`lang\\n...\\n\`\`\`
      html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(match, lang, code) {
        var langLabel = lang || 'code';
        return '<div class="code-block-wrapper">' +
          '<div class="code-block-header">' +
            '<span class="code-block-lang">' + langLabel + '</span>' +
            '<div class="code-block-actions">' +
              '<button class="code-btn" onclick="copyCodeBlock(this)" title="Копировать">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                ' Copy' +
              '</button>' +
              '<button class="code-btn" onclick="insertCodeBlock(this)" title="Вставить в редактор">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg>' +
                ' Insert' +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div class="code-block-body"><pre><code class="code-block-code">' + code + '</code></pre></div>' +
        '</div>';
      });

      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

      // Headers
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

      // Bold & italic
      html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');

      // Blockquotes
      html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

      // Unordered lists
      html = html.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\\/li>)/gs, '<ul>$1</ul>');
      // Fix nested <ul> wrapping
      html = html.replace(/<\\/ul>\\s*<ul>/g, '');

      // Ordered lists
      html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');

      // Links
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');

      // Horizontal rule
      html = html.replace(/^---$/gm, '<hr/>');

      // Paragraphs: wrap remaining bare lines
      html = html.replace(/^(?!<[hupoldbia]|<\\/|<hr|<div|<blockquote)(.+)$/gm, '<p>$1</p>');

      // Clean up empty paragraphs
      html = html.replace(/<p>\\s*<\\/p>/g, '');

      return html;
    }

    // ─── SVG Icon helpers ────────────────────────────

    var SVG_USER = '<svg class="msg-icon msg-icon-user" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    var SVG_AI = '<svg class="msg-icon msg-icon-ai" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
    var SVG_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>';

    // ─── Messages ────────────────────────────

    function sendMessage() {
      var text = inputEl.value.trim();
      if (!text || isStreaming) return;
      if (welcomeEl) welcomeEl.style.display = 'none';
      addMessage('user', text);
      inputEl.value = '';
      inputEl.style.height = '38px';
      isStreaming = true;
      sendBtn.disabled = true;
      vscode.postMessage({ type: 'chat', text: text });
    }

    function handleKeyDown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }

    function autoResize(el) {
      el.style.height = '38px';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    function addMessage(role, content) {
      var div = document.createElement('div');
      div.className = 'message';

      var icon = role === 'user' ? SVG_USER : SVG_AI;
      var roleClass = role === 'user' ? 'msg-role-user' : 'msg-role-ai';
      var roleLabel = role === 'user' ? 'You' : 'AI Assistant';

      var renderedContent = role === 'user'
        ? '<p>' + escapeHtml(content) + '</p>'
        : renderMarkdown(content);

      div.innerHTML =
        '<div class="msg-header">' + icon +
          '<span class="msg-role ' + roleClass + '">' + roleLabel + '</span>' +
        '</div>' +
        '<div class="msg-content">' + renderedContent + '</div>';

      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function escapeHtml(t) {
      return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ─── Code actions ────────────────────────────

    function copyCodeBlock(btn) {
      var codeEl = btn.closest('.code-block-wrapper').querySelector('.code-block-code');
      var code = codeEl.textContent;
      vscode.postMessage({ type: 'copyCode', code: code });
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Done';
      setTimeout(function() {
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
      }, 1500);
    }

    function insertCodeBlock(btn) {
      var codeEl = btn.closest('.code-block-wrapper').querySelector('.code-block-code');
      vscode.postMessage({ type: 'insertCode', code: codeEl.textContent });
    }

    // ─── File operations ────────────────────────────

    function renderFileOperations(operations) {
      var div = document.createElement('div');
      div.className = 'file-ops';

      var iconMap = {
        create: { cls: 'file-op-icon-create', svg: '<svg class="file-op-icon file-op-icon-create" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>' },
        edit: { cls: 'file-op-icon-edit', svg: '<svg class="file-op-icon file-op-icon-edit" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' },
        delete: { cls: 'file-op-icon-delete', svg: '<svg class="file-op-icon file-op-icon-delete" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' },
        execute: { cls: 'file-op-icon-execute', svg: '<svg class="file-op-icon file-op-icon-execute" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>' }
      };

      var html = '<div class="file-ops-title">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        'Запрошены операции (требуется одобрение)' +
      '</div>';

      operations.forEach(function(op, idx) {
        var info = iconMap[op.type] || iconMap.edit;
        html += '<div class="file-op-item">' +
          info.svg +
          '<span class="file-op-desc">' + escapeHtml(op.description) + '</span>' +
          '<button class="file-op-approve" onclick="approveOp(' + idx + ')">Approve</button>' +
          '<button class="file-op-reject" onclick="rejectOp(this)">Reject</button>' +
        '</div>';
      });

      div.innerHTML = html;
      div._operations = operations;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    var pendingOperations = [];

    function approveOp(idx) {
      if (pendingOperations[idx]) {
        vscode.postMessage({ type: 'approveOperation', operation: pendingOperations[idx] });
      }
    }

    function rejectOp(btn) {
      var item = btn.closest('.file-op-item');
      item.style.opacity = '0.4';
      item.style.pointerEvents = 'none';
      btn.previousElementSibling.textContent = 'Rejected';
      btn.previousElementSibling.style.background = 'rgba(255,255,255,0.06)';
      btn.previousElementSibling.style.color = 'var(--fg-dim)';
    }

    // ─── Actions ────────────────────────────

    function indexProject() { vscode.postMessage({ type: 'indexProject' }); }
    function openSettings() { vscode.postMessage({ type: 'openSettings' }); }
    function insertPrompt(text) {
      inputEl.value = text;
      sendMessage();
    }
    function clearHistory() {
      messagesEl.innerHTML = '';
      if (welcomeEl) {
        messagesEl.appendChild(welcomeEl);
        welcomeEl.style.display = '';
      }
      vscode.postMessage({ type: 'clearHistory' });
    }

    // ─── Message handler ────────────────────────────

    window.addEventListener('message', function(event) {
      var msg = event.data;
      switch(msg.type) {
        case 'thinking':
          thinkingEl.style.display = msg.show ? 'flex' : 'none';
          break;

        case 'context': {
          if (welcomeEl) welcomeEl.style.display = 'none';
          var d = document.createElement('div');
          d.className = 'context-info';

          var contextHeader = document.createElement('div');
          contextHeader.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;';
          contextHeader.innerHTML = SVG_SEARCH;
          var contextLabel = document.createElement('span');
          contextLabel.textContent = msg.message;
          contextHeader.appendChild(contextLabel);
          var arrow = document.createElement('span');
          arrow.textContent = ' \u25B6';
          arrow.style.cssText = 'font-size:10px;transition:transform 0.2s;display:inline-block;';
          contextHeader.appendChild(arrow);
          d.appendChild(contextHeader);

          if (msg.files && msg.files.length > 0) {
            var filesDiv = document.createElement('div');
            filesDiv.className = 'context-files';
            filesDiv.style.display = 'none';
            msg.files.forEach(function(f) {
              var fileSpan = document.createElement('span');
              fileSpan.className = 'context-file';
              fileSpan.textContent = f.split('/').pop() || f;
              filesDiv.appendChild(fileSpan);
            });
            d.appendChild(filesDiv);

            contextHeader.addEventListener('click', function() {
              var isHidden = filesDiv.style.display === 'none';
              filesDiv.style.display = isHidden ? 'flex' : 'none';
              arrow.style.transform = isHidden ? 'rotate(90deg)' : '';
            });
          }

          messagesEl.appendChild(d);
          currentAssistantText = '';
          currentAssistantEl = addMessage('assistant', '');
          break;
        }

        case 'token':
          currentAssistantText += msg.text;
          if (currentAssistantEl) {
            var contentEl = currentAssistantEl.querySelector('.msg-content');
            contentEl.innerHTML = renderMarkdown(currentAssistantText);
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;

        case 'done':
          currentAssistantEl = null;
          currentAssistantText = '';
          isStreaming = false;
          sendBtn.disabled = false;
          break;

        case 'error': {
          var errDiv = document.createElement('div');
          errDiv.className = 'op-result op-result-error';
          errDiv.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' +
            '<span>' + escapeHtml(msg.message) + '</span>';
          messagesEl.appendChild(errDiv);
          isStreaming = false;
          sendBtn.disabled = false;
          break;
        }

        case 'fileOperations':
          pendingOperations = msg.operations;
          renderFileOperations(msg.operations);
          break;

        case 'operationResult': {
          var resDiv = document.createElement('div');
          var cls = msg.result.success ? 'op-result-success' : 'op-result-error';
          var icon = msg.result.success
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
          resDiv.className = 'op-result ' + cls;
          resDiv.innerHTML = icon + '<span>' + escapeHtml(msg.result.message) + '</span>';
          messagesEl.appendChild(resDiv);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        }

        case 'commandOutput': {
          var cmdDiv = document.createElement('div');
          cmdDiv.className = 'cmd-output ' + (msg.success ? 'cmd-output-success' : 'cmd-output-error');

          var cmdHeader = document.createElement('div');
          cmdHeader.className = 'cmd-output-header';

          // SVG icon via DOM namespace
          var ns = 'http://www.w3.org/2000/svg';
          var svgIcon = document.createElementNS(ns, 'svg');
          svgIcon.setAttribute('viewBox', '0 0 24 24');
          svgIcon.setAttribute('fill', 'none');
          svgIcon.setAttribute('stroke', 'currentColor');
          svgIcon.setAttribute('stroke-width', '2');
          if (msg.success) {
            var p1 = document.createElementNS(ns, 'path');
            p1.setAttribute('d', 'M22 11.08V12a10 10 0 1 1-5.93-9.14');
            svgIcon.appendChild(p1);
            var p2 = document.createElementNS(ns, 'polyline');
            p2.setAttribute('points', '22 4 12 14.01 9 11.01');
            svgIcon.appendChild(p2);
          } else {
            var c1 = document.createElementNS(ns, 'circle');
            c1.setAttribute('cx', '12'); c1.setAttribute('cy', '12'); c1.setAttribute('r', '10');
            svgIcon.appendChild(c1);
            var l1 = document.createElementNS(ns, 'line');
            l1.setAttribute('x1', '15'); l1.setAttribute('y1', '9'); l1.setAttribute('x2', '9'); l1.setAttribute('y2', '15');
            svgIcon.appendChild(l1);
            var l2 = document.createElementNS(ns, 'line');
            l2.setAttribute('x1', '9'); l2.setAttribute('y1', '9'); l2.setAttribute('x2', '15'); l2.setAttribute('y2', '15');
            svgIcon.appendChild(l2);
          }
          cmdHeader.appendChild(svgIcon);

          var cmdTitle = document.createTextNode(msg.success ? ' Command Output' : ' Error Output');
          cmdHeader.appendChild(cmdTitle);

          var cmdLabel = document.createElement('span');
          cmdLabel.className = 'cmd-output-cmd';
          cmdLabel.textContent = msg.command;
          cmdHeader.appendChild(cmdLabel);

          var cmdBody = document.createElement('div');
          cmdBody.className = 'cmd-output-body';
          cmdBody.textContent = msg.output;

          cmdHeader.addEventListener('click', function() {
            cmdBody.style.display = cmdBody.style.display === 'none' ? 'block' : 'none';
          });

          cmdDiv.appendChild(cmdHeader);
          cmdDiv.appendChild(cmdBody);
          messagesEl.appendChild(cmdDiv);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        }

        case 'userQuestion':
          inputEl.value = msg.text;
          sendMessage();
          break;

        case 'codeGenerated':
          addMessage('assistant', msg.explanation + '\\n\\n\`\`\`\\n' + msg.code + '\\n\`\`\`');
          isStreaming = false;
          sendBtn.disabled = false;
          break;

        case 'explanation':
          addMessage('assistant', msg.text);
          isStreaming = false;
          sendBtn.disabled = false;
          break;

        case 'historyCleared':
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}
