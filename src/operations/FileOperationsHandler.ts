import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

export interface FileOperation {
  type: 'create' | 'edit' | 'delete' | 'execute';
  filePath?: string;
  content?: string;
  command?: string;
  description: string;
}

export interface OperationResult {
  success: boolean;
  message: string;
  output?: string;
}

/**
 * Обработчик файловых операций с обязательным одобрением пользователя.
 * AI может предложить создать/отредактировать/удалить файл или выполнить команду,
 * но КАЖДОЕ действие требует явного подтверждения.
 */
export class FileOperationsHandler {
  // Track spawned background processes for stop commands
  private static runningProcesses: Map<string, cp.ChildProcess> = new Map();

  /** Kill all tracked background processes. Returns count killed. */
  public killAllProcesses(): number {
    const count = FileOperationsHandler.runningProcesses.size;
    for (const [cmd, child] of FileOperationsHandler.runningProcesses) {
      child.kill();
    }
    FileOperationsHandler.runningProcesses.clear();
    return count;
  }
  /**
   * Выполняет операцию с одобрением пользователя.
   * Возвращает результат операции.
   */
  async executeWithApproval(operation: FileOperation): Promise<OperationResult> {
    switch (operation.type) {
      case 'create':
        return this.createFileWithApproval(operation);
      case 'edit':
        return this.editFileWithApproval(operation);
      case 'delete':
        return this.deleteFileWithApproval(operation);
      case 'execute':
        return this.executeCommandWithApproval(operation);
      default:
        return { success: false, message: 'Неизвестный тип операции' };
    }
  }

