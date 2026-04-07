# indexer-cli — Plan

## Принципы

- **Один пакет** (не монорепо), всё в `src/`
- **Данные в проекте**: `.indexer-cli/` в корне целевого проекта
- **Только Ollama**: фиксированные настройки эмбеддингов
- **Без серверной части**: чистый CLI, нет daemon/MCP/Admin UI
- **Все текущие языки**: TypeScript/JS, Python, C#, GDScript
- **Инкрементальная индексация**: через git diff + copy unchanged vectors

## Структура проекта

```
/Volumes/128GBSSD/Projects/indexer-cli/
├── src/
│   ├── cli/
│   │   ├── index.ts              # Commander entry point + bin
│   │   └── commands/
│   │       ├── init.ts           # indexer init
│   │       ├── index.ts          # indexer index
│   │       ├── search.ts         # indexer search <query>
│   │       ├── structure.ts      # indexer structure
│   │       ├── architecture.ts   # indexer architecture
│   │       └── uninstall.ts      # indexer uninstall
│   ├── core/
│   │   ├── types.ts              # Все типы (Project, Snapshot, File, Chunk, Symbol, etc.)
│   │   ├── config.ts             # Конфигурация (env vars + defaults)
│   │   ├── logger.ts             # Простой логгер
│   │   └── errors.ts             # Кастомные ошибки
│   ├── storage/
│   │   ├── sqlite.ts             # SQLite metadata store (better-sqlite3)
│   │   ├── migrations.ts         # Schema creation + migrations
│   │   └── vectors.ts            # LanceDB vector store
│   ├── embedding/
│   │   └── ollama.ts             # Ollama embedding provider
│   ├── languages/
│   │   ├── plugin.ts             # LanguagePlugin interface + LanguagePluginRegistry
│   │   ├── typescript.ts         # TypeScript/JS plugin (ts-morph)
│   │   ├── python.ts             # Python plugin (tree-sitter-python)
│   │   ├── csharp.ts             # C# plugin (tree-sitter-c-sharp)
│   │   └── gdscript.ts           # GDScript plugin (tree-sitter-gdscript)
│   ├── chunking/
│   │   ├── adaptive.ts           # AdaptiveChunker
│   │   ├── single.ts             # SingleFileChunker (<500 lines)
│   │   ├── function.ts           # FunctionLevelChunker (TS, <2000 lines)
│   │   ├── module.ts             # ModuleLevelChunker
│   │   └── types.ts              # ChunkingContext, Chunk types
│   ├── engine/
│   │   ├── scanner.ts            # File scanner with gitignore
│   │   ├── indexer.ts            # Main IndexerEngine
│   │   ├── git.ts                # Git operations (diff, head commit, status)
│   │   ├── architecture.ts       # Architecture snapshot generator
│   │   └── searcher.ts           # Semantic search engine
│   └── utils/
│       ├── gitignore.ts          # .gitignore parser/filter
│       ├── hash.ts               # SHA256 hashing
│       └── token-estimator.ts    # Token count estimation
├── package.json
├── tsconfig.json
└── bin/
    └── indexer-cli.js            # CLI entry (#!/usr/bin/env node)
```

## Хранение данных

Каждый проект получает `.indexer-cli/` в своём корне:

```
<project-root>/
└── .indexer-cli/
    ├── db.sqlite          # Метаданные (projects, snapshots, files, chunks, symbols, deps)
    ├── vectors/           # LanceDB векторные индексы
    └── config.json        # Локальный конфиг проекта
```

## Конфигурация (фиксированная)

