# USAGE — OpenCode Session Manager

[Русский](https://github.com/EnerJizeIT/opencode-session-manager/blob/master/USAGE.ru.md) · [README](https://github.com/EnerJizeIT/opencode-session-manager/blob/master/README.md)

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

## Terminal commands

The plugin manages sessions (pin/backup/restore data). To actually **open or resume** a session in opencode, use the terminal:

- `opencode session list` — list all sessions and their IDs (alternative to `sm_search`).
- `opencode -s <session_id>` — resume a specific session. Use this after `sm_restore` (to open the restored session) or to switch to a pinned one. `sm_list` prints these commands ready to copy.
- `opencode export <id> > file.json` — manual export (advanced; `sm_backup` wraps this).

**Typical flow:** `sm_restore` (in chat) imports the session → run `opencode -s <id>` (terminal) to continue it.

## Quick example: open a pinned session

1. In chat say: **"show pinned sessions"** → `sm_list` returns a table and a block of commands:
   ```
   Resume a pinned session (copy a line into your shell):
     opencode -s ses_099136ce0ffeSVRXKPfZ2IKglc   # Анализ agentic-workflow
   ```
2. Copy the `opencode -s ses_…` line you need.
3. Paste it into your terminal and press Enter — the session opens.

**Restore a deleted one:** "restore from backups/ses_xxx.json" (`sm_restore`) → the output includes `resume: opencode -s ses_xxx` — copy and run it in the terminal.

## Quick example: terminal-only (no chat)

List pinned sessions and restore — straight from the shell:

```bash
# 1. Pinned sessions (ID + title):
jq -r '.pinned[] | "\(.sessionId)  \(.title)"' ~/.local/share/opencode/session-manager.json

# 2. Available backups:
ls ~/.local/share/opencode/backups/

# 3. Restore a session from a backup:
opencode import ~/.local/share/opencode/backups/ses_xxx.json

# 4. Open the restored session:
opencode -s ses_xxx
```

## Settings (`sm_config`)

Keys: `autoCleanupEnabled`, `autoCleanupDays`, `backupRetentionEnabled`, `backupRetentionDays`, `backupDir`.
Example: "set autoCleanupDays to 14".

## Automation

When `autoCleanup` / `backupRetention` are enabled, the `session.idle` hook (hourly) cleans up and rotates automatically.
Pinned sessions and their backups are always protected; deletion only happens after a successful backup.

**Storage:** state — `~/.local/share/opencode/session-manager.json`, backups — `~/.local/share/opencode/backups/`.
