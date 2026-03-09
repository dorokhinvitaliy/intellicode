import * as vscode from 'vscode';
import { LLMClient } from '../llm/LLMClient';

/**
 * InlineEditProvider — показывает предложенные AI изменения
 * в виде diff прямо в редакторе VS Code.
 * Пользователь может принять или отклонить каждое изменение.
 */
export class InlineEditProvider {
  private llmClient: LLMClient;
  private decorationType: vscode.TextEditorDecorationType;
  private pendingEdits: Map<string, PendingEdit> = new Map();
  private sidebarProvider: any = null;
  private resolutionMap: Map<string, (action: 'Accept' | 'Reject' | 'Show Diff') => void> = new Map();

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;

    this.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(100, 200, 100, 0.15)',
      border: '1px solid rgba(100, 200, 100, 0.4)',
      borderRadius: '3px',
    });
  }

  setSidebarProvider(provider: any) {
    this.sidebarProvider = provider;
  }

  getLLMClient(): LLMClient {
    return this.llmClient;
  }

  async proposeEdit(
    editor: vscode.TextEditor,
    selection: vscode.Selection,
    newCode: string
  ): Promise<string | undefined> {
    const document = editor.document;
    const originalText = document.getText(selection);
    const editId = `edit-${Date.now()}`;

    const pendingEdit: PendingEdit = {
      id: editId,
      editor,
      selection,
      originalText,
      newCode,
    };
    this.pendingEdits.set(editId, pendingEdit);

    await this.showDiffPreview(pendingEdit);

    return new Promise<string | undefined>((resolve) => {
      this.resolutionMap.set(editId, async (action) => {
        switch (action) {
          case 'Accept':
            await this.applyEdit(editId);
            resolve(action);
            this.resolutionMap.delete(editId);
            break;
          case 'Show Diff':
            await this.showDiffPreview(pendingEdit);
            break;
          case 'Reject':
          default:
            this.rejectEdit(editId);
            resolve(action);
            this.resolutionMap.delete(editId);
            break;
        }
      });

      if (this.sidebarProvider) {
        const fileName = editor.document.fileName.split(/[\\/]/).pop() || 'file';
        this.sidebarProvider.postMessageToWebview({
          type: 'inlineEditProposal',
          editId,
          description: `AI предлагает изменения для ${fileName}`,
        });
      } else {
        // Fallback если чат не открыт
        vscode.window.showInformationMessage(
          'IntelliCode Fabric: Accept proposed changes?',
          { modal: false },
          'Accept',
          'Reject',
          'Show Diff'
        ).then(action => {
          if (action) {
            this.resolveEdit(editId, action as 'Accept' | 'Reject' | 'Show Diff');
          } else {
            this.resolveEdit(editId, 'Reject');
          }
        });
      }
    });
  }

  public resolveEdit(editId: string, action: 'Accept' | 'Reject' | 'Show Diff'): void {
    const resolver = this.resolutionMap.get(editId);
    if (resolver) {
      resolver(action);
    }
  }

  private async applyEdit(editId: string): Promise<void> {
    const edit = this.pendingEdits.get(editId);
    if (!edit) { return; }

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(
      edit.editor.document.uri,
      edit.selection,
      edit.newCode
    );

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (applied) {
      vscode.window.showInformationMessage('IntelliCode Fabric: Changes applied');
    } else {
      vscode.window.showErrorMessage('IntelliCode Fabric: Failed to apply changes');
    }

    this.pendingEdits.delete(editId);
    this.clearDecorations(edit.editor);
  }

  private rejectEdit(editId: string): void {
    const edit = this.pendingEdits.get(editId);
    if (edit) {
      this.clearDecorations(edit.editor);
    }
    this.pendingEdits.delete(editId);
  }

  private async showDiffPreview(edit: PendingEdit): Promise<void> {
    const scheme = `icf-diff-${Date.now()}`;

    const originalContent = edit.editor.document.getText();
    const modifiedContent =
      originalContent.substring(0, edit.editor.document.offsetAt(edit.selection.start)) +
      edit.newCode +
      originalContent.substring(edit.editor.document.offsetAt(edit.selection.end));

    const origProvider = new InlineContentProvider(originalContent);
    const modProvider = new InlineContentProvider(modifiedContent);

    const d1 = vscode.workspace.registerTextDocumentContentProvider(
      `${scheme}-orig`, origProvider
    );
    const d2 = vscode.workspace.registerTextDocumentContentProvider(
      `${scheme}-mod`, modProvider
    );

    const fileName = edit.editor.document.fileName.split(/[/\\]/).pop() || 'file';

    const originalUri = vscode.Uri.parse(`${scheme}-orig:${fileName}`);
    const modifiedUri = vscode.Uri.parse(`${scheme}-mod:${fileName}`);

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      modifiedUri,
      `IntelliCode: ${fileName} (Original ↔ Proposed)`
    );

    // Cleanup providers after 2 minutes
    setTimeout(() => {
      d1.dispose();
      d2.dispose();
    }, 120000);
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decorationType, []);
  }
}

interface PendingEdit {
  id: string;
  editor: vscode.TextEditor;
  selection: vscode.Selection;
  originalText: string;
  newCode: string;
}

class InlineContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private content: string) { }

  provideTextDocumentContent(): string {
    return this.content;
  }
}
