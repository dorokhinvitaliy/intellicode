import * as vscode from 'vscode';
import { VectorStore } from '../indexing/VectorStore';
import { ProjectIndexer } from '../indexing/ProjectIndexer';

export class RAGStatusProvider implements vscode.TreeDataProvider<RAGStatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RAGStatusItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private vectorStore: VectorStore;
  private indexer: ProjectIndexer;

  constructor(vectorStore: VectorStore, indexer: ProjectIndexer) {
    this.vectorStore = vectorStore;
    this.indexer = indexer;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RAGStatusItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RAGStatusItem): Thenable<RAGStatusItem[]> {
    if (element) {
      if (element.label === 'Проиндексированные файлы') {
        const stats = this.vectorStore.getStats();
        return Promise.resolve(
          stats.filesList.slice(0, 50).map(
            (file) =>
              new RAGStatusItem(
                file.split('/').pop() || file,
                vscode.TreeItemCollapsibleState.None,
                file,
                'file'
              )
          )
        );
      }
      return Promise.resolve([]);
    }

    const stats = this.vectorStore.getStats();
    const indexStats = this.indexer.getStats();

    const items: RAGStatusItem[] = [
      new RAGStatusItem(
        `Чанков: ${stats.totalChunks}`,
        vscode.TreeItemCollapsibleState.None,
        'Количество чанков кода в индексе',
        'info'
      ),
      new RAGStatusItem(
        `С эмбеддингами: ${stats.hasEmbeddings}`,
        vscode.TreeItemCollapsibleState.None,
        'Чанков с векторными эмбеддингами',
        'info'
      ),
      new RAGStatusItem(
        `Файлов: ${stats.totalFiles}`,
        vscode.TreeItemCollapsibleState.None,
        'Общее количество проиндексированных файлов',
        'info'
      ),
      new RAGStatusItem(
        'Проиндексированные файлы',
        stats.totalFiles > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        'Список всех проиндексированных файлов',
        'folder'
      ),
    ];

    if (indexStats.lastIndexed) {
      items.push(
        new RAGStatusItem(
          `Последняя индексация: ${indexStats.lastIndexed.toLocaleTimeString()}`,
          vscode.TreeItemCollapsibleState.None,
          'Время последней индексации',
          'time'
        )
      );
    }

    return Promise.resolve(items);
  }
}

class RAGStatusItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description: string,
    public readonly itemType: string
  ) {
    super(label, collapsibleState);
    this.tooltip = description;

    switch (itemType) {
      case 'info':
        this.iconPath = new vscode.ThemeIcon('info');
        break;
      case 'folder':
        this.iconPath = new vscode.ThemeIcon('folder');
        break;
      case 'file':
        this.iconPath = new vscode.ThemeIcon('file-code');
        break;
      case 'time':
        this.iconPath = new vscode.ThemeIcon('clock');
        break;
    }
  }
}
