# TODO — Реализация OpenCode Session Manager Plugin

> **MVP = Фаза 0 + Фаза 1.** Сделай pin/unpin/list/search, убедись что работает — потом бэкапы и автоочистку.

## Запреты

- НЕ менять схему БД opencode (не создавать новые таблицы, не добавлять колонки)
- НЕ выполнять write-SQL (INSERT/UPDATE/DELETE) к `opencode.db`. Read-only `opencode db "<SELECT>"` — только как fallback, когда CLI не отдаёт поле.
- НЕ изменять поведение встроенных команд opencode
- НЕ коммитить `session-manager.json` и бэкапы в git — это пользовательские данные
- НЕ удалять сессию без предварительного успешного бэкапа (стратегия **backup-then-delete**). Удаление — только `opencode session delete <id>`
- НЕ ротировать бэкапы pinned-сессий и orphaned-бэкапов (сессии уже нет в БД = единственная копия)

## Архитектурное правило: CLI-first

Все операции с данными сессий идут через публичные CLI-команды opencode (вызов через Bun shell `$` из контекста плагина), а не через прямой SQL. Это защитит от поломки при изменении схемы БД в будущих релизах. Полный список реальных команд — в `docs/CLI-CAPABILITIES.md`.

| Задача | CLI-команда | Примечание |
|--------|-------------|------------|
| Список сессий | `opencode session list --format json` | поля: `id, title, updated, created, projectId, directory` |
| Поиск по заголовку | клиентская фильтрация `session list` | — |
| Проверка существования | `session list` + find по id | — |
| Экспорт сессии | `opencode export <id>` | родной JSON round-trip |
| Импорт сессии | `opencode import <file>` | из JSON/URL |
| Удаление сессии | `opencode session delete <id>` | **после** бэкапа |
| Read `time_archived` и др. | `opencode db "<SELECT>" --format json` | read-only fallback |
| Архивирование | ❌ команды нет | используем backup-then-delete |

> ⚠️ stdout opencode загрязнён строкой `[page-assist] CLI mode ...`. JSON парсить через `parseJson()` (искать первый `{`/`[`). См. docs/ARCHITECTURE.md.

---

## Фаза 0: Подготовка и структура

### 0.1. Создать файл плагина

- **Файл**: `~/.config/opencode/plugins/session-manager.ts`
- **Создать** базовую структуру плагина с экспортом `SessionManagerPlugin`
- **Импортировать** типы из `@opencode-ai/plugin`
- **Проверка**: `opencode` стартует без ошибок, плагин загружается

### 0.2. Реализовать управление state-файлом

- **Файл**: тот же `session-manager.ts`
- **Что сделать:**
  - Константа `STATE_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'session-manager.json')`
  - Константа `DEFAULT_BACKUP_DIR = path.join(os.homedir(), '.local', 'share', 'opencode', 'backups')`
  - Функция `loadState(): SMState` — читает JSON, возвращает дефолтный state, если файл отсутствует
  - Функция `saveState(state: SMState): void` — атомарная запись (write to .tmp, rename)
  - Интерфейс `SMState`:
    ```typescript
    interface SMState {
      version: string                              // "1.0.0"
      settings: {
        autoCleanupEnabled: boolean                // default false
        autoCleanupDays: number                    // default 30
        backupRetentionEnabled: boolean            // default false
        backupRetentionDays: number                // default 30
        backupDir: string                          // default DEFAULT_BACKUP_DIR
      }
      pinned: Array<{ sessionId: string; title: string; pinnedAt: number; note: string }>
      lastAutoRun?: number | null                  // ms timestamp для debounce хука session.idle
    }
    ```
- **Проверка**: чтение и запись state-файла работают, дефолтный state создаётся при первом запуске

### 0.3. Реализовать CLI-обёртки для работы с сессиями

- **Файл**: тот же `session-manager.ts`
- **Способ вызова**: **Bun shell `$`** из контекста плагина (НЕ `child_process.execSync`).
  `$` доступен как аргумент функции плагина. См. docs/ARCHITECTURE.md «Вызов opencode CLI».
