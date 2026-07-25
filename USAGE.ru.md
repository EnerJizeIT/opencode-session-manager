# USAGE — OpenCode Session Manager

[English](https://github.com/EnerJizeIT/opencode-session-manager/blob/master/USAGE.md) · [README](https://github.com/EnerJizeIT/opencode-session-manager/blob/master/README.ru.md)

## Как пользоваться

Пиши обычным языком в чат — модель сама вызовет нужный `sm_*` tool. Слеш-команд нет.

**ID сессии** нужен для pin/backup/restore. Где взять:
- в терминале: `opencode session list`
- или: «найди сессию про X» → `sm_search` покажет ID в таблице.

## Сценарии

| Ты говоришь | Tool | Что получится |
|---|---|---|
| «запинть ses_abc123» | `sm_pin` | сессия защищена от автоочистки |
| «открепи ses_abc123» | `sm_unpin` | убрана из закреплённых |
| «покажи закреплённые» | `sm_list` | таблица + готовые `opencode -s <id>` для возобновления |
| «найди сессию про платёж» | `sm_search` | совпадения по названию; pinned помечены `*` |
| «сделай бэкап ses_abc123» | `sm_backup` | файл в `backups/` + подсказка как восстановить |
| «забэкапь все закреплённые» | `sm_backup_all` | сводка: N сохранено, M failed |
| «восстанови из backups/ses_xxx.json» | `sm_restore` | сессия импортирована; `force=true` для перезаписи |
| «полный бэкап для переноса» | `sm_full_backup` | архив: сессии + state + плагин + RESTORE.md |
| «покажи настройки» | `sm_settings` | autoCleanup, retention, backupDir, pinned count |
| «включи автоочистку через 30 дней» | `sm_config` | `autoCleanupEnabled=true` + `autoCleanupDays=30` |
| «почисти старые незакреплённые» | `sm_cleanup` | backup-then-delete; pinned пропускаются |
| «ротация старых бэкапов» | `sm_cleanup_backups` | удаляет старые; защищает pinned и orphaned |

## Команды терминала

Плагин управляет сессиями (pin/backup/restore данных). Чтобы реально **открыть или возобновить** сессию в opencode — используй терминал:

- `opencode session list` — список всех сессий и их ID (альтернатива `sm_search`).
- `opencode -s <session_id>` — возобновить конкретную сессию. Используй после `sm_restore` (чтобы открыть восстановленную) или чтобы переключиться на закреплённую. `sm_list` печатает эти команды готовыми к копированию.
- `opencode export <id> > file.json` — ручной экспорт (продвинутое; `sm_backup` оборачивает это).

**Типичный поток:** `sm_restore` (в чате) импортирует сессию → выполни `opencode -s <id>` (в терминале), чтобы её продолжить.

## Быстрый пример: открыть закреплённую сессию

1. В чате скажи: **«покажи закреплённые»** → `sm_list` выдаст таблицу и блок команд:
   ```
   Resume a pinned session (copy a line into your shell):
     opencode -s ses_099136ce0ffeSVRXKPfZ2IKglc   # Анализ agentic-workflow
   ```
2. Скопируй нужную строку `opencode -s ses_…`.
3. Вставь её в терминал и нажми Enter — сессия откроется.

**Восстановить удалённую:** «восстанови из backups/ses_xxx.json» (`sm_restore`) → в выводе будет `resume: opencode -s ses_xxx` — скопируй и запусти в терминале.

## Быстрый пример: только терминал (без чата)

Список закреплённых и восстановление — прямо из shell:

```bash
# 1. Закреплённые сессии (ID + title):
jq -r '.pinned[] | "\(.sessionId)  \(.title)"' ~/.local/share/opencode/session-manager.json

# 2. Доступные бэкапы:
ls ~/.local/share/opencode/backups/

# 3. Восстановить сессию из бэкапа:
opencode import ~/.local/share/opencode/backups/ses_xxx.json

# 4. Открыть восстановленную:
opencode -s ses_xxx
```

## Настройки (`sm_config`)

Ключи: `autoCleanupEnabled`, `autoCleanupDays`, `backupRetentionEnabled`, `backupRetentionDays`, `backupDir`.
Пример: «поставь autoCleanupDays 14».

## Автоматика

Если включены `autoCleanup` / `backupRetention` — хук `session.idle` (раз в час) сам чистит и ротирует.
Pinned-сессии и их бэкапы защищены всегда; удаление только после успешного бэкапа.

**Где хранится:** state — `~/.local/share/opencode/session-manager.json`, бэкапы — `~/.local/share/opencode/backups/`.
