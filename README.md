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

Плагин добавляет кастомные tools в opencode для управления сессиями:

- **Pin / Unpin** — отметить сессию как избранную; pinned-сессии защищены от автоочистки
- **Search** — поиск по заголовкам всех сессий с отметкой pinned
- **Backup / Restore** — экспорт отдельных сессий в JSON и восстановление из них
- **Full Backup** — создание полного архива (плагин + настройки + бэкапы сессий) для переноса на другую машину или восстановления после переустановки
- **Auto-cleanup** — автоматический backup-then-delete непinned сессий старше N дней неактивности
- **Backup retention** — ротация stale re-exportable бэкапов старше N дней (pinned- и orphaned-бэкапы защищены)
- **Settings** — управление параметрами через tools или вручную в JSON-файле

### Ключевое свойство: самодостаточность

Плагин спроектирован так, чтобы после чистой установки opencode достаточно выполнить три шага:

1. Скопировать файл плагина в `~/.config/opencode/plugins/`
2. Скопировать файл состояния в `~/.local/share/opencode/`
3. Восстановить сессии из бэкапов

После этого всё работает: pinned-список, настройки, сессии — всё на месте.

---

## Связанные плагины

### opencode-mem

[**opencode-mem**](https://github.com/tickernelz/opencode-mem) — плагин для персистентной памяти AI-агента между сессиями на основе локальной векторной БД (SQLite + USearch).

**Что умеет:**
- Сохранение и семантический поиск «воспоминаний» по проекту
- Авто-захват контекста из сессий через AI (summarization)
- User profile learning — запоминание предпочтений пользователя
- Web UI на порту 4747 для просмотра/управления
- Компактификация и дедупликация
- Multi-provider (OpenAI, Anthropic, локальные эмбеддинги)

**Как установить:**

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["opencode-mem"]
}
```

**Как они работают вместе:**

| Session Manager | opencode-mem |
| --- | --- |
| Pin/unpin сессий | Семантический поиск по контексту |
| Бэкап/восстановление сессий | Авто-захват ключевых решений из сессий |
| Автоочистка старых сессий | Векторная БД с компактификацией |
| Жизненный цикл сессий | Долгосрочная память агента |

Session Manager защищает сессии от потери, opencode-mem извлекает из них знания для будущих сессий. Установленные вместе они покрывают полный жизненный цикл: создание → извлечение контекста → сохранение → восстановление.

---

## Решение (абстрактно)

Необходимо реализовать **плагин opencode** (`session-manager.ts`), который:

1. Добавляет кастомные tools (вызываются моделью) для управления сессиями: pin/unpin, экспорт, поиск, cleanup.
2. Ведёт метаданные pinned-сессий во внешнем JSON-файле (не в БД opencode), чтобы пережить переустановку.
3. Предоставляет механизм полного бэкапа (сессии + конфиг плагина) и восстановления из бэкапа.
4. Реализует автоочистку по схеме backup-then-delete непinned сессий старше N дней неактивности и ротацию устаревших бэкапов.
5. Интегрируется с event-системой opencode (`session.deleted`, `session.idle`).

---

## Архитектура решения

> Реальные возможности opencode CLI/SDK зафиксированы в **[`CLI-CAPABILITIES.md`](./CLI-CAPABILITIES.md)** —
> источник истины. Спека сверяется с ним, а не наоборот.

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
    "autoCleanupEnabled": false,
    "autoCleanupDays": 30,
    "backupRetentionEnabled": false,
    "backupRetentionDays": 30,
    "backupDir": "~/.local/share/opencode/backups"
  },
  "pinned": [
    {
      "sessionId": "ses_abc123...",
      "title": "Мой важный проект",
      "pinnedAt": 1783397000000,
      "note": "Описание, почему это важно"
    }
  ],
  "lastAutoRun": null
}
```

### Подписка на события

Плагин использует hook-события opencode (подтверждено докой plugins — см. `CLI-CAPABILITIES.md`):

- `session.deleted` — убрать удалённую сессию из pinned-листа
- `session.idle` — автоочистка старых непinned сессий + ротация бэкапов (если включены в настройках, с debounce 1 ч)

### Кастомные tools

Реализуются через plugin custom tools (`tool({ description, args, execute })`). Это **tools,
которые вызывает сама модель** — пользователь пишет естественно («запинть сессию X»,
«найди сессию про платёж», «почисти старые сессии») и агент вызывает нужный tool.
Это **не** слеш-команды, набираемые вручную (для тех есть отдельная механика opencode Commands — вне MVP).

| Tool | Аргументы | Описание |
| --- | --- | --- |
| `sm_pin` | `sessionId`, `note?` | Добавить сессию в избранное |
| `sm_unpin` | `sessionId` | Убрать сессию из избранного |
| `sm_list` | — | Список pinned сессий (с пометкой удалённых `[DELETED]`) |
| `sm_search` | `query` | Поиск по заголовкам всех сессий, с пометкой pinned |
| `sm_backup` | `sessionId` | Экспорт одной сессии в `backups/<id>.json` |
| `sm_backup_all` | — | Экспорт всех pinned сессий |
| `sm_restore` | `filePath`, `force?` | Импорт сессии из JSON-файла (force — перезаписать существующую) |
| `sm_full_backup` | — | Полный архив: плагин + state + бэкапы pinned сессий |
| `sm_cleanup` | — | Бэкап + удаление (`opencode session delete`) старых непinned сессий |
| `sm_cleanup_backups` | — | Ротация stale re-exportable бэкапов (pinned/orphaned защищены) |
| `sm_settings` | — | Показать текущие настройки |
| `sm_config` | `key`, `value` | Изменить настройку (`autoCleanupDays`, `backupRetentionEnabled`, ...) |

> ⚠️ В opencode **нет** `opencode session archive`. Очистка работает по схеме **backup-then-delete**:
> сначала `opencode export` → файл, затем `opencode session delete`. Подробнее в TODO Фаза 3.

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

> ⚠️ `opencode session list --format json` отдаёт поля `id, title, updated, created, projectId, directory`
> (названия `created`/`updated`, а не `time_*`). Поле `time_archived` через CLI **недоступно** — только
> через read-only `opencode db`. Поэтому cleanup опирается на `updated`, а не на `time_archived`.
> См. `CLI-CAPABILITIES.md`.
