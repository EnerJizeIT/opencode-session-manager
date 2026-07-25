# USAGE — OpenCode Session Manager

[Русский](./USAGE.ru.md) · [README](./README.md)

## How to use

Write in natural language in the chat — the model invokes the right `sm_*` tool automatically. No slash commands.

**Session ID** is needed for pin/backup/restore. Get it from:
- terminal: `opencode session list`
- or: "find session about X" → `sm_search` shows IDs in the table.

## Scenarios

| You say | Tool | What happens |
|---|---|---|
| "pin session ses_abc123" | `sm_pin` | session is protected from auto-cleanup |
| "unpin ses_abc123" | `sm_unpin` | removed from pinned |
| "show pinned sessions" | `sm_list` | table + ready-to-copy `opencode -s <id>` to resume |
| "find session about payment" | `sm_search` | matches by title; pinned marked `*` |
| "back up ses_abc123" | `sm_backup` | file in `backups/` + how-to-restore hint |
| "back up all pinned" | `sm_backup_all` | summary: N backed up, M failed |
| "restore from backups/ses_xxx.json" | `sm_restore` | session imported; `force=true` to overwrite |
| "full backup for migration" | `sm_full_backup` | archive: sessions + state + plugin + RESTORE.md |
| "show settings" | `sm_settings` | autoCleanup, retention, backupDir, pinned count |
| "enable auto-cleanup after 30 days" | `sm_config` | `autoCleanupEnabled=true` + `autoCleanupDays=30` |
| "clean up old non-pinned" | `sm_cleanup` | backup-then-delete; pinned are skipped |
| "rotate old backups" | `sm_cleanup_backups` | deletes stale; protects pinned and orphaned |

## Settings (`sm_config`)

Keys: `autoCleanupEnabled`, `autoCleanupDays`, `backupRetentionEnabled`, `backupRetentionDays`, `backupDir`.
Example: "set autoCleanupDays to 14".

## Automation

When `autoCleanup` / `backupRetention` are enabled, the `session.idle` hook (hourly) cleans up and rotates automatically.
Pinned sessions and their backups are always protected; deletion only happens after a successful backup.

**Storage:** state — `~/.local/share/opencode/session-manager.json`, backups — `~/.local/share/opencode/backups/`.
