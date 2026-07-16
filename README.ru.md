# OpenCode Session Manager — Russian README

## Что это

Плагин opencode для управления сессиями: pin, backup, restore, auto-cleanup, search.
Работает через естественный язык — модель сама вызывает нужные tools.

## Возможности

- Pin/unpin сессий для защиты от автоочистки
- Бэкап отдельных сессий и всех pinned
- Восстановление из бэкапа (с force-перезаписью)
- Полный бэкап для переноса на другую машину
- Поиск сессий по подстроке в названии
- Auto-cleanup старых непinned сессий (backup-then-delete)
- Ротация старых бэкапов с защитой pinned и orphaned
- Настройка через `sm_config` и просмотр через `sm_settings`

## Установка

```bash
git clone <repo> && cd opencode-session-manager && ./install.sh
```

Скрипт соберёт npm-пакет и добавит его в `plugin[]` вашего `opencode.json`.
Перезапустите opencode после установки.
Подробности по использованию — см. `USAGE.md`.

## Архитектура

### Хранение

State-файл `session-manager.json` хранит pinned-список и настройки.
Запись атомарная: `.tmp` → `rename`. Бэкапы в `backups/<id>.json`.
Всё лежит вне БД opencode — переживёт переустановку.

### CLI-first

Все операции с сессиями идут через `opencode` CLI (Bun shell `$`), не через прямой SQL.
Write-SQL запрещён. `parseJson` терпит `[page-assist]`-шум в stdout.

### Backup envelope

Формат: `{version, exportedAt, backupOf, session}`, где `session` — сырой `opencode export`
(родной round-trip для `opencode import`). Формализован в `backup-schema.json`.

### Backup-then-delete

Удаление только после успешного бэкапа. Команды `opencode session archive` не существует,
поэтому cleanup = бэкап → `opencode session delete`.

### Protected backups

Pinned-бэкапы и orphaned (сессии уже нет в БД — это единственная копия) защищены навсегда.
Corrupt-файлы переименовываются в `.corrupt`.

### Хуки

- `session.idle` — auto cleanup + backup retention; дебаунс 1 час через `lastAutoRun`
- `session.deleted` — уборка удалённой сессии из pinned-списка
- Хуки никогда не роняют opencode (try/catch на каждом уровне)

### Миграция

`version` в state + `migrateState` (merge-with-defaults) для будущих изменений схемы.

## Файлы проекта

| Файл | Описание |
|---|---|
| `session-manager.ts` | Плагин (12 tools, 2 hooks) |
| `backup-schema.json` | JSON Schema backup envelope |
| `USAGE.md` | Пользовательский гайд |
| `README.md` | Dev-спека (API, CLI capabilities) |
| `docs/CLI-CAPABILITIES.md` | Поддерживаемые CLI-команды |

## Детали

Для технической документации уровня разработки см. `docs/ARCHITECTURE.md`, `docs/SPEC.md` и `docs/CLI-CAPABILITIES.md`.
