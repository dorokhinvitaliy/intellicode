# 🧠 IntelliCode Fabric

**AI-ассистент для разработки с контекстом всего проекта**

IntelliCode Fabric — расширение для VS Code, которое индексирует всю кодовую базу
и предоставляет глубоко контекстно-зависимые ответы, генерацию кода, рефакторинг
и тестирование через мульти-агентную AI-систему.

## 🚀 Быстрый старт

```bash
cd extension
npm install
npm run compile
# Затем F5 в VS Code
```

## ⌨️ Горячие клавиши

| Команда | Windows/Linux | macOS |
|---------|--------------|-------|
| Задать вопрос AI | Ctrl+Shift+A | Cmd+Shift+A |
| Сгенерировать код | Ctrl+Shift+G | Cmd+Shift+G |
| Inline-редактирование | Ctrl+Shift+E | Cmd+Shift+E |

## 📁 Структура

```
src/
├── extension.ts              # Точка входа
├── llm/
│   └── LLMClient.ts          # Универсальный LLM клиент
├── indexing/
│   ├── ProjectIndexer.ts     # Индексация проекта
│   └── VectorStore.ts        # Векторное хранилище
├── chat/
│   └── ChatHandler.ts        # Обработка чата с RAG
├── agents/
│   ├── AgentOrchestrator.ts  # Координатор агентов
│   ├── AnalystAgent.ts       # Агент-аналитик
│   ├── CoderAgent.ts         # Агент-кодер
│   ├── TesterAgent.ts        # Агент-тестировщик
│   └── RefactorAgent.ts      # Агент-рефактор
├── editors/
│   └── InlineEditProvider.ts # Inline-редактирование
└── providers/
    ├── SidebarChatProvider.ts # Webview провайдер
    └── RAGStatusProvider.ts   # Tree view статуса
```

## 📄 Лицензия

MIT