- **⚠️ Парсинг JSON толерантный**: stdout загрязнён строкой `[page-assist] CLI mode ...`.
  Перед `JSON.parse` искать первый `{`/`[` (см. `parseJson()` в docs/ARCHITECTURE.md).
- **Что сделать:**
  - `parseJson(stdout: string): unknown` — обрезает префикс-шум, парсит JSON
  - `async listSessions(): Promise<SessionInfo[]>` — `$\`opencode session list --format json\`` → `parseJson` → массив. Поля: `{ id, title, updated, created, projectId, directory }`
  - `async findSessionById(id): Promise<SessionInfo | null>` — `listSessions()` + find по `id`
  - `async searchSessions(query): Promise<SessionInfo[]>` — `listSessions()` + `title.toLowerCase().includes(query.toLowerCase())`
  - `async exportSession(id): Promise<string>` — `$\`opencode export ${id}\`` → вернуть stdout (родной JSON round-trip формата)
  - `async importSession(filePath): Promise<boolean>` — `$\`opencode import ${filePath}\`` → успех по exit code
  - `async deleteSession(id): Promise<boolean>` — `$\`opencode session delete ${id}\`` → успех по exit code (используется ТОЛЬКО в cleanup после бэкапа)
- **Read-only fallback** (только когда CLI не отдаёт поле): `$\`opencode db "<SELECT ...>" --format json\`` — например для чтения `time_archived`. Write-SQL запрещён.
- **Проверка**: каждая функция возвращает корректные данные для существующих сессий, graceful error (try/catch → null/[]) для несуществующих

### 0.4. ~~Проверка доступных CLI-команд opencode~~ ✅ ВЫПОЛНЕНО

Результат зафиксирован в **`docs/CLI-CAPABILITIES.md`** (источник истины). Ключевое:
- `opencode session list/delete` ✅; `archive` ❌ (не существует)
- `opencode export`/`import` ✅
- `opencode db "<sql>" --format json` ✅ (read-only)
- хук `session.idle` ✅ существует (см. доку plugins)
- плагины — локальные `.ts` в `~/.config/opencode/plugins/` автозагружаются ✅

---

## Фаза 1: Основные команды

### 1.1. Команда `sm-pin`

- **Вход**: sessionId (string)
- **Логика:**
  1. Проверить существование сессии через `findSessionById(id)` (CLI-обёртка)
  2. Если не найдена — вернуть ошибку `"Session not found: <id>"`
  3. Загрузить state через `loadState()`
  4. Проверить, не является ли сессия уже pinned (по sessionId)
  5. Если уже pinned — вернуть `"Already pinned: <title>"`
  6. Добавить объект `{ sessionId, title, pinnedAt: Date.now(), note: "" }` в `state.pinned`
  7. Сохранить через `saveState()`
  8. Вернуть `"Pinned: <title> (<sessionId>)"`
- **Схема args**: `{ sessionId: tool.schema.string(), note: tool.schema.string().optional() }`
- **Проверка**: пин сессии отражается в `session-manager.json`, повторный пин даёт сообщение

### 1.2. Команда `sm-unpin`

- **Вход**: sessionId (string)
- **Логика:**
  1. Загрузить state
  2. Найти entry по sessionId
  3. Если не найден — вернуть `"Not pinned: <id>"`
  4. Удалить из массива `state.pinned`
  5. Сохранить state
  6. Вернуть `"Unpinned: <title>"`
- **Проверка**: сессия исчезает из `session-manager.json`

### 1.3. Команда `sm-list`

- **Логика:**
  1. Загрузить state
  2. Если `state.pinned` пуст — вернуть `"No pinned sessions."`
  3. Для каждого pinned проверить актуальность через `findSessionById()` (CLI)
  4. Отформатировать вывод: таблица с колонками `ID (первые 12 символов)`, `Title`, `Pinned At (дата)`, `Note`
  5. Пометить неактуальные сессии (удалённые из БД) как `[DELETED]`
