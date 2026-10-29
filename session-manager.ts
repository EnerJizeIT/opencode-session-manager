/**
 * OpenCode Session Manager Plugin
 *
 * Pin sessions, backup, restore, auto-cleanup and search.
 *
 * @version 2.0.0
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
 * Dual API (OpenCode 1.18.29+ and 2.x):
 *   - V2 reads the default export's `id` and `setup(ctx)`, which registers the
 *     tools through `ctx.tool.transform` and the hook through
 *     `ctx.tool.hook("execute.before", ...)`.
 *   - V1 reads the default export's `server()` and gets the classic
 *     `{ tool, "tool.execute.before" }` hooks object.
 *   Both adapters drive the same core (handlers below) — the tool names,
 *   descriptions, arguments and behaviour are identical in both versions.
 *
 * Module layout (src/):
 *   - state.ts    — pure state I/O + path constants + getBackupDir
 *   - types.ts    — shared interfaces (SessionInfo, BackupEnvelope, …)
 *   - format.ts   — pure formatting helpers (formatDate, findPluginSourcePath)
 *   - cli.ts      — wrappers around the `opencode` CLI (list, find, export, …)
 *   - backup.ts   — backup / cleanup / retention / restore / full-backup logic
 *   - session-manager.ts (this file) — plugin entry: core + V1/V2 adapters
 */