```
INDEXER_EMBEDDING_PROVIDER=ollama
INDEXER_EMBEDDING_MODEL=jina-8k
INDEXER_OLLAMA_NUM_CTX=512
INDEXER_EMBEDDING_CONTEXT_SIZE=8192
INDEXER_VECTOR_SIZE=768
INDEXER_INDEX_CONCURRENCY=1
INDEX_BATCH_SIZE=1
INDEXER_MAX_OLD_SPACE_SIZE_MB=1024
INDEXER_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

## CLI команды

```bash
indexer init                # Создать .indexer-cli/ в текущем или указанном проекте
indexer index [path]        # Запустить индексацию (инкрементально по умолчанию)
indexer search <query>      # Семантический поиск по коду
indexer structure           # Вернуть структуру проекта (файлы, символы, зависимости)
indexer architecture        # Вернуть архитектурный снимок проекта
indexer uninstall           # Удалить .indexer-cli/ из проекта
```

## Зависимости (package.json)

```json
{
  "dependencies": {
    "better-sqlite3": "^11.x",
    "vectordb": "^0.x",
    "ts-morph": "^21.x",
    "tree-sitter": "^0.x",
    "tree-sitter-python": "^0.25.x",
    "tree-sitter-c-sharp": "^0.23.x",
    "tree-sitter-gdscript": "^6.x",
    "axios": "^1.x",
    "commander": "^12.x",
    "p-limit": "^4.x",
    "chalk": "^5.x",
    "ora": "^8.x"
  }
}
```

## Фазы реализации

### Фаза 1: Скаффолдинг + Типы + Конфиг
**Цель**: Рабочий проект с типами и конфигурацией

| # | Задача | Детали |
|---|--------|--------|
| 1.1 | Инициализация проекта | `package.json`, `tsconfig.json`, bin entry, `.gitignore` |
| 1.2 | Core types | Все интерфейсы: `Project`, `Snapshot`, `FileRecord`, `ChunkRecord`, `SymbolRecord`, `DependencyRecord`, `Range`, `ProjectId`, `SnapshotId`, etc. |
| 1.3 | Language plugin interface | `LanguagePlugin` interface + `LanguagePluginRegistry` |
| 1.4 | Config | Упрощённый `ConfigManager` — env vars, дефолтные значения для Ollama |
| 1.5 | Logger | Простой логгер с уровнями (info, warn, error, debug) + chalk |

### Фаза 2: Storage Layer
**Цель**: SQLite + LanceDB хранение + Git operations

| # | Задача | Детали |
|---|--------|--------|
| 2.1 | SQLite schema + migrations | Таблицы: `projects`, `snapshots`, `files`, `chunks`, `symbols`, `dependencies`, `file_metrics`. Путь: `<project>/.indexer-cli/db.sqlite`. WAL mode. |
| 2.2 | SqliteMetadataStore | Методы: `initialize()`, `createProject()`, `createSnapshot()`, `upsertFile()`, `replaceChunks()`, `replaceSymbols()`, `replaceDependencies()`, `upsertFileMetrics()`, `getLatestSnapshot()`, `getLatestCompletedSnapshot()`, `listFiles()`, `listChunks()`, `listSymbols()`, `searchSymbols()`, `listDependencies()`, `updateSnapshotStatus()`, `transaction()`, `copyUnchangedFileData()` |
| 2.3 | LanceDB vector store | Путь: `<project>/.indexer-cli/vectors/`. Методы: `initialize()`, `upsert()`, `search()`, `deleteBySnapshot()`, `deleteByProject()`, `countVectors()`, `copyVectors()` |
| 2.4 | Git operations | Утилита: `getHeadCommit()`, `isDirty()`, `getChangedFiles(sinceCommit)` — через `git rev-parse`, `git status`, `git diff --name-only` |
| 2.5 | `copyUnchangedFileData()` в SQLite | Bulk INSERT...SELECT по списку unchanged paths для: files, chunks, symbols, dependencies, file_metrics |
| 2.6 | `copyVectors()` в LanceDB | Select where file_path NOT IN changedPaths, insert with new snapshotId |

### Фаза 3: Ollama Embedding Provider
**Цель**: Генерация эмбеддингов через Ollama

| # | Задача | Детали |
|---|--------|--------|
| 3.1 | OllamaEmbeddingProvider | POST `/api/embed` → batch embedding. Параметры: `baseUrl`, `model=jina-8k`, `batchSize=1`, `concurrency=1`, `numCtx=512`. Авто-pull модели при 404, reconnection при connection error. Контекст overflow guard (трим контента при превышении numCtx) |

### Фаза 4: Language Plugins (все 4 языка)
**Цель**: Парсинг и чанкинг для TypeScript, Python, C#, GDScript

| # | Задача | Детали |
|---|--------|--------|
| 4.1 | TypeScript plugin | ts-morph AST: parse, extractSymbols, extractImports, splitIntoChunks. Расширения: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx` |
| 4.2 | Python plugin | tree-sitter-python: parse, extractSymbols, extractImports, splitIntoChunks. Расширения: `.py`, `.pyi` |
| 4.3 | C# plugin | tree-sitter-c-sharp: parse, extractSymbols, extractImports, splitIntoChunks. Расширения: `.cs` |
| 4.4 | GDScript plugin | tree-sitter-gdscript: parse, extractSymbols, extractImports, splitIntoChunks. Расширения: `.gd` |
| 4.5 | Language detection | Маппинг расширений → language ID |

### Фаза 5: Chunking System
**Цель**: Разбиение кода на чанки

| # | Задача | Детали |
|---|--------|--------|
| 5.1 | AdaptiveChunker | Стратегии: single (<500 строк), function-level (TS <2000 строк), module-level (>2000 строк) |
| 5.2 | SingleFileChunker | Чанк = весь файл |
| 5.3 | FunctionLevelChunker | Разбиение по функциям/классам |
| 5.4 | ModuleLevelChunker | Разбиение по секциям модуля |
| 5.5 | Heuristic chunker | Языко-специфичное разбиение (imports section, function/class boundaries) |
| 5.6 | TokenEstimator | `Math.ceil(text.length / 4)` |