- **Формат вывода:**

```text
Pinned sessions (N):
──────────────────────────────────────────────
ID             Title                    Pinned          Note
──────────────────────────────────────────────
ses_0c53fa...  Мой проект               2026-07-07
ses_abc123...  Другая сессия            2026-07-06     Важно!
──────────────────────────────────────────────
```

- **Проверка**: вывод корректен, неактуальные сессии помечены

### 1.4. Команда `sm-search`

- **Вход**: query (string)
- **Логика:**
  1. Выполнить `searchSessions(query)` (CLI-обёртка + клиентский filter)
  2. Если пусто — вернуть `"No sessions match: <query>"`
  3. Для каждой сессии проверить, есть ли она в pinned-листе
  4. Отформатировать таблицу: `ID`, `Title`, `Last Updated`, `Pinned?`
  5. Pinned-сессии отметить звёздочкой `*`
- **Формат вывода:**

```text
Sessions matching "<query>" (N):
──────────────────────────────────────────────
ID             Title                    Updated         Pinned
──────────────────────────────────────────────
* ses_0c53...  Мой проект               2026-07-07      Yes
  ses_def456... Другая сессия           2026-07-06      No
──────────────────────────────────────────────
Use: opencode -s <full_id> to continue a session
```

- **Проверка**: поиск по подстроке работает, pinned-метки корректны

---

## Фаза 2: Бэкап и восстановление

### 2.1. Команда `sm-backup` (одна сессия)

- **Вход**: sessionId (string)
- **Логика:**
  1. Получить данные сессии через `exportSession(id)` (CLI) — это родной round-trip формат `{ info, messages }`
  2. Обернуть в envelope: `{ version: "1.0.0", exportedAt: Date.now(), backupOf: id, session: <exportedData> }`
     (`session` — целиком вывод `opencode export`, чтобы `opencode import` работал напрямую)
  3. Создать директорию `DEFAULT_BACKUP_DIR` (`mkdir -p`), если не существует
  4. Сохранить в `<backupDir>/<sessionId>.json` (атомарно: `.tmp` → rename)
  5. Вернуть `"Backed up: <title> -> <path>"`
- **Проверка**: файл создан, структура JSON корректна, можно открыть в редакторе

### 2.2. Команда `sm-backup-all`

- **Логика:**
  1. Загрузить state
  2. Для каждой pinned сессии выполнить логику `sm-backup`
  3. Вернуть сводку: сколько успешно, сколько провалено (сессия удалена из БД)
- **Формат вывода:**

```text
Backup complete: 5 backed up, 1 failed (session deleted)
```

- **Проверка**: все pinned сессии экспортированы

### 2.3. Команда `sm-restore`

- **Вход**: filePath (string), force (boolean, default false)
- **Логика:**
  1. Прочитать файл (если нет — ошибка)
  2. Валидация конверта: обязательные поля `version` (string `^\d+\.\d+\.\d+$`), `exportedAt` (number), `backupOf` (string), `session` (объект с `info` и `messages`)
  3. Проверить, не существует ли уже сессия с таким ID через `findSessionById()`
  4. Если существует И `force === false` → вернуть ошибку
     `"Session already exists: <id>. Re-run with force=true to overwrite (current one will be deleted first)."`
  5. Если `force === true` → сначала `deleteSession(id)` (старая сессия удалится каскадно)
  6. Записать только `session`-часть во временный файл и импортировать через `importSession(tmpPath)`
     (или `opencode import <file>` напрямую, если он принимает конверт — проверить; если нет, отделить конверт и передать только `session`)
  7. Вернуть `"Restored: <title> (<sessionId>)"`
- **Проверка**: сессия появляется в `opencode session list`, доступна через `-s <id>`

### 2.4. Команда `sm-full-backup` (полный архив)