import type { Hooks, Plugin as V1Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
// Type-only: `@opencode/plugin` is a V2 package and must not be loaded inside
// a V1 runtime. `Plugin.define` is the identity function, so the definition
// below is written literally instead of calling it at runtime.
import type { Plugin as V2 } from "@opencode/plugin"

type V2Context = V2.Context
type V2Plugin = V2.Plugin
import { join, sep } from "path"
import { writeFileSync } from "fs"

/** Shell handle. V1 passed the Bun `$` helper, V2 has none; nothing calls it. */
type Shell = unknown

import {
  loadStateDefault, saveStateDefault, getBackupDir, logHookEvent,
  acquireMaintenanceLock, releaseMaintenanceLock,
  STATE_FILE, DEFAULT_BACKUP_DIR, type SMState,
} from "./src/state"
import {
  listSessions, findSessionById, findSessionByQuery, formatAmbiguous,
  searchSessions,
} from "./src/cli"
import {
  backupOne, runCleanup, runBackupRetention, hasBackupFiles, listBackups,
  restoreFromBackup, createFullBackup, ensurePinnedBackups, restoreMissingPinned,
} from "./src/backup"
import { findPluginSourcePath, formatDate } from "./src/format"

/** Debounce window for auto-maintenance triggered from tool.execute.before.
 *  Replaces the non-working `session.idle` hook (1 hour, same intent). */
const AUTO_MAINTENANCE_INTERVAL_MS = 3600000

/** Stable plugin id — V2 scopes plugin storage and diagnostics by it. */
const PLUGIN_ID = "session-manager"

/**
 * Periodic background maintenance: cleanup + retention + Pinned Guarantee +
 * lastAutoRun update. Fire-and-forget — must never throw or block the
 * calling tool.
 *
 * Replaces the dead `session.idle` hook (SDK 1.3.0 does not fire it).
 * Triggered instead from `tool.execute.before` with a 1-hour debounce.
 * Guarded by a lock file — concurrent runs (multiple tool calls / opencode
 * instances) are skipped.
 */
async function runAutoMaintenance(): Promise<void> {
  const shell: Shell = undefined
  if (!acquireMaintenanceLock()) {
    logHookEvent("auto-maintenance", "skipped (lock held)")
    return
  }
  try {
    const state = loadStateDefault()

    let cleanupSummary = ""
    if (state.settings.autoCleanupEnabled) {
      try {
        const report = await runCleanup(shell, false)
        if (report.deleted.length || report.failed.length || report.remaining) {
          cleanupSummary = `cleanup: ${report.deleted.length} deleted, ${report.failed.length} failed${report.remaining ? `, ${report.remaining} remaining (next run)` : ""}`
        }
      } catch (e: any) {
        cleanupSummary = `cleanup error: ${e?.message ?? "unknown"}`
      }
    }

    let retentionSummary = ""
    if (state.settings.backupRetentionEnabled) {
      try {
        const report = await runBackupRetention(shell)
        if (report.removed.length || report.corrupt.length) {
          retentionSummary = `retention: ${report.removed.length} removed, ${report.corrupt.length} corrupt`
        }
      } catch (e: any) {
        retentionSummary = `retention error: ${e?.message ?? "unknown"}`
      }
    }

    // Pinned Guarantee: fresh backups for every pinned session…
    let pinnedSummary = ""
    if (state.pinned.length > 0) {
      try {
        const refresh = await ensurePinnedBackups(shell)
        if (refresh.refreshed.length || refresh.failed.length) {
          pinnedSummary = `pinned-backup: ${refresh.refreshed.length} refreshed, ${refresh.failed.length} failed`
        }

        // …and auto-restore of any pinned session that vanished from the DB.
        const restore = await restoreMissingPinned(shell)
        if (restore.restored.length || restore.missing.length) {
          pinnedSummary += `${pinnedSummary ? "; " : ""}pinned-restore: ${restore.restored.length} restored, ${restore.missing.length} missing`
        }
      } catch (e: any) {
        pinnedSummary = `pinned-guarantee error: ${e?.message ?? "unknown"}`
      }
    }

    // Update lastAutoRun on the freshest possible state.
    const freshState = loadStateDefault()
    freshState.lastAutoRun = Date.now()
    saveStateDefault(freshState)

    const parts = [cleanupSummary, retentionSummary, pinnedSummary].filter(Boolean)
    logHookEvent("auto-maintenance", parts.length ? parts.join("; ") : "no-op")
  } catch (e: any) {
    logHookEvent("auto-maintenance", `error: ${e?.message ?? "unknown"}`)
  } finally {
    releaseMaintenanceLock()
  }
}

/**
 * Debounced trigger for runAutoMaintenance(). Safe to call on every tool
 * execution: it only reads the state file and checks the timestamp.
 */
function maybeAutoMaintenance(): void {
  try {
    const state = loadStateDefault()
    const due = !state.lastAutoRun || Date.now() - state.lastAutoRun >= AUTO_MAINTENANCE_INTERVAL_MS
    if (due && (state.settings.autoCleanupEnabled || state.settings.backupRetentionEnabled)) {
      void runAutoMaintenance()
    }
  } catch { /* best-effort */ }
}

// ───────────────────────────────────────────────────────────────────────────
// Core: tool implementations shared by the V1 and V2 adapters
// ───────────────────────────────────────────────────────────────────────────

type Args = Record<string, any>

interface Core {
  /** Session seen on the most recent tool call (or tool execution). */
  rememberSession(id: string): void
  handlers: Record<string, (args: Args) => Promise<string>>
}

function createCore(): Core {
  // Tracks the session that is currently active in opencode, set by the
  // `tool.execute.before` hook on every tool call. Used as a fallback when
  // a tool is invoked without an explicit `sessionId` argument (the most
  // common case — "pin this session").
  let currentSessionId: string | null = null

  function rememberSession(id: string): void {
    if (typeof id === "string" && id) currentSessionId = id
  }

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

  const handlers: Core["handlers"] = {
    // ───────────────────────────────────────────────────────────────────────
    // Pinning
    // ───────────────────────────────────────────────────────────────────────

    sm_pin: async (args) => {
      const resolved = resolveSessionId(args.sessionId)
      if ("error" in resolved) return resolved.error
      const sessionId = resolved.id

      const lookup = await findSessionByQuery(undefined, sessionId)
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

    sm_unpin: async (args) => {
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

    // ───────────────────────────────────────────────────────────────────────
    // Discovery
    // ───────────────────────────────────────────────────────────────────────

    sm_list: async (args) => {
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

        // Lazy check: detect pinned sessions whose IDs are no longer in
        // the DB (replaces the non-working session.deleted hook).
        const allSessions = await listSessions(undefined)
        const aliveIds = new Set(allSessions.map((s) => s.id))
        const vanished = state.pinned.filter((p) => !aliveIds.has(p.sessionId))

        const rows: string[] = []
        for (const entry of state.pinned) {
          const alive = aliveIds.has(entry.sessionId)
          const titleStr = entry.title + (alive ? "" : " [DELETED]")
          rows.push(
            `${entry.sessionId.padEnd(40)}${titleStr.padEnd(32)}${formatDate(entry.pinnedAt).padEnd(12)}${entry.note}`,
          )
        }
        const resumeLines = state.pinned
          .filter((e) => aliveIds.has(e.sessionId))
          .map((e) => `  opencode -s ${e.sessionId}   # ${e.title}`)

        const vanishedWarning = vanished.length > 0
          ? [
            "",
            `⚠️  ${vanished.length} pinned session${vanished.length === 1 ? "" : "s"} no longer exist in the DB:`,
            ...vanished.map((v) => `    ${v.sessionId}  ${v.title}`),
            `  Run sm_cleanup_pinned to remove ${vanished.length === 1 ? "it" : "them"} from the pinned list.`,
          ].join("\n")
          : ""

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
          vanishedWarning,
        ].filter(Boolean).join("\n")
      }

      // scope === "recent" | "all"
      const allSessions = await listSessions(undefined)
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

    sm_search: async (args) => {
      const scope = (args.search_in ?? "title").toLowerCase()
      if (scope !== "title" && scope !== "title+note") {
        return `Invalid search_in: ${args.search_in}. Use 'title' or 'title+note'.`
      }
      const sessions = await searchSessions(undefined, args.query, scope as "title" | "title+note")
      if (sessions.length === 0) {
        let msg = `No sessions match: ${args.query}`
        const allSessions = await listSessions(undefined)
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

    sm_current_session: async () => {
      if (!currentSessionId) {
        return [
          "No active session is known yet.",
          "The plugin captures the active session on the first tool call of each conversation.",
          "Try calling any other sm_* tool first, or pass an explicit sessionId.",
        ].join("\n")
      }
      const session = await findSessionById(undefined, currentSessionId)
      const state = loadStateDefault()
      const pinned = state.pinned.find((p) => p.sessionId === currentSessionId)
      return [
        `Current session: ${currentSessionId}`,
        `  title:  ${session?.title ?? "(not found in DB)"}`,
        `  updated: ${session ? formatDate(session.updated) : "-"}`,
        `  pinned: ${pinned ? "yes" : "no"}${pinned?.note ? ` (note: ${pinned.note})` : ""}`,
      ].join("\n")
    },

    sm_status: async () => {
      const state = loadStateDefault()
      const sessions = await listSessions(undefined)
      const aliveIds = new Set(sessions.map((s) => s.id))
      const pinnedIds = new Set(state.pinned.map((p) => p.sessionId))
      const backups = listBackups()
      const backupDir = getBackupDir()

      const alivePinned = state.pinned.filter((p) => aliveIds.has(p.sessionId))
      const deadPinned = state.pinned.filter((p) => !aliveIds.has(p.sessionId))
      const cutoff = Date.now() - state.settings.autoCleanupDays * 86400000
      const cleanupCandidates = sessions.filter(
        (s) => !pinnedIds.has(s.id) && s.updated < cutoff,
      )
      const totalBackupBytes = backups.reduce((a, b) => a + b.size, 0)
      const lastRun = state.lastAutoRun
        ? `${formatDate(state.lastAutoRun)} (${new Date(state.lastAutoRun).toLocaleTimeString()})`
        : "never"

      const lines = [
        "Session Manager Status:",
        "──────────────────────────────────────────────",
        `Sessions in DB:           ${sessions.length}`,
        `Pinned:                   ${state.pinned.length} (${alivePinned.length} alive${deadPinned.length ? `, ${deadPinned.length} [DELETED]` : ""})`,
        `Cleanup candidates:       ${cleanupCandidates.length} (stale > ${state.settings.autoCleanupDays}d, non-pinned)`,
        `Backups:                  ${backups.length} files in ${backupDir}`,
        `Backup size:              ${(totalBackupBytes / 1024).toFixed(1)} KB`,
        `Last auto-run:            ${lastRun}`,
        "──────────────────────────────────────────────",
        `Auto-cleanup:             ${state.settings.autoCleanupEnabled ? "on" : "off"} (${state.settings.autoCleanupDays}d)`,
        `Backup retention:         ${state.settings.backupRetentionEnabled ? "on" : "off"} (${state.settings.backupRetentionDays}d)`,
        `Pinned backup refresh:    every ${state.settings.pinnedBackupRefreshDays}d`,
      ]
      if (deadPinned.length > 0) {
        lines.push("", `⚠️  ${deadPinned.length} pinned session(s) vanished from DB. Pinned Guarantee will restore them from backups on the next auto-run, or run sm_cleanup_pinned to drop the entries.`)
      }
      return lines.join("\n")
    },

    // ───────────────────────────────────────────────────────────────────────
    // Backup & restore
    // ───────────────────────────────────────────────────────────────────────

    sm_backup: async (args) => {
      const resolved = resolveSessionId(args.sessionId)
      if ("error" in resolved) return resolved.error
      const sessionId = resolved.id

      const lookup = await findSessionByQuery(undefined, sessionId)
      if (lookup.kind === "error") return `Lookup error: ${lookup.message}`
      if (lookup.kind === "not_found") return `Session not found: ${lookup.query}`
      if (lookup.kind === "ambiguous") return formatAmbiguous(lookup)
      const session = lookup.session

      const result = await backupOne(undefined, session.id)
      if (!result.ok) return result.error ?? "Backup failed"

      return [
        `Backed up: ${session.title}`,
        `  file:   ${result.path}`,
        `  restore: ask "restore session from ${result.path}"  (or: sm_restore ${result.path})`,
      ].join("\n")
    },

    sm_backup_all: async () => {
      const state = loadStateDefault()
      if (state.pinned.length === 0) return "No pinned sessions to backup."

      let backedUp = 0
      const failures: string[] = []

      for (const entry of state.pinned) {
        const result = await backupOne(undefined, entry.sessionId)
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

    sm_restore: async (args) => {
      const result = await restoreFromBackup(undefined, args.filePath, args.force === true)
      return result.message
    },

    sm_list_backups: async () => {
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

    sm_full_backup: async (args) => {
      const result = await createFullBackup(undefined, args.targetDir)

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

    // ───────────────────────────────────────────────────────────────────────
    // Settings
    // ───────────────────────────────────────────────────────────────────────

    sm_settings: async () => {
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
        `Pinned backup refresh:    every ${state.settings.pinnedBackupRefreshDays} days (Pinned Guarantee)`,
        `Backup directory:         ${backupDirDisplay}`,
        `Pinned sessions:          ${state.pinned.length}`,
        "──────────────────────────────────────────────",
      ].join("\n")
    },

    sm_config: async (args) => {
      const allowedKeys: (keyof SMState["settings"])[] = [
        "autoCleanupEnabled",
        "autoCleanupDays",
        "backupRetentionEnabled",
        "backupRetentionDays",
        "backupDir",
        "pinnedBackupRefreshDays",
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

    // ───────────────────────────────────────────────────────────────────────
    // Cleanup
    // ───────────────────────────────────────────────────────────────────────

    sm_cleanup: async (args) => {
      const dryRun = args.dry_run !== false  // default true
      const report = await runCleanup(undefined, true, dryRun)

      const verb = dryRun ? "would delete" : "deleted"
      const lines = [
        `Cleanup ${dryRun ? "(DRY RUN) " : ""}complete: ${report.deleted.length} sessions ${verb}, ${report.skippedPinned.length} skipped (pinned), ${report.failed.length} failed${report.remaining ? `, ${report.remaining} remaining (next run)` : ""}`,
      ]
      for (const id of report.deleted) lines.push(`  ${dryRun ? "would delete" : "deleted"}: ${id}`)
      for (const id of report.skippedPinned) lines.push(`  pinned: ${id}`)
      for (const id of report.failed) lines.push(`  failed: ${id}`)
      if (report.remaining > 0) {
        lines.push(`  ℹ️  Batch limit reached: ${report.remaining} stale sessions remain — they will be processed on the next run.`)
      }
      if (dryRun && report.deleted.length > 0) {
        lines.push("")
        lines.push("This was a dry run. Re-run with dry_run=false to actually delete.")
      }
      return lines.join("\n")
    },

    sm_cleanup_backups: async (args) => {
      const dryRun = args.dry_run !== false  // default true
      const report = await runBackupRetention(undefined, dryRun)

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

    sm_cleanup_pinned: async () => {
      const state = loadStateDefault()
      if (state.pinned.length === 0) return "No pinned sessions."

      const allSessions = await listSessions(undefined)
      const aliveIds = new Set(allSessions.map((s) => s.id))

      const before = state.pinned.length
      const dead = state.pinned.filter((p) => !aliveIds.has(p.sessionId))
      state.pinned = state.pinned.filter((p) => aliveIds.has(p.sessionId))
      const after = state.pinned.length

      if (dead.length === 0) {
        return `All ${before} pinned sessions still exist in the DB. Nothing to clean.`
      }

      saveStateDefault(state)
      const lines = [
        `Removed ${dead.length} dead pinned entr${dead.length === 1 ? "y" : "ies"} (${after} remain):`,
        ...dead.map((d) => `  ${d.sessionId}  ${d.title}`),
      ]
      return lines.join("\n")
    },
  }

  return { rememberSession, handlers }
}

// ───────────────────────────────────────────────────────────────────────────
// Shared tool metadata: one definition feeds both API adapters
// ───────────────────────────────────────────────────────────────────────────

const S = tool.schema

interface ToolSpec {
  description: string
  /** Zod raw shape — V1 `args`, and the source for the V2 JSON/Standard schema. */
  shape: Record<string, unknown>
}

const TOOL_SPECS: Record<string, ToolSpec> = {
  sm_pin: {
    description: "Pin a session by its ID to protect it from auto-cleanup. Optionally attach a note. If sessionId is omitted, the current session is pinned.",
    shape: { sessionId: S.string().optional(), note: S.string().optional() },
  },
  sm_unpin: {
    description: "Unpin a session by its ID, removing it from the protected list. If sessionId is omitted, the current session is unpinned.",
    shape: { sessionId: S.string().optional() },
  },
  sm_list: {
    description: "List sessions. scope: 'pinned' (default), 'recent' (last 20 by updated), or 'all' (capped at 50).",
    shape: { scope: S.string().optional() },
  },
  sm_search: {
    description: "Search sessions by a case-insensitive substring. search_in: 'title' (default) or 'title+note'. Pinned sessions are marked with *.",
    shape: { query: S.string(), search_in: S.string().optional() },
  },
  sm_current_session: {
    description: "Show the currently active session (id, title, pinned status). Useful before pinning or backing up.",
    shape: {},
  },
  sm_status: {
    description: "One-call overview: session counts, pinned status, backups, cleanup candidates, settings, last auto-run.",
    shape: {},
  },
  sm_backup: {
    description: "Back up a single session by its ID to a JSON file in the backup directory. If sessionId is omitted, the current session is backed up.",
    shape: { sessionId: S.string().optional() },
  },
  sm_backup_all: {
    description: "Back up all pinned sessions to JSON files in the backup directory.",
    shape: {},
  },
  sm_restore: {
    description: "Restore a session from a backup JSON file. Use force=true to overwrite an existing session (a safety backup is created automatically).",
    shape: { filePath: S.string(), force: S.boolean().optional() },
  },
  sm_list_backups: {
    description: "List available session backups in the backup directory, newest first.",
    shape: {},
  },
  sm_full_backup: {
    description: "Create a full backup archive with all pinned sessions, state file, plugin, and restore instructions.",
    shape: { targetDir: S.string().optional() },
  },
  sm_settings: {
    description: "Display current session-manager settings.",
    shape: {},
  },
  sm_config: {
    description: "Update a session-manager setting. Supported keys: autoCleanupEnabled, autoCleanupDays, backupRetentionEnabled, backupRetentionDays, backupDir, pinnedBackupRefreshDays.",
    shape: { key: S.string(), value: S.string() },
  },
  sm_cleanup: {
    description: "Clean up stale, non-pinned sessions by backing them up and deleting them. DRY-RUN by default — pass dry_run=false to actually delete.",
    shape: { dry_run: S.boolean().optional() },
  },
  sm_cleanup_backups: {
    description: "Remove stale backup files while protecting pinned and orphaned backups. DRY-RUN by default — pass dry_run=false to actually delete.",
    shape: { dry_run: S.boolean().optional() },
  },
  sm_cleanup_pinned: {
    description: "Remove pinned entries whose sessions no longer exist in the DB. Use when sm_list shows [DELETED] entries. Replaces the non-working session.deleted hook.",
    shape: {},
  },
}

// ───────────────────────────────────────────────────────────────────────────
// V1 adapter: classic plugin function returning `{ tool, hooks }`
// ───────────────────────────────────────────────────────────────────────────

export const SessionManagerPlugin: V1Plugin = async () => {
  const core = createCore()

  const tools: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(TOOL_SPECS)) {
    tools[name] = tool({
      description: spec.description,
      args: spec.shape as Record<string, any>,
      async execute(args: Args) {
        return core.handlers[name]?.(args) ?? `Unknown tool: ${name}`
      },
    })
  }

  const hooks: Hooks = {
    // @ts-expect-error — the tool map is assembled dynamically from TOOL_SPECS.
    tool: tools,

    // Tracks the active session for resolveSessionId() AND triggers periodic
    // auto-maintenance (cleanup + retention) with a 1-hour debounce.
    // Replaces the dead `session.idle` hook (SDK 1.3.0 does not fire it).
    "tool.execute.before": async (input: unknown, _output: unknown) => {
      try {
        if (input && typeof input === "object" && "sessionID" in input) {
          const sid = (input as { sessionID?: unknown }).sessionID
          if (typeof sid === "string" && sid) {
            core.rememberSession(sid)
          }
        }
      } catch { /* best-effort — never crash the hook */ }

      // Periodic maintenance — fire-and-forget, never blocks the tool call.
      maybeAutoMaintenance()
    },

    // ───────────────────────────────────────────────────────────────────────
    // Note on session.idle / session.deleted:
    // These hooks are declared in the opencode docs but NOT fired by the
    // current SDK (verified empirically — see session-manager-hooks.log
    // stays empty after `opencode session delete`). Their responsibilities
    // are covered by:
    //   - tool.execute.before  → periodic cleanup/retention (1 h debounce)
    //   - sm_list (scope=pinned) + sm_cleanup_pinned → lazy dead-pin removal
    // If a future SDK release starts firing these hooks, the logic above
    // is idempotent and safe to invoke twice.
  }

  return hooks
}

// ───────────────────────────────────────────────────────────────────────────
// V2 adapter: Plugin.define({ id, setup })
// ───────────────────────────────────────────────────────────────────────────

/**
 * Registers every tool with `ctx.tool.transform` and the session-tracking
 * hook with `ctx.tool.hook("execute.before", ...)`.
 *
 * Tools are added with a Standard-Schema input (the same Zod raw shape the V1
 * adapter passes as `args`), so the argument contract cannot drift between the
 * two versions. Execution returns `{ content }` — the V2 tool result shape.
 */
async function setupV2(ctx: V2Context): Promise<void> {
  const core = createCore()

  await ctx.tool.transform((editor) => {
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      editor.add({
        name,
        description: spec.description,
        input: S.object(spec.shape as Record<string, any>) as any,
        async execute(input: Args) {
          return { content: await (core.handlers[name]?.(input ?? {}) ?? `Unknown tool: ${name}`) }
        },
      } as any)
    }
  })

  await ctx.tool.hook("execute.before", (event) => {
    try {
      if (typeof event.sessionID === "string") core.rememberSession(event.sessionID)
    } catch { /* best-effort — never crash the hook */ }
    maybeAutoMaintenance()
  })
}

export const SessionManagerV2: V2Plugin = {
  id: PLUGIN_ID,
  setup: setupV2,
}

// Default export: V2 reads `id` + `setup`, V1 (1.18.29+) reads `server()`.
export default {
  ...SessionManagerV2,
  server: SessionManagerPlugin,
}
