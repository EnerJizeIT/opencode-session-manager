# USAGE — OpenCode Session Manager

[Русский](https://github.com/EnerJizeIT/opencode-session-manager/blob/master/USAGE.ru.md) · [README](https://github.com/EnerJizeIT/opencode-session-manager/blob/master/README.md)

## What you get

Keep the opencode sessions that matter — let the noise clean itself up.

- **Never lose** an important session: pin it, back it up, restore it any time.
- **Auto-cleanup** of old sessions (backup-then-delete; pinned ones are always safe).
- Works **through chat**: just say what you want — the agent calls the right tool. No commands to learn.

## Is this for you?

Yes, if you have many opencode sessions and have ever lost a valuable conversation, couldn't find the right one, or wished old sessions would tidy themselves up.

## 30-second start

You talk to the agent in plain language — it does the rest. Three things cover most of daily use:

1. **Pin a session worth keeping** — "pin ses_abc123" → it's protected from cleanup.
2. **See your pinned sessions** — "show pinned" → a list + a ready-to-copy `opencode -s <id>` line for each.
3. **Go back to one** — copy that `opencode -s ses_…` line into your terminal.

> **Where's the session ID?** Run `opencode session list` in the terminal, or say "find session about X".

## Everyday

| You say | What happens |
|---|---|
| "pin ses_abc123" | protected from cleanup |
| "unpin ses_abc123" | removed from pinned |
| "show pinned" | list + `opencode -s <id>` to resume each |
| "find session about payments" | matches by title; pinned marked `*` |

## Safety: backup & restore

| You say | What happens |
|---|---|
| "back up ses_abc123" | saved to `backups/` + how-to-restore hint |
| "back up all pinned" | summary: N saved, M failed |
| "restore from backups/ses_xxx.json" | imported; add `force=true` to overwrite |
| "full backup for migration" | archive: sessions + state + plugin + RESTORE.md |

**Typical use:** back up before a risky change; restore if a session is gone.

## Maintenance (set and forget)

| You say | What happens |
|---|---|
| "show settings" | autoCleanup, retention, backupDir, pinned count |
| "enable auto-cleanup after 30 days" | old non-pinned sessions get backed up then deleted |
| "rotate old backups" | deletes stale backups; pinned/orphaned always protected |

Once enabled, the `session.idle` hook runs cleanup + retention hourly — no manual work.
Settings keys: `autoCleanupEnabled`, `autoCleanupDays`, `backupRetentionEnabled`, `backupRetentionDays`, `backupDir`.

## Terminal-only (no chat)

```bash
# Pinned sessions (ID + title):
jq -r '.pinned[] | "\(.sessionId)  \(.title)"' ~/.local/share/opencode/session-manager.json
# Backups available:
ls ~/.local/share/opencode/backups/
# Restore from a backup, then open it:
opencode import ~/.local/share/opencode/backups/ses_xxx.json
opencode -s ses_xxx
```

Other handy shell commands: `opencode session list` (all sessions + IDs), `opencode -s <id>` (resume), `opencode export <id>` (manual export).

## Where things live

- State (pinned list + settings): `~/.local/share/opencode/session-manager.json`
- Backups: `~/.local/share/opencode/backups/`
- Stored outside opencode's DB → survives a reinstall.

## All tools (reference)

| Tool | What it does |
|---|---|
| `sm_pin` / `sm_unpin` | protect / release a session |
| `sm_list` | pinned sessions + resume commands |
| `sm_search` | find sessions by title |
| `sm_backup` / `sm_backup_all` | back up one / all pinned |
| `sm_restore` | restore from a backup file |
| `sm_full_backup` | full archive for migration |
| `sm_settings` / `sm_config` | view / change settings |
| `sm_cleanup` | back up + delete old non-pinned |
| `sm_cleanup_backups` | rotate stale backups |
