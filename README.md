# OpenCode Session Manager Plugin

Плагин для [OpenCode](https://opencode.ai) — pin-сессий, бэкап, восстановление, автоочистка и поиск.

## О проекте

**OpenCode Session Manager** — это плагин для [OpenCode](https://opencode.ai), open-source AI-агента для разработки в терминале.

### Для кого

Для пользователей opencode, которые работают с большим количеством сессий и хотят надёжно управлять ими: сохранять важные разговоры, быстро находить нужные, автоматически чистить старые и восстанавливать всё после переустановки программы.

### Проблема

OpenCode хранит все сессии в единой SQLite-базе `~/.local/share/opencode/opencode.db`. Таблица `session` содержит 29 колонок (`id`, `title`, `metadata`, `time_created`, `time_updated` и др.), таблицы `message` и `part` содержат содержимое сообщений. Сессий может накапливаться сотни (на момент написания — 381).

У пользователя возникают четыре проблемы:

1. **Риск потери важных сессий.** При переустановке opencode, очистке кэша или случайном удалении `~/.local/share/opencode/` все сессии безвозвратно теряются. Нет встроенного механизма бэкапа или экспорта «избранных» сессий.

2. **Нет быстрого доступа к нужным сессиям.** Чтобы продолжить старую сессию, нужно знать её ID (`opencode -s <id>`). В TUI нет удобного fuzzy-search по заголовкам сессий для быстрого запуска. Пользователь не может создать «кнопку» или алиас на конкретную сессию.

3. **Нет управления жизненным циклом сессий.** Нет понятия «pinned» (избранная) сессия. Нет автоматической очистки старых сессий по таймауту неактивности. БД разрастается, пользователь не может настроить политику хранения.

4. **Нет переносимости.** Если пользователь удаляет opencode и устанавливает заново, он теряет всё. Нет инструкции «в один клик», чтобы восстановить сессии и конфигурацию плагина.

### Что делает плагин

Плагин добавляет кастомные команды в TUI opencode для управления сессиями:

- **Pin / Unpin** — отметить сессию как избранную; pinned-сессии защищены от автоочистки
- **Search** — поиск по заголовкам всех сессий с отметкой pinned
- **Backup / Restore** — экспорт отдельных сессий в JSON и восстановление из них
- **Full Backup** — создание полного архива (плагин + настройки + бэкапы сессий) для переноса на другую машину или восстановления после переустановки
- **Auto-cleanup** — автоматическое удаление непinned сессий старше N дней неактивности
- **Settings** — управление параметрами через команды или вручную в JSON-файле

### Ключевое свойство: самодостаточность

Плагин спроектирован так, чтобы после чистой установки opencode достаточно выполнить три шага:

1. Скопировать файл плагина в `~/.config/opencode/plugins/`
2. Скопировать файл состояния в `~/.local/share/opencode/`
3. Восстановить сессии из бэкапов

После этого всё работает: pinned-список, настройки, сессии — всё на месте.

---

## Решение (абстрактно)

Необходимо реализовать **плагин opencode** (`session-manager.ts`), который:

1. Добавляет кастомные CLI-команды через TUI для управления сессиями: pin/unpin, экспорт, поиск, автоочистка.
2. Ведёт метаданные pinned-сессий во внешнем JSON-файле (не в БД opencode), чтобы пережить переустановку.
3. Предоставляет механизм полного бэкапа (сессии + конфиг плагина) и восстановления из бэкапа.
4. Реализует автоочистку непinned сессий старше N дней неактивности.
5. Интегрируется с event-системой opencode для отслеживания создания, удаления и изменения сессий.

---

## Архитектура решения

### Хранение данных

| Что | Где | Формат |
| --- | --- | --- |
| Pinned-сессии + настройки | `~/.local/share/opencode/session-manager.json` | JSON |
| Бэкапы сессий | `~/.local/share/opencode/backups/` | JSON (по одному файлу на сессию) |
| Полный бэкап (архив) | Указывает пользователь | ZIP с `session-manager.json` + `.json` бэкапами |

Файл `session-manager.json`:

```json
{
  "version": "1.0.0",
  "settings": {
    "autoCleanupDays": 30,
    "autoCleanupEnabled": false,
    "backupDir": "~/.local/share/opencode/backups"
  },
  "pinned": [
    {
      "sessionId": "ses_abc123...",
      "title": "Мой важный проект",
      "pinnedAt": 1783397000000,
      "note": "Описание, почему это важно"
    }
  ]
}
```

### Подписка на события

Плагин использует hook-события opencode:

- `session.created` — логирование, опциональный автобэкап
- `session.deleted` — удаление из pinned-листа, если сессия была pinned
- `session.idle` — триггер для проверки автоочистки

### Кастомные команды (TUI)

Реализуются через plugin custom tools, доступные пользователю как `/sm-<action>`:

| Команда | Описание |
| --- | --- |
| `/sm-pin <sessionId>` | Добавить сессию в избранное |
| `/sm-unpin <sessionId>` | Убрать сессию из избранного |
| `/sm-list` | Показать список pinned сессий |
| `/sm-search <query>` | Fuzzy-поиск по заголовкам всех сессий |
| `/sm-backup <sessionId>` | Экспорт одной сессии в JSON в backupDir |
| `/sm-backup-all` | Экспорт всех pinned сессий |
| `/sm-restore <file>` | Импорт сессии из JSON-файла |
| `/sm-full-backup` | Полный архив: плагин + state + бэкапы pinned сессий |
| `/sm-cleanup` | Запустить автоочистку вручную |
| `/sm-settings` | Показать текущие настройки |
| `/sm-config <key> <value>` | Изменить настройку (например, `autoCleanupDays 30`) |

---

## Инструкция восстановления (для пользователя)

```text
Установка плагина после переустановки opencode:

1. Установите opencode обычным способом
2. Скопируйте плагин:
   cp /path/to/backup/session-manager.ts ~/.config/opencode/plugins/
3. Скопируйте состояние:
   cp /path/to/backup/session-manager.json ~/.local/share/opencode/
4. Если БД opencode новая или пустая — восстановите сессии:
   Для каждой сессии:
     opencode run "sm-restore /path/to/backup/ses_XXXXX.json"
   Или используйте:
     opencode import /path/to/backup/ses_XXXXX.json
5. Готово. Ваши pinned-сессии и настройки восстановлены.

Настройка автоочистки:

В TUI выполните:
  /sm-config autoCleanupEnabled true
  /sm-config autoCleanupDays 30

Или отредактируйте ~/.local/share/opencode/session-manager.json вручную.
```

---

## Структура файлов после установки

```text
~/.config/opencode/
└── plugins/
    └── session-manager.ts          # Сам плагин

~/.local/share/opencode/
├── opencode.db                     # БД opencode (системная)
├── session-manager.json            # State плагина (pinned + settings)
└── backups/                        # Директория бэкапов
    ├── ses_0c53fa9bfffehgm2pRZhY6o7IB.json
    ├── ses_0ce6509a0ffe4n3kGj7nKutbWJ.json
    └── ...
```

---

## Схема данных БД opencode (справочно)

### Таблица `session`

Ключевые колонки:

- `id` (TEXT PK) — уникальный ID сессии (формат `ses_XXXXXXXX...`)
- `title` (TEXT NOT NULL) — заголовок сессии
- `directory` (TEXT NOT NULL) — рабочая директория
- `metadata` (TEXT) — JSON-метаданные
- `time_created` (INTEGER NOT NULL) — unix ms
- `time_updated` (INTEGER NOT NULL) — unix ms
- `time_archived` (INTEGER) — unix ms, если архивирована
- `project_id` (TEXT NOT NULL FK → project.id ON DELETE CASCADE)

### Таблица `message`

- `id` (TEXT PK)
- `session_id` (TEXT NOT NULL)
- `data` (TEXT NOT NULL) — JSON содержимое
- `time_created`, `time_updated` (INTEGER)

### Таблица `part`

- `id` (TEXT PK)
- `message_id` (TEXT NOT NULL)
- `session_id` (TEXT NOT NULL)
- `data` (TEXT NOT NULL) — JSON содержимое
- `time_created`, `time_updated` (INTEGER)

Удаление `session` каскадно удаляет связанные `message` и `part`.