  /**
   * Парсит ответ LLM и извлекает операции с файлами.
   * Ищет специальные блоки вида:
   * <<<CREATE_FILE path="src/example.ts">>>...<<<END_FILE>>>
   * <<<EDIT_FILE path="src/example.ts">>>...<<<END_FILE>>>
   * <<<DELETE_FILE path="src/example.ts"/>>>
   * <<<EXECUTE command="npm install express"/>>>
   */
  parseOperationsFromResponse(response: string): FileOperation[] {
    const operations: FileOperation[] = [];

    // CREATE_FILE
    // Allows 2+ brackets: >> or >>>
    // Allows missing END_FILE (matches to end of string or next block)
    const createRegex = /<<<\s*CREATE_FILE\s+path="([^"]+)"\s*>{1,}([\s\S]*?)(?:<<<\s*END_FILE\s*>{1,}|$|(?=<<<\s*(?:CREATE|EDIT|DELETE|EXECUTE)))/gi;
    let match;
    while ((match = createRegex.exec(response)) !== null) {
      operations.push({
        type: 'create',
        filePath: match[1],
        content: this.stripMarkdownFences(match[2].trim()),
        description: `Создать файл: ${match[1]}`,
      });
    }

    // EDIT_FILE
    const editRegex = /<<<\s*EDIT_FILE\s+path="([^"]+)"\s*>{1,}([\s\S]*?)(?:<<<\s*END_FILE\s*>{1,}|$|(?=<<<\s*(?:CREATE|EDIT|DELETE|EXECUTE)))/gi;
    while ((match = editRegex.exec(response)) !== null) {
      operations.push({
        type: 'edit',
        filePath: match[1],
        content: this.stripMarkdownFences(match[2].trim()),
        description: `Редактировать файл: ${match[1]}`,
      });
    }

    // DELETE_FILE
    const deleteRegex = /<<<\s*DELETE_FILE\s+path="([^"]+)"\s*\/?\s*>{1,}/gi;
    while ((match = deleteRegex.exec(response)) !== null) {
      operations.push({
        type: 'delete',
        filePath: match[1],
        description: `Удалить файл: ${match[1]}`,
      });
    }

    // EXECUTE
    const execRegex = /<<<\s*EXECUTE\s+command="([^"]+)"\s*\/?\s*>{1,}/gi;
    while ((match = execRegex.exec(response)) !== null) {
      operations.push({
        type: 'execute',
        command: match[1],
        description: `Выполнить команду: ${match[1]}`,
      });
    }

    // Fallback: if no operations found but code blocks with file paths exist
    if (operations.length === 0) {
      operations.push(...this.extractFromCodeBlocks(response));
    }

    return operations;
  }

  /**
   * Strip markdown code fences from file content.
   * Models often wrap code in ```typescript...``` even inside CREATE_FILE markers.
   */
  private stripMarkdownFences(content: string): string {
    // Remove opening fence: ```language or just ```
    let cleaned = content.replace(/^```[\w]*\s*\n?/, '');
    // Remove closing fence: ```
    cleaned = cleaned.replace(/\n?```\s*$/, '');
    return cleaned.trim();
  }

  /**
   * Fallback: extracts file operations from markdown code blocks
   * where the first line or the language block contains a file path.
   * Format: ```typescript:src/file.ts
   * Or format: ```typescript src/file.ts
   */
  private extractFromCodeBlocks(response: string): FileOperation[] {
    const operations: FileOperation[] = [];
    let m: RegExpExecArray | null;

    // Pattern 1: tagged code blocks like ```ts:path/file.ts
    const tagged = /```[\w-]*[:\s]+([a-zA-Z0-9_.\-/\\]+\.[a-zA-Z0-9]+)\s*\n([\s\S]*?)```/g;
    while ((m = tagged.exec(response)) !== null) {
      operations.push({
        type: 'edit',
        filePath: m[1].trim(),
        content: this.stripMarkdownFences(m[2].trim()),
        description: `Create/Edit: ${m[1].trim()}`,
      });
    }

    // Pattern 2: detect filename mentions + code blocks (model forgot markers)
    if (operations.length === 0) {
      const fileNames: string[] = [];
      const fnRe = /([a-zA-Z0-9_.\-/\\]+\.(?:ts|tsx|js|jsx|py|java|css|html|json|xml|yaml|yml|go|rs|rb|php|c|cpp|h|vue|svelte))\b/gi;
      while ((m = fnRe.exec(response)) !== null) {
        const fn = m[1];
        if (!fn.startsWith('node_modules') && !fn.includes('package.json') && !fn.includes('pom.xml')) {
          fileNames.push(fn);
        }
      }

      const codeBlocks: string[] = [];
      const cbRe = /```[\w]*\s*\n([\s\S]*?)```/g;
      while ((m = cbRe.exec(response)) !== null) {
        codeBlocks.push(m[1].trim());
      }

      // Deduplicate filenames (keep first occurrence)
      const uniqueFiles = [...new Set(fileNames)];
      const n = Math.min(uniqueFiles.length, codeBlocks.length);
      for (let i = 0; i < n; i++) {
        operations.push({
          type: 'edit',
          filePath: uniqueFiles[i],
          content: this.stripMarkdownFences(codeBlocks[i]),
          description: `Create/Edit: ${uniqueFiles[i]}`,
        });
      }
    }

    return operations;
  }

  /**
   * Выполняет операцию напрямую БЕЗ дополнительного окна подтверждения VS Code.
   * Используется, когда пользователь уже подтвердил действие кнопкой "Approve" в чате.
   */
  async executeDirect(operation: FileOperation): Promise<OperationResult> {
    switch (operation.type) {
      case 'create':
      case 'edit':
        return this.createOrEditFileDirect(operation);
      case 'delete':
        return this.deleteFileDirect(operation);
      case 'execute':
        // Для терминала пока оставляем запуск как есть
        return this.executeCommandWithApproval(operation);
      default:
        return { success: false, message: 'Неизвестный тип операции' };
    }
  }

  private async createOrEditFileDirect(op: FileOperation): Promise<OperationResult> {
    if (!op.filePath || !op.content) {
      return { success: false, message: 'Не указан путь или содержимое файла' };
    }

    const rootPath = this.getWorkspaceRoot();
    if (!rootPath) {
      return { success: false, message: 'Рабочая папка не открыта' };
    }

    const fullPath = this.resolveFilePath(op.filePath, rootPath);
    const exists = fs.existsSync(fullPath);

    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, op.content, 'utf-8');

      // Открываем файл
      const doc = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(doc);

      return { success: true, message: `Файл ${exists ? 'отредактирован' : 'создан'}: ${op.filePath}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Ошибка: ${errMsg}` };
    }
  }

  private async deleteFileDirect(op: FileOperation): Promise<OperationResult> {
    if (!op.filePath) {
      return { success: false, message: 'Не указан путь файла' };
    }

    const rootPath = this.getWorkspaceRoot();
    if (!rootPath) {
      return { success: false, message: 'Рабочая папка не открыта' };
    }

    const fullPath = this.resolveFilePath(op.filePath, rootPath);

    if (!fs.existsSync(fullPath)) {
      return { success: false, message: `Файл не найден: ${op.filePath}` };
    }

    try {
      fs.unlinkSync(fullPath);
      return { success: true, message: `Файл удалён: ${op.filePath}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Ошибка: ${errMsg}` };
    }
  }

  // ─── Операции с файлами ──────────────────────────

  private async createFileWithApproval(op: FileOperation): Promise<OperationResult> {
    if (!op.filePath || !op.content) {
      return { success: false, message: 'Не указан путь или содержимое файла' };
    }

    const rootPath = this.getWorkspaceRoot();
    if (!rootPath) {
      return { success: false, message: 'Рабочая папка не открыта' };
    }

    const fullPath = this.resolveFilePath(op.filePath, rootPath);
    const exists = fs.existsSync(fullPath);

    // Показываем содержимое файла для ревью
    const previewDoc = await vscode.workspace.openTextDocument({
      content: op.content,
      language: this.getLanguageId(op.filePath),
    });
    await vscode.window.showTextDocument(previewDoc, vscode.ViewColumn.Beside);

    const action = await vscode.window.showWarningMessage(
      `AI хочет ${exists ? 'перезаписать' : 'создать'} файл: ${op.filePath}`,
      { modal: true, detail: `Файл будет ${exists ? 'перезаписан' : 'создан'} по пути:\n${fullPath}\n\nСодержимое показано в соседней вкладке.` },
      'Разрешить',
      'Отклонить'
    );

    if (action !== 'Разрешить') {
      return { success: false, message: 'Операция отклонена пользователем' };
    }

    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, op.content, 'utf-8');

      // Открываем созданный файл
      const doc = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(doc);

      return { success: true, message: `Файл ${exists ? 'перезаписан' : 'создан'}: ${op.filePath}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Ошибка: ${errMsg}` };
    }
  }

  private async editFileWithApproval(op: FileOperation): Promise<OperationResult> {
    if (!op.filePath || !op.content) {
      return { success: false, message: 'Не указан путь или содержимое файла' };
    }

    const rootPath = this.getWorkspaceRoot();
    if (!rootPath) {
      return { success: false, message: 'Рабочая папка не открыта' };
    }

    const fullPath = this.resolveFilePath(op.filePath, rootPath);

    if (!fs.existsSync(fullPath)) {
      return { success: false, message: `Файл не найден: ${op.filePath}` };
    }

    const originalContent = fs.readFileSync(fullPath, 'utf-8');

    // Показываем diff
    const originalUri = vscode.Uri.parse(`untitled:original-${path.basename(op.filePath)}`);
    const modifiedUri = vscode.Uri.parse(`untitled:modified-${path.basename(op.filePath)}`);

    const origProvider = new (class implements vscode.TextDocumentContentProvider {
      provideTextDocumentContent(): string { return originalContent; }
    })();
    const modProvider = new (class implements vscode.TextDocumentContentProvider {
      provideTextDocumentContent(): string { return op.content!; }
    })();

    const d1 = vscode.workspace.registerTextDocumentContentProvider('icf-orig', origProvider);
    const d2 = vscode.workspace.registerTextDocumentContentProvider('icf-mod', modProvider);

    const origDocUri = vscode.Uri.parse(`icf-orig:${op.filePath}`);
    const modDocUri = vscode.Uri.parse(`icf-mod:${op.filePath}`);

    await vscode.commands.executeCommand(
      'vscode.diff', origDocUri, modDocUri,
      `AI Edit: ${path.basename(op.filePath)} (Original ↔ Modified)`
    );

    const action = await vscode.window.showWarningMessage(
      `AI хочет отредактировать файл: ${op.filePath}`,
      { modal: true, detail: 'Изменения показаны в diff-просмотре.' },
      'Разрешить',
      'Отклонить'
    );

    d1.dispose();
    d2.dispose();

    if (action !== 'Разрешить') {
      return { success: false, message: 'Операция отклонена пользователем' };
    }

    try {
      fs.writeFileSync(fullPath, op.content, 'utf-8');
      const doc = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(doc);
      return { success: true, message: `Файл отредактирован: ${op.filePath}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Ошибка: ${errMsg}` };
    }
  }

  private async deleteFileWithApproval(op: FileOperation): Promise<OperationResult> {
    if (!op.filePath) {
      return { success: false, message: 'Не указан путь файла' };
    }

    const rootPath = this.getWorkspaceRoot();
    if (!rootPath) {
      return { success: false, message: 'Рабочая папка не открыта' };
    }

    const fullPath = this.resolveFilePath(op.filePath, rootPath);

    if (!fs.existsSync(fullPath)) {
      return { success: false, message: `Файл не найден: ${op.filePath}` };
    }

    const action = await vscode.window.showWarningMessage(
      `AI хочет УДАЛИТЬ файл: ${op.filePath}`,
      { modal: true, detail: `Файл будет безвозвратно удалён:\n${fullPath}\n\nЭто действие нельзя отменить!` },
      'Удалить',
      'Отклонить'
    );

    if (action !== 'Удалить') {
      return { success: false, message: 'Удаление отклонено пользователем' };
    }

    try {
      fs.unlinkSync(fullPath);
      return { success: true, message: `Файл удалён: ${op.filePath}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Ошибка удаления: ${errMsg}` };
    }
  }

  private async executeCommandWithApproval(op: FileOperation): Promise<OperationResult> {
    if (!op.command) {
      return { success: false, message: 'Не указана команда' };
    }

    const rootPath = this.getWorkspaceRoot();

    const action = await vscode.window.showWarningMessage(
      `AI хочет выполнить команду в терминале`,
      {
        modal: true,
        detail: `Команда: ${op.command}\n\nРабочая директория: ${rootPath || 'не определена'}\n\nУбедитесь, что команда безопасна!`
      },
      'Выполнить',
      'Отклонить'
    );

    if (action !== 'Выполнить') {
      return { success: false, message: 'Выполнение команды отклонено' };
    }

    // Detect long-running commands (dev servers, watchers) — but NOT stop/kill
    const cmd = op.command.toLowerCase();
    const isStopCommand = ['stop', 'kill', 'close', 'exit'].some(kw => cmd.includes(kw));
    const isLongRunning = !isStopCommand && ['dev', 'start', 'serve', 'watch'].some(
      kw => cmd.includes(`run ${kw}`) || cmd.includes(`npm ${kw}`) || cmd.includes(`yarn ${kw}`) || cmd.endsWith(kw)
    );

    if (isLongRunning) {
      // Use cp.spawn to capture initial output, then show terminal for live monitoring
      return new Promise((resolve) => {
        const cwd = rootPath || process.cwd();

        // Parse command: handle "cd dir && command" pattern
        const shell = process.platform === 'win32' ? 'cmd' : '/bin/sh';
        const shellFlag = process.platform === 'win32' ? '/c' : '-c';
        const child = cp.spawn(shell, [shellFlag, op.command!], { cwd });

        let output = '';
        let resolved = false;

        const appendOutput = (data: Buffer) => {
          output += data.toString();
        };

        child.stdout.on('data', appendOutput);
        child.stderr.on('data', appendOutput);

        // Track this process for stop commands
        FileOperationsHandler.runningProcesses.set(op.command!, child);
        child.on('exit', () => {
          FileOperationsHandler.runningProcesses.delete(op.command!);
        });

        child.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            resolve({
              success: false,
              message: `Ошибка запуска: ${err.message}`,
              output: output || err.message,
            });
          }
        });

        child.on('exit', (code) => {
          if (!resolved) {
            resolved = true;
            if (code !== 0) {
              resolve({
                success: false,
                message: `Команда завершилась с кодом ${code}`,
                output: output || `Exit code: ${code}`,
              });
            } else {
              resolve({
                success: true,
                message: `Команда выполнена успешно`,
                output: output || '(нет вывода)',
              });
            }
          }
        });

        // Wait 5 seconds for initial output, then resolve as "running"
        // Keep spawn alive — do NOT open a second terminal
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve({
              success: true,
              message: `Команда запущена: ${op.command}`,
              output: output || '(сервер запускается...)',
            });
          }
        }, 5000);
      });
    }

    // Short commands: capture output via cp.exec
    return new Promise((resolve) => {
      const cwd = rootPath || process.cwd();

      cp.exec(op.command!, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const output = stderr || stdout || error.message;
          vscode.window.showErrorMessage(`Команда завершилась с ошибкой: ${error.message}`);
          resolve({
            success: false,
            message: `Ошибка выполнения: ${error.message}`,
            output,
          });
        } else {
          const output = stdout || stderr || '(нет вывода)';
          vscode.window.showInformationMessage(`Команда выполнена: ${op.command}`);
          resolve({
            success: true,
            message: `Команда выполнена успешно`,
            output,
          });
        }
      });
    });
  }

  // ─── Вспомогательные методы ──────────────────────────

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getLanguageId(filePath: string): string {
    const ext = path.extname(filePath);
    const map: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescriptreact',
      '.js': 'javascript', '.jsx': 'javascriptreact',
      '.py': 'python', '.java': 'java', '.go': 'go',
      '.rs': 'rust', '.html': 'html', '.css': 'css',
      '.json': 'json', '.md': 'markdown', '.yaml': 'yaml',
      '.yml': 'yaml', '.xml': 'xml', '.sql': 'sql',
      '.sh': 'shellscript', '.bash': 'shellscript',
    };
    return map[ext] || 'plaintext';
  }

  /**
   * Убеждается, что переданный путь является относительным к корню проекта.
   * Удаляет абсолютные префиксы путей, если AI по ошибке прислал абсолютный путь.
   */
  private resolveFilePath(filePath: string, rootPath: string): string {
    // Нормализация сепараторов
    let normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedRoot = rootPath.replace(/\\/g, '/');

    // Если AI отправил путь, который уже начинается с rootPath
    if (normalizedPath.startsWith(normalizedRoot)) {
      normalizedPath = normalizedPath.substring(normalizedRoot.length);
    }
    // Либо если путь начинается с rootPath, но без начального слэша
    else {
      const rootWithoutSlash = normalizedRoot.startsWith('/') ? normalizedRoot.substring(1) : normalizedRoot;
      if (normalizedPath.startsWith(rootWithoutSlash)) {
        normalizedPath = normalizedPath.substring(rootWithoutSlash.length);
      }
    }

    // Удаляем все ведущие слэши, чтобы path.join не считал его абсолютным
    normalizedPath = normalizedPath.replace(/^[/\\]+/, '');

    return path.join(rootPath, normalizedPath);
  }
}
