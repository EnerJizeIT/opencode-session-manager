# USAGE — OpenCode Session Manager

[English](./USAGE.md) · [README](./README.ru.md)

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

## Настройки (`sm_config`)

Ключи: `autoCleanupEnabled`, `autoCleanupDays`, `backupRetentionEnabled`, `backupRetentionDays`, `backupDir`.
Пример: «поставь autoCleanupDays 14».

## Автоматика

Если включены `autoCleanup` / `backupRetention` — хук `session.idle` (раз в час) сам чистит и ротирует.
Pinned-сессии и их бэкапы защищены всегда; удаление только после успешного бэкапа.

**Где хранится:** state — `~/.local/share/opencode/session-manager.json`, бэкапы — `~/.local/share/opencode/backups/`.
