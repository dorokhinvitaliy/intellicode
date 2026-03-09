import * as vscode from 'vscode';
import { SidebarChatProvider } from './providers/SidebarChatProvider';
import { RAGStatusProvider } from './providers/RAGStatusProvider';
import { ProjectIndexer } from './indexing/ProjectIndexer';
import { ChatHandler } from './chat/ChatHandler';
import { AgentOrchestrator } from './agents/AgentOrchestrator';
import { InlineEditProvider } from './editors/InlineEditProvider';
import { FileOperationsHandler } from './operations/FileOperationsHandler';
import { LLMClient } from './llm/LLMClient';
import { VectorStore } from './indexing/VectorStore';

let indexer: ProjectIndexer;
let chatHandler: ChatHandler;
let orchestrator: AgentOrchestrator;
let inlineEditor: InlineEditProvider;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('IntelliCode Fabric: activating...');

  const config = vscode.workspace.getConfiguration('intellicodeFabric');

  // ─── Инициализация LLM клиента ───
  const llmClient = new LLMClient({
    provider: config.get<string>('apiProvider', 'openai'),
    apiKey: config.get<string>('apiKey', ''),
    endpoint: config.get<string>('apiEndpoint', ''),
    model: config.get<string>('model', 'gpt-4o'),
    embeddingModel: config.get<string>('embeddingModel', 'text-embedding-3-small'),
  });

  // ─── Генерация уникального ID воркспейса ───
  let workspaceId = 'default';
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    workspaceId = Buffer.from(rootPath).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
  }

  // ─── Инициализация векторного хранилища и индексатора ───
  const vectorStore = new VectorStore(context.globalStorageUri.fsPath, workspaceId);
  indexer = new ProjectIndexer(vectorStore, llmClient, {
    excludePatterns: config.get<string[]>('excludePatterns', []),
    chunkSize: config.get<number>('chunkSize', 512),
    chunkOverlap: config.get<number>('chunkOverlap', 64),
  });

  // ─── Инициализация агентов ───
  orchestrator = new AgentOrchestrator(llmClient, vectorStore);

  // ─── Инициализация чат-обработчика ───
  chatHandler = new ChatHandler(llmClient, vectorStore, orchestrator);

  // ─── Inline Editor ───
  inlineEditor = new InlineEditProvider(llmClient);

  // ─── File Operations Handler ───
  const fileOps = new FileOperationsHandler();

  // ─── Регистрация Sidebar Chat Provider ───
  const sidebarProvider = new SidebarChatProvider(
    context.extensionUri,
    chatHandler,
    indexer,
    fileOps
  );
  sidebarProvider.setInlineEditor(inlineEditor);
  inlineEditor.setSidebarProvider(sidebarProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'intellicodeFabric.chatView',
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // ─── Регистрация RAG Status Tree Provider ───
  const ragStatusProvider = new RAGStatusProvider(vectorStore, indexer);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      'intellicodeFabric.ragStatus',
      ragStatusProvider
    )
  );

  // ─── Регистрация команд ───

  context.subscriptions.push(
    vscode.commands.registerCommand('intellicodeFabric.indexProject', async () => {
      await indexProjectWithProgress();
      ragStatusProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('intellicodeFabric.askQuestion', async () => {
      const question = await vscode.window.showInputBox({
        prompt: 'Задайте вопрос о проекте',
        placeHolder: 'Например: Как работает аутентификация в этом проекте?',
      });
      if (question) {
        sidebarProvider.postMessageToWebview({
          type: 'userQuestion',
          text: question,
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('intellicodeFabric.generateCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const instruction = await vscode.window.showInputBox({
        prompt: 'Что нужно сгенерировать?',
        placeHolder: 'Опишите, что должен делать код...',
      });

      if (instruction) {
        sidebarProvider.postMessageToWebview({
          type: 'logUserIntent',
          text: `Написать код: ${instruction}`,
        });
        sidebarProvider.postMessageToWebview({ type: 'thinking', show: true });

        try {
          const response = await chatHandler.generateCode(
            instruction,
            selectedText,
            editor.document.languageId,
            editor.document.fileName
          );
          sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });
          sidebarProvider.postMessageToWebview({
            type: 'codeGenerated',
            code: response.code,
            explanation: response.explanation,
          });
        } catch (err) {
          sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`IntelliCode Fabric: ${errMsg}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('intellicodeFabric.refactor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const instruction = await vscode.window.showInputBox({
        prompt: 'Как нужно рефакторить код?',
        placeHolder: 'Например: Перепиши используя паттерн Стратегия',
      });

      if (instruction) {
        sidebarProvider.postMessageToWebview({
          type: 'logUserIntent',
          text: `Переписать фрагмент: ${instruction}`,
        });
        sidebarProvider.postMessageToWebview({ type: 'thinking', show: true });

        try {
          const result = await orchestrator.runRefactorAgent(
            selectedText,
            instruction,
            editor.document.languageId,
            editor.document.fileName
          );
          sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });

          const action = await inlineEditor.proposeEdit(editor, selection, result.refactoredCode);
          if (action) {
            sidebarProvider.postMessageToWebview({
              type: 'operationResult',
              result: {
                success: action === 'Accept',
                message: `Правки рефакторинга: ${action}`
              }
            });
          }
        } catch (err) {
          sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`IntelliCode Fabric: ${errMsg}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('intellicodeFabric.generateTests', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      const selectedText = editor.document.getText(editor.selection);
      try {
        sidebarProvider.postMessageToWebview({
          type: 'logUserIntent',
          text: `Сгенерировать тесты для выделенного кода`,
        });
        sidebarProvider.postMessageToWebview({ type: 'thinking', show: true });

        const result = await orchestrator.runTestGeneratorAgent(
          selectedText,
          editor.document.languageId,
          editor.document.fileName
        );
        sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });

        const testDoc = await vscode.workspace.openTextDocument({
          content: result.testCode,
          language: editor.document.languageId,
        });
        await vscode.window.showTextDocument(testDoc, vscode.ViewColumn.Beside);
      } catch (err) {
        sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });
        const errMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`IntelliCode Fabric: ${errMsg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('intellicodeFabric.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      const instruction = await vscode.window.showInputBox({
        prompt: 'Опишите изменение',
        placeHolder: 'Например: Добавь обработку ошибок и логирование',
      });

      if (instruction) {
        sidebarProvider.postMessageToWebview({
          type: 'logUserIntent',
          text: `Inline-редактирование: ${instruction}`,
        });
        sidebarProvider.postMessageToWebview({ type: 'thinking', show: true });

        try {
          const selectedText = editor.document.getText(editor.selection);
          const result = await chatHandler.generateCode(
            instruction,
            selectedText,
            editor.document.languageId,
            editor.document.fileName
          );
          sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });

          const action = await inlineEditor.proposeEdit(editor, editor.selection, result.code);
          if (action) {
            sidebarProvider.postMessageToWebview({
              type: 'operationResult',
              result: {
                success: action === 'Accept',
                message: `Inline правки: ${action}`
              }
            });
          }
        } catch (err) {
          sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`IntelliCode Fabric: ${errMsg}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('intellicodeFabric.explainCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      try {
        sidebarProvider.postMessageToWebview({
          type: 'logUserIntent',
          text: `Объяснить выделенный кусок кода...`,
        });
        sidebarProvider.postMessageToWebview({ type: 'thinking', show: true });

        const selectedText = editor.document.getText(editor.selection);
        const explanation = await chatHandler.explainCode(
          selectedText,
          editor.document.languageId,
          editor.document.fileName
        );
        sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });
        sidebarProvider.postMessageToWebview({
          type: 'explanation',
          text: explanation,
        });
      } catch (err) {
        sidebarProvider.postMessageToWebview({ type: 'thinking', show: false });
        const errMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`IntelliCode Fabric: ${errMsg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('intellicodeFabric.clearIndex', async () => {
      await vectorStore.clear();
      ragStatusProvider.refresh();
      vscode.window.showInformationMessage('IntelliCode Fabric: Индекс очищен');
    })
  );

  // ─── Автоиндексация при открытии проекта ───
  if (config.get<boolean>('autoIndex', true)) {
    setTimeout(() => {
      indexProjectWithProgress().then(() => {
        ragStatusProvider.refresh();
      });
    }, 3000);
  }

  // ─── Слушатель изменений файлов ───
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(uri => indexer.reindexFile(uri.fsPath));
  watcher.onDidCreate(uri => indexer.indexFile(uri.fsPath));
  watcher.onDidDelete(uri => indexer.removeFile(uri.fsPath));
  context.subscriptions.push(watcher);

  // ─── Слушатель изменения конфигурации ───
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('intellicodeFabric')) {
        const newConfig = vscode.workspace.getConfiguration('intellicodeFabric');
        llmClient.updateConfig({
          provider: newConfig.get<string>('apiProvider', 'openai'),
          apiKey: newConfig.get<string>('apiKey', ''),
          endpoint: newConfig.get<string>('apiEndpoint', ''),
          model: newConfig.get<string>('model', 'gpt-4o'),
          embeddingModel: newConfig.get<string>('embeddingModel', 'text-embedding-3-small'),
        });
      }
    })
  );

  console.log('IntelliCode Fabric: activated successfully');
}

async function indexProjectWithProgress(): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'IntelliCode Fabric: Индексация проекта...',
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => {
        indexer.cancel();
      });
      await indexer.indexWorkspace(progress);
      const stats = indexer.getStats();
      vscode.window.showInformationMessage(
        `IntelliCode Fabric: Проиндексировано ${stats.totalFiles} файлов (${stats.totalChunks} чанков)`
      );
    }
  );
}

export function deactivate(): void {
  console.log('IntelliCode Fabric: deactivated');
}
