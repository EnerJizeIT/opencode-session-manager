# USAGE — OpenCode Session Manager

## Установка

Скопируйте `session-manager.ts` в `~/.config/opencode/plugins/`.
Плагин загружается автоматически при старте opencode.
Состояние хранится в `~/.local/share/opencode/session-manager.json`.
Бэкапы сессий — в `~/.local/share/opencode/backups/`.

## Как это работает

Пишете обычным языком в чат — модель вызывает нужный `sm_*` tool.
Слеш-команды не нужны: модель сама определяет, какой инструмент использовать.

## Сценарии

| Вы говорите | Tool | Пример вывода |
|---|---|---|
| «запинь сессию ses_abc123» | `sm_pin` | `Pinned: My Session (ses_abc123...)` |
| «открепи ses_abc123» | `sm_unpin` | `Unpinned: My Session` |
| «покажи закреплённые» | `sm_list` | Таблица с ID, title, датой; удалённые помечены `[DELETED]` |
| «найди сессию про платёж» | `sm_search` | Список совпадений; pinned помечены `*` |
| «сделай бэкап сессии ses_abc123» | `sm_backup` | `Backed up: My Session -> ~/.local/share/.../ses_abc123.json` |
| «забэкапь все закреплённые» | `sm_backup_all` | `Backup complete: 3 backed up, 0 failed` |
| «восстанови из backups/ses_xxx.json» | `sm_restore` | `Restored: My Session (ses_xxx...)`; `force=true` для перезаписи |
| «полный бэкап для переноса на другую машину» | `sm_full_backup` | Архив: сессии + state + плагин + RESTORE.md |
| «покажи настройки» | `sm_settings` | Таблица: autoCleanup, retention, backupDir, pinned count |
| «включи автоочистку, старше 30 дней» | `sm_config` | `sm_config autoCleanupEnabled true` + `sm_config autoCleanupDays 30` |
| «почисти старые незакреплённые сессии» | `sm_cleanup` | Backup-then-delete; pinned пропускаются |
| «ротация старых бэкапов» | `sm_cleanup_backups` | Удаляет старые; защищает pinned и orphaned |

### Настройка через sm_config

Доступные ключи: `autoCleanupEnabled`, `autoCleanupDays`, `backupRetentionEnabled`, `backupRetentionDays`, `backupDir`.

```
sm_config autoCleanupEnabled true
sm_config autoCleanupDays 30
sm_config backupRetentionEnabled true
sm_config backupRetentionDays 30
```

## Автоматика

Хук `session.idle` (дебаунс 1 час) автоматически запускает cleanup и backup retention, если они включены в настройках.
Хук `session.deleted` удаляет сессию из pinned-списка при ручном удалении.
Хуки никогда не роняют opencode.
