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
    const createRegex = /<<<\s*CREATE_FILE\s+path="([^"]+)"\s*>>>([\s\S]*?)<<<\s*END_FILE\s*>>>/g;
    let match;
    while ((match = createRegex.exec(response)) !== null) {
      operations.push({
        type: 'create',
        filePath: match[1],
        content: match[2].trim(),
        description: `Создать файл: ${match[1]}`,
      });
    }

    // EDIT_FILE
    const editRegex = /<<<\s*EDIT_FILE\s+path="([^"]+)"\s*>>>([\s\S]*?)<<<\s*END_FILE\s*>>>/g;
    while ((match = editRegex.exec(response)) !== null) {
      operations.push({
        type: 'edit',
        filePath: match[1],
        content: match[2].trim(),
        description: `Редактировать файл: ${match[1]}`,
      });
    }

    // DELETE_FILE
    const deleteRegex = /<<<\s*DELETE_FILE\s+path="([^"]+)"\s*\/?\s*>>>/g;
    while ((match = deleteRegex.exec(response)) !== null) {
      operations.push({
        type: 'delete',
        filePath: match[1],
        description: `Удалить файл: ${match[1]}`,
      });
    }

    // EXECUTE
    const execRegex = /<<<\s*EXECUTE\s+command="([^"]+)"\s*\/?\s*>>>/g;
    while ((match = execRegex.exec(response)) !== null) {
      operations.push({
        type: 'execute',
        command: match[1],
        description: `Выполнить команду: ${match[1]}`,
      });
    }

    return operations;
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

    const fullPath = path.join(rootPath, op.filePath);
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

    const fullPath = path.join(rootPath, op.filePath);

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

    const fullPath = path.join(rootPath, op.filePath);

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

    return new Promise((resolve) => {
      const cwd = rootPath || process.cwd();

      cp.exec(op.command!, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          // Показываем вывод ошибки
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
}
