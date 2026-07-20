# OpenCode Session Manager

An [OpenCode](https://opencode.ai) plugin for session management: pin, backup, restore, auto-cleanup, and search. Works through natural language — the AI model calls the right tools automatically.

## Features

- Pin/unpin sessions to protect them from auto-cleanup
- Backup individual sessions and all pinned sessions
- Restore sessions from backup (with force-overwrite)
- Full backup archive for migration to another machine
- Search sessions by substring in title
- Auto-cleanup of old non-pinned sessions (backup-then-delete)
- Backup rotation with pinned and orphaned protection
- Configure via `sm_config` tool and inspect via `sm_settings`

## Installation

Add the scoped package to your `opencode.json` plugin array — opencode will install it from npm automatically:

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["@enerjizeit/opencode-session-manager"]
}
```

Restart opencode after adding the plugin.

**Local development:** clone the repo and run `install.sh` to build and install from source:

```bash
git clone https://github.com/EnerJizeIT/opencode-session-manager.git
cd opencode-session-manager && ./install.sh
```

## Upgrade

opencode **does not auto-upgrade** installed plugins — it pins the version on first
install. To update to a newer release:

```bash
rm -rf ~/.cache/opencode/packages/@enerjizeit/opencode-session-manager
rm -rf ~/.cache/opencode/packages/@enerjizeit/opencode-session-manager@latest
```
Then restart opencode — it re-resolves `@latest` from npm and installs the new version.
(Or pin an exact version in `plugin[]`, e.g. `"@enerjizeit/opencode-session-manager@1.0.2"`.)

## Usage

Write in natural language in the chat — the model invokes the appropriate `sm_*` tool. No slash commands needed.

Example: "pin session ses_abc123", "find session about payment", "clean up old sessions".

See [USAGE.md](./USAGE.md) for full scenario reference.

## Architecture

- **CLI-first** — all session operations go through `opencode` CLI, not direct SQL.
- **Backup-then-delete** — sessions are only removed after a successful backup.
- **Backup envelope** — format: `{version, exportedAt, backupOf, session}`; formalized in `backup-schema.json`.
- **Protected backups** — pinned and orphaned backups (session no longer in DB) are protected forever.
- **Hooks** — `session.idle` triggers auto-cleanup and retention (1h debounce); `session.deleted` cleans the pinned list.
- **Migration** — `version` field in state + `migrateState` for future schema changes.

## Combo with opencode-mem

[opencode-mem](https://github.com/tickernelz/opencode-mem) is a plugin for persistent AI agent memory across sessions using a local vector DB (SQLite + USearch).

| Session Manager | opencode-mem |
| --- | --- |
| Pin/unpin sessions | Semantic search across context |
| Backup/restore sessions | Auto-capture key decisions from sessions |
| Auto-cleanup old sessions | Vector DB with compaction |
| Session lifecycle | Long-term agent memory |

Session Manager protects sessions from loss; opencode-mem extracts knowledge from them for future sessions. Together they cover the full lifecycle: creation → context extraction → preservation → restoration.

## Documentation

- [USAGE.md](./USAGE.md) — usage scenarios and tool reference
- [README.ru.md](./README.ru.md) — Russian README

## License

MIT — see [LICENSE](./LICENSE).