- **Описание**: Создаёт полный набор для переноса на другую машину или восстановления после переустановки
- **Логика:**
  1. Сделать бэкап всех pinned сессий (как в 2.2)
  2. Скопировать `session-manager.json` в ту же директорию
  3. Скопировать файл плагина `session-manager.ts` в директорию бэкапа
  4. Создать `RESTORE.md` в директории бэкапа с инструкцией восстановления
  5. Вернуть путь к директории бэкапа
- **RESTORE.md содержание:**

```markdown
# OpenCode Session Restore

## Восстановление после переустановки

1. Установите opencode обычным способом
2. Скопируйте плагин:
   cp ./session-manager.ts ~/.config/opencode/plugins/
3. Скопируйте состояние:
   cp ./session-manager.json ~/.local/share/opencode/
4. Запустите opencode — плагин загрузится автоматически
5. Восстановите сессии по одной:
   opencode run "sm-restore ./ses_XXXXX.json"
   Или используйте:
   opencode import ./ses_XXXXX.json
6. Готово. Ваши pinned-сессии и настройки восстановлены.

## Настройка автоочистки

В TUI выполните:
  /sm-config autoCleanupEnabled true
  /sm-config autoCleanupDays 30

Или отредактируйте ~/.local/share/opencode/session-manager.json вручную.
```

- **Проверка**: после ручной симуляции переустановки (очистка БД) восстановление работает

---

## Фаза 3: Автоочистка

### 3.1. Команда `sm-settings`

- **Логика:**
  1. Загрузить state
  2. Отформатировать вывод настроек:

```text
Session Manager Settings:
──────────────────────────────────────────────
Auto-cleanup enabled:     true/false
Cleanup after (days):     30
Backup retention enabled: true/false
Backup retention (days):  30
Backup directory:         ~/.local/share/opencode/backups
Pinned sessions:          N
──────────────────────────────────────────────
```

- **Проверка**: настройки отображаются корректно

### 3.2. Команда `sm-config`

- **Вход**: key (string), value (string)
- **Поддерживаемые ключи:**
  - `autoCleanupEnabled` — `true` / `false`
  - `autoCleanupDays` — число (дни неактивности → cleanup)
  - `backupRetentionEnabled` — `true` / `false`
  - `backupRetentionDays` — число (дни → ротация бэкапов)
  - `backupDir` — абсолютный путь
- **Логика:**
  1. Загрузить state
  2. Проверить валидность key (whitelist)
  3. Преобразовать value к правильному типу (boolean, number, string)
  4. Обновить `state.settings[key]`
  5. Сохранить state
  6. Вернуть `"Setting updated: <key> = <value>"`
- **Проверка**: настройка сохраняется и применяется

### 3.3. Команда `sm-cleanup` (ручной запуск; backup-then-delete)

> Команды `opencode session archive` НЕ существует. Стратегия: **сначала бэкап, потом
> `opencode session delete`**. Так ничего не теряется — старая сессия переезжает в `backups/`.

- **Логика:**
  1. Загрузить state
  2. `cutoff = Date.now() - settings.autoCleanupDays * 86400000`
  3. `listSessions()` (CLI)
  4. Кандидаты: `updated < cutoff` И id НЕ в `state.pinned[].sessionId`
  5. Для каждого кандидата:
     1. `exportSession(id)` → если упало, **пропустить** (не удалять без бэкапа)
     2. Записать в `backups/<id>.json` (конверт с `exportedAt`, `backupOf` + тело export)
     3. Только после успешной записи → `deleteSession(id)` (`opencode session delete`)
     4. Если delete упал — бэкап оставить, залогировать ошибку
  6. Вернуть отчёт:

```text
Cleanup complete: N sessions backed up + deleted, M skipped (pinned), K failed
  ✗ ses_XXX: "Old session 1" → backups/ses_XXX.json (last active: 2026-06-01)
  ✗ ses_YYY: "Old session 2" → backups/ses_YYY.json (last active: 2026-05-15)
```