### Фаза 6: Indexing Engine
**Цель**: Полный пайплайн индексации с инкрементальностью

| # | Задача | Детали |
|---|--------|--------|
| 6.1 | File scanner | Обход директорий с .gitignore фильтрацией. Определение индексируемых файлов по расширениям |
| 6.2 | Gitignore filter | Парсинг `.gitignore`, игнорирование `node_modules/`, `.git/`, `dist/`, etc. |
| 6.3 | Git diff для инкрементальности | При наличии `.git/`: получить `previousSnapshot.headCommit` → `git diff --name-only <prevCommit>..HEAD` → список changed файлов. Сравнить с полным списком → разделить на **changed** (переиндексировать) и **unchanged** (скопировать данные). Если git недоступен или снапшота нет — полная индексация |
| 6.4 | Copy unchanged data | Для unchanged файлов: `sqlite.copyUnchangedFileData(prevSnapshotId, newSnapshotId, unchangedPaths)` + `vectors.copyVectors(prevSnapshotId, newSnapshotId, unchangedPaths)`. Копируются: file records, chunk records, symbol records, dependency records, file_metrics, векторы |
| 6.5 | IndexerEngine — полный цикл | 1. Создать snapshot (status=indexing) 2. Scan files 3. git diff → split changed/unchanged 4. Copy unchanged data 5. Для changed: parse → extractSymbols → extractImports → chunk → embed → store 6. Update snapshot (status=completed). Прогресс-бар через ora |
| 6.6 | ArchitectureGenerator | Генерация архитектурного снимка: модули, зависимости, hotspot анализ |

### Фаза 7: Search Engine
**Цель**: Семантический поиск

| # | Задача | Детали |
|---|--------|--------|
| 7.1 | SearchEngine | embed(query) → vectorStore.search(queryEmbedding, topK, filters) → обогащение результатов из SQLite (content из файла по line range) → ранжированные результаты |
| 7.2 | Фильтры поиска | По pathPrefix, chunkTypes, filePath. Опции CLI: `--top-k`, `--path-prefix`, `--chunk-types` |
| 7.3 | Форматирование результатов | FilePath:startLine-endLine + score + primarySymbol + первые N строк контента |

### Фаза 8: CLI Commands
**Цель**: Все команды CLI

| # | Задача | Детали |
|---|--------|--------|
| 8.1 | `indexer init [path]` | Создать `.indexer-cli/` директорию, инициализировать SQLite, записать config.json. Записать `.indexer-cli/` в `.gitignore` проекта |
| 8.2 | `indexer index [path]` | **Инкрементально по умолчанию** (git diff). Прогресс-бар. Вывод: кол-во файлов, чанков, время. Опции: `--full` (force reindex), `--dry-run` (показать что изменится) |
| 8.3 | `indexer search <query>` | Семантический поиск. Вывод: топ результатов с контекстом. Опции: `--top-k 10`, `--path-prefix src/`, `--chunk-types impl,types` |
| 8.4 | `indexer structure [path]` | Структура проекта из SQLite: дерево файлов с символами. Фильтры: `--path-prefix`, `--kind function/class` |
| 8.5 | `indexer architecture [path]` | Архитектурный снимок: модули, зависимости, hotspot анализ. JSON или текст |
| 8.6 | `indexer uninstall [path]` | Удалить `.indexer-cli/` директорию |

## Порядок имплементации

```
Фаза 1 (типы, конфиг) → Фаза 2 (storage + git) → Фаза 3 (ollama)
    ↓
Фаза 4 (языки) → Фаза 5 (чанкинг) → Фаза 6 (engine)
    ↓
Фаза 7 (search) → Фаза 8 (CLI commands)
```

Фазы 1-3 независимы от 4-5 и могут делаться параллельно. Фаза 6 зависит от 1-5. Фаза 7 зависит от 2+3+6. Фаза 8 зависит от 6+7.

## Сравнение с оригиналом

| Аспект | Оригинал | CLI версия |
|--------|----------|------------|
| Архитектура | Монорепо 22 пакета | Один пакет |
| Хранение данных | `~/.indexer/` (глобальное) | `<project>/.indexer-cli/` (локальное) |
| Проекты | Мультипроект | Один проект |
| Embeddings | Ollama + Transformers.js | Только Ollama |
| Сервер | Daemon + MCP + Admin UI | Нет |
| Git интеграция | Инкрементальная ✓ | Инкрементальная ✓ |
| Copy unchanged vectors | ✓ | ✓ |
| Конкурентность | 5 parallel | 1 (sequential) |
| Process supervision | process-supervisor | Нет |
