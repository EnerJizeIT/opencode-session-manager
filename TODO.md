# TODO — Реализация OpenCode Session Manager Plugin

## Запреты

- НЕ менять схему БД opencode (не создавать новые таблицы, не добавлять колонки)
- НЕ трогать `opencode.db` напрямую без необходимости — использовать CLI `opencode db` или Bun.sql
- НЕ изменять поведение встроенных команд opencode
- НЕ коммитить `session-manager.json` и бэкапы в git — это пользовательские данные

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
  - Интерфейс `SMState` с полями `version`, `settings`, `pinned[]`
- **Проверка**: чтение и запись state-файла работают, дефолтный state создаётся при первом запуске

### 0.3. Реализовать вспомогательные функции для работы с БД

- **Файл**: тот же `session-manager.ts`
- **Что сделать:**
  - Функция `getDbPath(): string` — получает путь через `opencode db path` или хардкод `~/.local/share/opencode/opencode.db`
  - Функция `queryDb(sql: string, params?: any[]): any[]` — выполняет SQL через Bun.sql или child_process вызов `opencode db`
  - Функция `getSessionById(id: string)` — `SELECT * FROM session WHERE id = ?`
  - Функция `searchSessions(query: string)` — `SELECT id, title, time_updated FROM session WHERE title LIKE '%query%' ORDER BY time_updated DESC LIMIT 20`
  - Функция `deleteSessionFromDb(id: string)` — `DELETE FROM session WHERE id = ?` (каскадное удаление message/part)
  - Функция `exportSessionToJson(id: string)` — собирает session + messages + parts в один JSON объект
  - Функция `importSessionFromJson(json: object)` — вставляет данные в БД (использует `opencode import` или прямой SQL INSERT)
- **Проверка**: каждый запрос возвращает корректные данные для существующих сессий

---

## Фаза 1: Основные команды

### 1.1. Команда `sm-pin`

- **Вход**: sessionId (string)
- **Логика:**
  1. Проверить существование сессии в БД через `getSessionById`
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
  3. Для каждого pinned проверить актуальность в БД (сессия ещё существует?)
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
  1. Выполнить `searchSessions(query)`
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
  1. Получить сессию из БД: `SELECT * FROM session WHERE id = ?`
  2. Получить сообщения: `SELECT * FROM message WHERE session_id = ?`
  3. Получить части: `SELECT * FROM part WHERE session_id = ?`
  4. Собрать в объект: `{ version: "1.0.0", exportedAt: Date.now(), session: {...}, messages: [...], parts: [...] }`
  5. Создать директорию `DEFAULT_BACKUP_DIR`, если не существует
  6. Сохранить в `<backupDir>/<sessionId>.json`
  7. Вернуть `"Backed up: <title> -> <path>"`
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

- **Вход**: filePath (string) — путь к JSON-файлу бэкапа
- **Логика:**
  1. Прочитать файл
  2. Валидация структуры: наличие полей `session`, `messages`, `parts`
  3. Проверить, не существует ли уже сессия с таким ID в БД
  4. Если существует — вернуть ошибку или предложить форс-импорт (перезаписать)
  5. Вставить record `session` в БД
  6. Вставить records `message`
  7. Вставить records `part`
  8. Альтернатива: использовать `opencode import <file>`, если формат совместим
  9. Вернуть `"Restored: <title> (<sessionId>)"`
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
Auto-cleanup enabled:  true/false
Cleanup after (days):  30
Backup directory:      ~/.local/share/opencode/backups
Pinned sessions:       N
──────────────────────────────────────────────
```

- **Проверка**: настройки отображаются корректно

### 3.2. Команда `sm-config`

- **Вход**: key (string), value (string)
- **Поддерживаемые ключи:**
  - `autoCleanupEnabled` — `true` / `false`
  - `autoCleanupDays` — число (дни неактивности перед удалением)
  - `backupDir` — абсолютный путь
- **Логика:**
  1. Загрузить state
  2. Проверить валидность key
  3. Преобразовать value к правильному типу (boolean, number, string)
  4. Обновить `state.settings[key]`
  5. Сохранить state
  6. Вернуть `"Setting updated: <key> = <value>"`
- **Проверка**: настройка сохраняется и применяется

### 3.3. Команда `sm-cleanup` (ручной запуск)

- **Логика:**
  1. Загрузить state
  2. Получить cutoff timestamp: `Date.now() - settings.autoCleanupDays * 86400000`
  3. Запросить старые сессии: `SELECT id, title, time_updated FROM session WHERE time_updated < ? AND time_archived IS NULL`
  4. Исключить pinned сессии (фильтрация по `state.pinned[].sessionId`)
  5. Для каждого кандидата на удаление:
     - Опционально: сделать бэкап перед удалением (если включено)
     - Удалить из БД: `DELETE FROM session WHERE id = ?` (каскадно удалит message/part)
  6. Вернуть отчёт:

```text
Cleanup complete: N sessions removed, M skipped (pinned)
Removed:
  - ses_XXX: "Old session 1" (last active: 2026-06-01)
  - ses_YYY: "Old session 2" (last active: 2026-05-15)
```

- **Проверка**: только непinned старые сессии удалены, pinned сохранены

### 3.4. Автоматический триггер автоочистки

- **Hook**: `session.idle` (вызывается, когда сессия становится idle)
- **Логика:**
  1. Проверить `settings.autoCleanupEnabled === true`
  2. Проверить, не запускалась ли очистка менее 1 часа назад (debounce, хранить timestamp в state)
  3. Если пора — запустить логику очистки (как в 3.3)
  4. Логировать результат через `client.app.log()`
- **Важно**: автоочистка НЕ должна блокировать работу пользователя, должна быть background-операцией
- **Проверка**: при включённой автоочистке старые непinned сессии удаляются автоматически

---

## Фаза 4: Robustness и UX

### 4.1. Обработка ошибок

- Все операции с файловой системой обернуты в try/catch
- Ошибки БД (БД заблокирована, не найдена) — graceful fallback с понятным сообщением
- Коррупция `session-manager.json` — пересоздание с дефолтным state + предупреждение
- Потеря БД opencode при переустановке — плагин сообщает, что БД не найдена, и предлагает восстановить из бэкапов

### 4.2. Миграция state

- Поле `version` в state-файле позволяет делать миграции структуры
- Текущая версия: `"1.0.0"`
- При изменении схемы — функция `migrateState(oldState): SMState`

### 4.3. Документация внутри плагина

- JSDoc комментарии для каждого tool
- В начале файла — блок комментария с описанием плагина, версией, автором, инструкцией по установке
