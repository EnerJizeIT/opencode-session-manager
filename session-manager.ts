/**
 * OpenCode Session Manager Plugin
 *
 * Pin sessions, backup, restore, auto-cleanup and search.
 *
 * @version 1.1.0
 * @author EnerJizeIT
 *
 * Installation (npm):
 *   1. Add "@enerjizeit/opencode-session-manager" to the `plugin` array in
 *      ~/.config/opencode/opencode.json
 *   2. State file: ~/.local/share/opencode/session-manager.json
 *   3. Backups:    ~/.local/share/opencode/backups/ (configurable via sm_config)
 *   4. Start opencode — the plugin loads automatically.
 *
 * Local development: clone the repo and run ./install.sh.
 *
 * Module layout (src/):
 *   - state.ts    — pure state I/O + path constants + getBackupDir
 *   - types.ts    — shared interfaces (SessionInfo, BackupEnvelope, …)
 *   - format.ts   — pure formatting helpers (formatDate, findPluginSourcePath)
 *   - cli.ts      — wrappers around the `opencode` CLI (list, find, export, …)
 *   - backup.ts   — backup / cleanup / retention / restore / full-backup logic
 *   - session-manager.ts (this file) — plugin entry: tool definitions + hooks
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { join, sep } from "path"
import { writeFileSync } from "fs"

import {
  loadStateDefault, saveStateDefault, getBackupDir, logHookEvent,
  STATE_FILE, DEFAULT_BACKUP_DIR, type SMState,
} from "./src/state"
import {
  listSessions, findSessionById, findSessionByQuery, formatAmbiguous,
  searchSessions,
} from "./src/cli"
import {
  backupOne, runCleanup, runBackupRetention, hasBackupFiles, listBackups,
  restoreFromBackup, createFullBackup,
} from "./src/backup"
import { findPluginSourcePath, formatDate } from "./src/format"

export const SessionManagerPlugin: Plugin = async ({ client, $ }) => {
  // Tracks the session that is currently active in opencode, set by the
  // `tool.execute.before` hook on every tool call. Used as a fallback when
  // a tool is invoked without an explicit `sessionId` argument (the most
  // common case — "pin this session").
  let currentSessionId: string | null = null

  /**
   * Resolve a session ID for a tool invocation:
   *   1. Explicit argument wins.
   *   2. Otherwise fall back to the most recently seen current session.
   * Returns `{ id }` on success or `{ error }` with a user-facing message.
   */
  function resolveSessionId(arg: string | undefined): { id: string } | { error: string } {
    if (arg && arg.trim()) return { id: arg.trim() }
    if (currentSessionId) return { id: currentSessionId }
    return {
      error:
        "No sessionId provided and no current session is known. Either pass an explicit sessionId, or trigger any tool call first so the plugin can capture the active session.",
    }
  }

  return {
    tool: {
      // ─────────────────────────────────────────────────────────────────────
      // Pinning
      // ─────────────────────────────────────────────────────────────────────

      sm_pin: tool({
        description: "Pin a session by its ID to protect it from auto-cleanup. Optionally attach a note. If sessionId is omitted, the current session is pinned.",
        args: {
          sessionId: tool.schema.string().optional(),
          note: tool.schema.string().optional(),
        },
        async execute(args) {
          const resolved = resolveSessionId(args.sessionId)
          if ("error" in resolved) return resolved.error
          const sessionId = resolved.id

          const lookup = await findSessionByQuery($, sessionId)
          if (lookup.kind === "error") return `Lookup error: ${lookup.message}`
          if (lookup.kind === "not_found") return `Session not found: ${lookup.query}`
          if (lookup.kind === "ambiguous") return formatAmbiguous(lookup)
          const session = lookup.session

          const state = loadStateDefault()
          const existing = state.pinned.find((p) => p.sessionId === session.id)
          if (existing) {
            // Allow updating the note without re-pinning (UX: "pin this with note X").
            if (args.note !== undefined && args.note !== existing.note) {
              existing.note = args.note
              saveStateDefault(state)
              return `Updated note on pinned session: ${existing.title}`
            }
            return `Already pinned: ${existing.title}`
          }

          state.pinned.push({
            sessionId: session.id,
            title: session.title,
            pinnedAt: Date.now(),
            note: args.note ?? "",
          })
          saveStateDefault(state)
          return `Pinned: ${session.title} (${session.id})`
        },
      }),

      sm_unpin: tool({
        description: "Unpin a session by its ID, removing it from the protected list. If sessionId is omitted, the current session is unpinned.",
        args: {
          sessionId: tool.schema.string().optional(),
        },
        async execute(args) {
          const resolved = resolveSessionId(args.sessionId)
          if ("error" in resolved) return resolved.error
          const sessionId = resolved.id

          const state = loadStateDefault()
          const idx = state.pinned.findIndex((p) => p.sessionId === sessionId)
          if (idx === -1) return `Not pinned: ${sessionId}`

          const entry = state.pinned[idx]
          if (!entry) return `Internal error: pinned entry vanished at index ${idx}`
          state.pinned.splice(idx, 1)
          saveStateDefault(state)
          return `Unpinned: ${entry.title}`
        },
      }),

      // ─────────────────────────────────────────────────────────────────────
      // Discovery
      // ─────────────────────────────────────────────────────────────────────

      sm_list: tool({
        description: "List sessions. scope: 'pinned' (default), 'recent' (last 20 by updated), or 'all' (capped at 50).",
        args: {
          scope: tool.schema.string().optional(),
        },
        async execute(args) {
          const scope = (args.scope ?? "pinned").toLowerCase()
          if (scope !== "pinned" && scope !== "recent" && scope !== "all") {
            return `Invalid scope: ${args.scope}. Use 'pinned', 'recent', or 'all'.`
          }

          const state = loadStateDefault()

          if (scope === "pinned") {
            if (state.pinned.length === 0) {
              let msg = "No pinned sessions."
              if (hasBackupFiles()) {
                msg += `\nHint: session DB looks empty. Backups available in ${getBackupDir()}; use sm_restore.`
              }
              return msg
            }
            const rows: string[] = []
            for (const entry of state.pinned) {
              const alive = await findSessionById($, entry.sessionId)
              const titleStr = entry.title + (alive ? "" : " [DELETED]")
              rows.push(
                `${entry.sessionId.padEnd(40)}${titleStr.padEnd(32)}${formatDate(entry.pinnedAt).padEnd(12)}${entry.note}`,
              )
            }
            const resumeLines = state.pinned.map(
              (e) => `  opencode -s ${e.sessionId}   # ${e.title}`,
            )
            return [
              `Pinned sessions (${state.pinned.length}):`,
              "──────────────────────────────────────────────────────────────────────────────",
              `${"ID".padEnd(40)}${"Title".padEnd(32)}${"Pinned".padEnd(12)}Note`,
              "──────────────────────────────────────────────────────────────────────────────",
              ...rows,
              "──────────────────────────────────────────────────────────────────────────────",
              "",
              "Resume a pinned session (copy a line into your shell):",
              ...resumeLines,
            ].join("\n")
          }

          // scope === "recent" | "all"
          const allSessions = await listSessions($)
          if (allSessions.length === 0) {
            let msg = "No sessions found in DB."
            if (hasBackupFiles()) {
              msg += `\nHint: backups available in ${getBackupDir()}; use sm_restore.`
            }
            return msg
          }

          const sorted = [...allSessions].sort((a, b) => b.updated - a.updated)
          const limit = scope === "recent" ? 20 : 50
          const shown = sorted.slice(0, limit)
          const pinnedIds = new Set(state.pinned.map((p) => p.sessionId))

          const rows = shown.map((s) => {
            const isPinned = pinnedIds.has(s.id)
            const prefix = isPinned ? "* " : "  "
            return `${prefix}${s.id.padEnd(40)}${s.title.padEnd(32)}${formatDate(s.updated).padEnd(12)}${isPinned ? "Yes" : "No"}`
          })

          return [
            `Sessions (${scope}, showing ${shown.length} of ${sorted.length}):`,
            "──────────────────────────────────────────────────────────────────────────────",
            `${"ID".padEnd(40)}${"Title".padEnd(32)}${"Updated".padEnd(12)}Pinned`,
            "──────────────────────────────────────────────────────────────────────────────",
            ...rows,
            "──────────────────────────────────────────────────────────────────────────────",
            "Use: opencode -s <full_id> to continue a session   (* = pinned)",
          ].join("\n")
        },
      }),

      sm_search: tool({
        description: "Search sessions by a case-insensitive substring. search_in: 'title' (default) or 'title+note'. Pinned sessions are marked with *.",
        args: {
          query: tool.schema.string(),
          search_in: tool.schema.string().optional(),
        },
        async execute(args) {
          const scope = (args.search_in ?? "title").toLowerCase()
          if (scope !== "title" && scope !== "title+note") {
            return `Invalid search_in: ${args.search_in}. Use 'title' or 'title+note'.`
          }
          const sessions = await searchSessions($, args.query, scope as "title" | "title+note")
          if (sessions.length === 0) {
            let msg = `No sessions match: ${args.query}`
            const allSessions = await listSessions($)
            if (allSessions.length === 0 && hasBackupFiles()) {
              msg += `\nHint: session DB looks empty. Backups available in ${getBackupDir()}; use sm_restore.`
            }
            return msg
          }

          const limit = 50
          const truncated = sessions.length > limit
          const shown = truncated ? sessions.slice(0, limit) : sessions

          const state = loadStateDefault()
          const pinnedIds = new Set(state.pinned.map((p) => p.sessionId))

          const rows: string[] = []
          for (const s of shown) {
            const isPinned = pinnedIds.has(s.id)
            const prefix = isPinned ? "* " : "  "
            rows.push(
              `${prefix}${s.id.padEnd(40)}${s.title.padEnd(32)}${formatDate(s.updated).padEnd(12)}${isPinned ? "Yes" : "No"}`,
            )
          }

          const trailer = truncated ? `\n  ...and ${sessions.length - limit} more. Refine the query to see them.` : ""

          return [
            `Sessions matching "${args.query}" (scope=${scope}, showing ${shown.length} of ${sessions.length}):`,
            "──────────────────────────────────────────────────────────────────────────────",
            `${"ID".padEnd(40)}${"Title".padEnd(32)}${"Updated".padEnd(12)}Pinned`,
            "──────────────────────────────────────────────────────────────────────────────",
            ...rows,
            "──────────────────────────────────────────────────────────────────────────────",
            "Use: opencode -s <full_id> to continue a session   (* = pinned)",
            trailer.trim(),
          ].filter(Boolean).join("\n")
        },
      }),

      sm_current_session: tool({
        description: "Show the currently active session (id, title, pinned status). Useful before pinning or backing up.",
        args: {},
        async execute() {
          if (!currentSessionId) {
            return [
              "No active session is known yet.",
              "The plugin captures the active session on the first tool call of each conversation.",
              "Try calling any other sm_* tool first, or pass an explicit sessionId.",
            ].join("\n")
          }
          const session = await findSessionById($, currentSessionId)
          const state = loadStateDefault()
          const pinned = state.pinned.find((p) => p.sessionId === currentSessionId)
          return [
            `Current session: ${currentSessionId}`,
            `  title:  ${session?.title ?? "(not found in DB)"}`,
            `  updated: ${session ? formatDate(session.updated) : "-"}`,
            `  pinned: ${pinned ? "yes" : "no"}${pinned?.note ? ` (note: ${pinned.note})` : ""}`,
          ].join("\n")
        },
      }),

      // ─────────────────────────────────────────────────────────────────────
      // Backup & restore
      // ─────────────────────────────────────────────────────────────────────

      sm_backup: tool({
        description: "Back up a single session by its ID to a JSON file in the backup directory. If sessionId is omitted, the current session is backed up.",
        args: {
          sessionId: tool.schema.string().optional(),
        },
        async execute(args) {
          const resolved = resolveSessionId(args.sessionId)
          if ("error" in resolved) return resolved.error
          const sessionId = resolved.id

          const lookup = await findSessionByQuery($, sessionId)
          if (lookup.kind === "error") return `Lookup error: ${lookup.message}`
          if (lookup.kind === "not_found") return `Session not found: ${lookup.query}`
          if (lookup.kind === "ambiguous") return formatAmbiguous(lookup)
          const session = lookup.session

          const result = await backupOne($, session.id)
          if (!result.ok) return result.error ?? "Backup failed"

          return [
            `Backed up: ${session.title}`,
            `  file:   ${result.path}`,
            `  restore: ask "restore session from ${result.path}"  (or: sm_restore ${result.path})`,
          ].join("\n")
        },
      }),

      sm_backup_all: tool({
        description: "Back up all pinned sessions to JSON files in the backup directory.",
        args: {},
        async execute() {
          const state = loadStateDefault()
          if (state.pinned.length === 0) return "No pinned sessions to backup."

          let backedUp = 0
          const failures: string[] = []

          for (const entry of state.pinned) {
            const result = await backupOne($, entry.sessionId)
            if (result.ok) {
              backedUp++
            } else {
              failures.push(`  failed: ${entry.title} (${entry.sessionId}): ${result.error}`)
            }
          }

          const lines = [`Backup complete: ${backedUp} backed up, ${failures.length} failed`]
          lines.push(...failures)
          return lines.join("\n")
        },
      }),

      sm_restore: tool({
        description: "Restore a session from a backup JSON file. Use force=true to overwrite an existing session (a safety backup is created automatically).",
        args: {
          filePath: tool.schema.string(),
          force: tool.schema.boolean().optional(),
        },
        async execute(args) {
          const result = await restoreFromBackup($, args.filePath, args.force === true)
          return result.message
        },
      }),

      sm_list_backups: tool({
        description: "List available session backups in the backup directory, newest first.",
        args: {},
        async execute() {
          const backups = listBackups()
          const dir = getBackupDir()
          if (backups.length === 0) {
            return `No backups found in ${dir}.`
          }
          const rows = backups.map((b) => {
            const flag = b.corrupt ? " [CORRUPT]" : ""
            return `${b.filename.padEnd(48)}${formatDate(b.date).padEnd(12)}${b.title}${flag}`
          })
          return [
            `Backups (${backups.length} in ${dir}):`,
            "──────────────────────────────────────────────────────────────────────────────",
            `${"File".padEnd(48)}${"Date".padEnd(12)}Title`,
            "──────────────────────────────────────────────────────────────────────────────",
            ...rows,
            "──────────────────────────────────────────────────────────────────────────────",
            "Restore with: sm_restore <full_path>  (or ask in natural language)",
          ].join("\n")
        },
      }),

      sm_full_backup: tool({
        description: "Create a full backup archive with all pinned sessions, state file, plugin, and restore instructions.",
        args: {
          targetDir: tool.schema.string().optional(),
        },
        async execute(args) {
          const result = await createFullBackup($, args.targetDir)

          // Restore instructions adapt to how the plugin was found.
          const pluginInstallHint = result.hasPlugin && result.pluginFile === "session-manager.ts"
            ? `cp .${sep}session-manager.ts ~/.config/opencode/plugins/`
            : `# Reinstall via npm: add "@enerjizeit/opencode-session-manager" to opencode.json plugin[]`

          const restoreMd = `# OpenCode Session Restore

## Recovery after reinstall

1. Install opencode normally
2. Restore the plugin:
   ${pluginInstallHint}
3. Copy the state:
   cp .${sep}session-manager.json ~/.local/share/opencode/
4. Start opencode — the plugin will load automatically
5. Restore sessions one by one:
   opencode run "sm-restore .${sep}ses_XXXXX.json"
   Or use:
   opencode import .${sep}ses_XXXXX.json
6. Done. Your pinned sessions and settings are restored.

## Configure auto-cleanup

In TUI run:
  /sm-config autoCleanupEnabled true
  /sm-config autoCleanupDays 30

Or edit ~/.local/share/opencode/session-manager.json manually.
`
          try {
            writeFileSync(join(result.dir, "RESTORE.md"), restoreMd, "utf-8")
          } catch { /* best-effort */ }

          const parts = [`${result.sessionCount} sessions`]
          if (result.hasState) parts.push("state")
          if (result.hasPlugin) parts.push("plugin")
          parts.push("RESTORE.md")

          let summary = `Full backup created: ${result.dir} (${parts.join(", ")})`
          if (result.failures.length > 0) {
            summary += "\n" + result.failures.join("\n")
          }
          return summary
        },
      }),

      // ─────────────────────────────────────────────────────────────────────
      // Settings
      // ─────────────────────────────────────────────────────────────────────

      sm_settings: tool({
        description: "Display current session-manager settings.",
        args: {},
        async execute() {
          const state = loadStateDefault()
          const activeBackupDir = getBackupDir()
          const backupDirDisplay =
            activeBackupDir === DEFAULT_BACKUP_DIR
              ? "~/.local/share/opencode/backups"
              : activeBackupDir
          return [
            "Session Manager Settings:",
            "──────────────────────────────────────────────",
            `Auto-cleanup enabled:     ${state.settings.autoCleanupEnabled}`,
            `Cleanup after (days):     ${state.settings.autoCleanupDays}`,
            `Backup retention enabled: ${state.settings.backupRetentionEnabled}`,
            `Backup retention (days):  ${state.settings.backupRetentionDays}`,
            `Backup directory:         ${backupDirDisplay}`,
            `Pinned sessions:          ${state.pinned.length}`,
            "──────────────────────────────────────────────",
          ].join("\n")
        },
      }),

      sm_config: tool({
        description: "Update a session-manager setting. Supported keys: autoCleanupEnabled, autoCleanupDays, backupRetentionEnabled, backupRetentionDays, backupDir.",
        args: {
          key: tool.schema.string(),
          value: tool.schema.string(),
        },
        async execute(args) {
          const allowedKeys: (keyof SMState["settings"])[] = [
            "autoCleanupEnabled",
            "autoCleanupDays",
            "backupRetentionEnabled",
            "backupRetentionDays",
            "backupDir",
          ]
          if (!allowedKeys.includes(args.key as any)) {
            return `Unknown setting: ${args.key}`
          }

          let converted: boolean | number | string
          if (args.key.endsWith("Enabled")) {
            if (args.value === "true") converted = true
            else if (args.value === "false") converted = false
            else return `Invalid value for ${args.key}: ${args.value}`
          } else if (args.key.endsWith("Days")) {
            const n = Number(args.value)
            if (!Number.isFinite(n) || n < 1) return `Invalid value for ${args.key}: ${args.value}`
            converted = n
          } else {
            if (!args.value.startsWith("/")) return `Invalid value for ${args.key}: ${args.value}`
            converted = args.value
          }

          const state = loadStateDefault()
          ;(state.settings as Record<string, unknown>)[args.key] = converted
          saveStateDefault(state)
          return `Setting updated: ${args.key} = ${converted}`
        },
      }),

      // ─────────────────────────────────────────────────────────────────────
      // Cleanup
      // ─────────────────────────────────────────────────────────────────────

      sm_cleanup: tool({
        description: "Clean up stale, non-pinned sessions by backing them up and deleting them. DRY-RUN by default — pass dry_run=false to actually delete.",
        args: {
          dry_run: tool.schema.boolean().optional(),
        },
        async execute(args) {
          const dryRun = args.dry_run !== false  // default true
          const report = await runCleanup($, true, dryRun)

          const verb = dryRun ? "would delete" : "deleted"
          const lines = [
            `Cleanup ${dryRun ? "(DRY RUN) " : ""}complete: ${report.deleted.length} sessions ${verb}, ${report.skippedPinned.length} skipped (pinned), ${report.failed.length} failed`,
          ]
          for (const id of report.deleted) lines.push(`  ${dryRun ? "would delete" : "deleted"}: ${id}`)
          for (const id of report.skippedPinned) lines.push(`  pinned: ${id}`)
          for (const id of report.failed) lines.push(`  failed: ${id}`)
          if (dryRun && report.deleted.length > 0) {
            lines.push("")
            lines.push("This was a dry run. Re-run with dry_run=false to actually delete.")
          }
          return lines.join("\n")
        },
      }),

      sm_cleanup_backups: tool({
        description: "Remove stale backup files while protecting pinned and orphaned backups. DRY-RUN by default — pass dry_run=false to actually delete.",
        args: {
          dry_run: tool.schema.boolean().optional(),
        },
        async execute(args) {
          const dryRun = args.dry_run !== false  // default true
          const report = await runBackupRetention($, dryRun)

          const lines = [
            `Backup rotation ${dryRun ? "(DRY RUN) " : ""}complete: ${report.removed.length} ${dryRun ? "would be" : ""} removed, ${report.protected.length} protected (pinned/orphaned), ${report.skippedRecent.length} skipped (recent)`,
          ]
          for (const f of report.removed) lines.push(`  ${dryRun ? "would remove" : "removed"}: ${f}`)
          for (const f of report.protected) lines.push(`  protected: ${f}`)
          for (const f of report.skippedRecent) lines.push(`  recent: ${f}`)
          if (report.corrupt.length > 0) {
            for (const f of report.corrupt) lines.push(`  corrupt: ${f}`)
          }
          if (dryRun && report.removed.length > 0) {
            lines.push("")
            lines.push("This was a dry run. Re-run with dry_run=false to actually delete.")
          }
          return lines.join("\n")
        },
      }),
    },

    // ───────────────────────────────────────────────────────────────────────
    // Hooks
    // ───────────────────────────────────────────────────────────────────────

    // Tracks the active session for resolveSessionId() — set on every tool call.
    "tool.execute.before": async (input: unknown, _output: unknown) => {
      try {
        if (input && typeof input === "object" && "sessionID" in input) {
          const sid = (input as { sessionID?: unknown }).sessionID
          if (typeof sid === "string" && sid) {
            currentSessionId = sid
          }
        }
      } catch { /* best-effort — never crash the hook */ }
    },

    // Remove deleted session from the pinned list.
    "session.deleted": async (input: unknown, _output: unknown) => {
      logHookEvent("session.deleted", typeof input === "string" ? `id=${input}` : "")
      try {
        const state = loadStateDefault()
        let sessionId: string | null = null
        if (typeof input === "string") {
          sessionId = input
        } else if (input && typeof input === "object" && "id" in input) {
          sessionId = String((input as any).id)
        }
        if (!sessionId) return
        const idx = state.pinned.findIndex((p) => p.sessionId === sessionId)
        if (idx !== -1) {
          state.pinned.splice(idx, 1)
          saveStateDefault(state)
          logHookEvent("session.deleted", `unpinned id=${sessionId}`)
        }
      } catch {
        // Never crash the hook
      }
    },

    // Auto-cleanup + backup retention (debounced 1 h).
    "session.idle": async (_input: unknown, _output: unknown) => {
      logHookEvent("session.idle")
      try {
        const state = loadStateDefault()
        if (state.lastAutoRun && Date.now() - state.lastAutoRun < 3600000) {
          logHookEvent("session.idle", "skipped (debounced)")
          return
        }

        let cleanupSummary = ""
        if (state.settings.autoCleanupEnabled) {
          try {
            const report = await runCleanup($, false)
            cleanupSummary = `cleanup: ${report.deleted.length} deleted, ${report.failed.length} failed`
          } catch (e: any) {
            cleanupSummary = `cleanup error: ${e?.message ?? "unknown"}`
          }
        }

        let retentionSummary = ""
        if (state.settings.backupRetentionEnabled) {
          try {
            const report = await runBackupRetention($)
            retentionSummary = `retention: ${report.removed.length} removed, ${report.corrupt.length} corrupt`
          } catch (e: any) {
            retentionSummary = `retention error: ${e?.message ?? "unknown"}`
          }
        }

        state.lastAutoRun = Date.now()
        saveStateDefault(state)

        const parts = [cleanupSummary, retentionSummary].filter(Boolean)
        if (parts.length > 0) {
          try {
            client.app.log({ body: { service: "session-manager", level: "info", message: parts.join("; ") } })
          } catch { /* logging is best-effort */ }
        }
      } catch {
        // Never crash the hook
      }
    },
  }
}

export default SessionManagerPlugin