- **Проверка**: только непinned старые сессии удалены; у каждой удалённой есть свежий бэкап; pinned сохранены

### 3.4. Автоматический триггер (session.idle)

- **Хук `session.idle` существует** — подтверждено в `docs/CLI-CAPABILITIES.md` (дока plugins).
- **Hook**: `"session.idle"`
- **Логика** (общий debounce для cleanup + backup-retention):
  1. Прочитать `state.lastAutoRun` (ms). Если `Date.now() - lastAutoRun < 3600000` → выходим (debounce 1 ч)
  2. Если `autoCleanupEnabled` → логика из 3.3
  3. Если `backupRetentionEnabled` → логика из 3.5
  4. Записать `state.lastAutoRun = Date.now()`, сохранить state
  5. `client.app.log({ body: { service: "session-manager", level: "info", message: ... } })`
- **Важно**: не блокировать пользователя; ошибки логировать, не валить хук.
- **Проверка**: при включённых настройках старые непinned сессии автоматически бэкапятся+удаляются, stale бэкапы ротируются; повторный запуск в течение часа — no-op.

### 3.5. Ротация бэкапов — `sm-cleanup-backups` (+ авто)

> Цель: гигиена `backups/`. **Безопасность**: удаляются только stale re-exportable бэкапы
> (сессия ещё жива в БД и не pinned — можно переэкспортировать). Pinned-бэкапы и
> orphaned-бэкапы (сессии уже нет в БД = единственная копия) **защищены навсегда**.

- **Команда**: `sm-cleanup-backups` (без аргументов)
- **Логика:**
  1. Загрузить state. Если `backupRetentionEnabled === false` → выход с сообщением
  2. `cutoff = Date.now() - settings.backupRetentionDays * 86400000`
  3. `sessions = listSessions()` (CLI) → построить `Set` живых id + множество pinned id
  4. Для каждого `<id>.json` в `backups/`:
     - Прочитать конверт, взять `exportedAt` и `backupOf`
     - Если `backupOf` в pinned → **SKIP** (protected)
     - Если `backupOf` НЕ в `sessions` (orphaned) → **SKIP** (protected — единственная копия)
     - Если `exportedAt < cutoff` → удалить файл
  5. Вернуть отчёт:

```text
Backup rotation: N removed, M protected (pinned/orphaned), K skipped (recent)
  ✗ ses_XXX.json (exported 2026-05-01, session still alive)
```

- **Авто-триггер**: в хуке `session.idle` вместе с cleanup (см. 3.4), тот же debounce.
- **Edge cases**: битый/нечитаемый JSON-конверт → переименовать в `<id>.json.corrupt`, залогировать, не удалять.
- **Проверка**: свежие бэкапы живых непinned сессий остаются; pinned и orphaned не трогаются; удаляются только старые re-exportable.

---

## Фаза 4: Robustness и UX

### 4.1. Обработка ошибок

- Все операции с файловой системой обернуты в try/catch
- Ошибки CLI (команда не найдена, неверный формат вывода) — graceful fallback с понятным сообщением
- Коррупция `session-manager.json` — пересоздание с дефолтным state + предупреждение
- Потеря БД opencode при переустановке — плагин сообщает, что сессии не найдены, и предлагает восстановить из бэкапов

### 4.2. Миграция state

- Поле `version` в state-файле позволяет делать миграции структуры
- Текущая версия: `"1.0.0"`
- При изменении схемы — функция `migrateState(oldState): SMState`

### 4.3. JSON Schema для бэкапов

- **Файл**: `backup-schema.json` (в проекте)
- Определить JSON Schema для валидации файлов бэкапа
- Использовать в `sm-restore` для проверки структуры перед импортом
- Поля: `version` (string, pattern `^\d+\.\d+\.\d+$`), `exportedAt` (integer), `backupOf` (string)

### 4.4. Документация внутри плагина

- JSDoc комментарии для каждого tool
- В начале файла — блок комментария с описанием плагина, версией, автором, инструкцией по установке
