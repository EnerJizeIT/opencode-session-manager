/**
 * OpenCode Session Manager Plugin
 *
 * Pin sessions, backup, restore, auto-cleanup and search.
 *
 * @version 1.0.0
 * @author opencode-session-manager
 *
 * Installation:
 *   1. Copy this file to ~/.config/opencode/plugins/session-manager.ts
 *   2. State file: ~/.local/share/opencode/session-manager.json
 *   3. Backups:    ~/.local/share/opencode/backups/
 *   4. Start opencode — the plugin loads automatically.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, copyFileSync, unlinkSync } from "fs"
import { join, homedir, sep } from "path"
import { tmpdir } from "os"

// ---------------------------------------------------------------------------
// 0.2 — State file
// ---------------------------------------------------------------------------

/** Path to the plugin state file. */
const STATE_FILE = join(homedir(), ".local", "share", "opencode", "session-manager.json")

/** Default directory for session backups. */
const DEFAULT_BACKUP_DIR = join(homedir(), ".local", "share", "opencode", "backups")

/** Plugin state shape. */
interface SMState {
  version: string
  settings: {
    autoCleanupEnabled: boolean
    autoCleanupDays: number
    backupRetentionEnabled: boolean
    backupRetentionDays: number
    backupDir: string
  }
  pinned: Array<{ sessionId: string; title: string; pinnedAt: number; note: string }>
  lastAutoRun?: number | null
}

/** Default state returned when the file is missing or corrupted. */
const DEFAULT_STATE: SMState = {
  version: "1.0.0",
  settings: {
    autoCleanupEnabled: false,
    autoCleanupDays: 30,
    backupRetentionEnabled: false,
    backupRetentionDays: 30,
    backupDir: DEFAULT_BACKUP_DIR,
  },
  pinned: [],
  lastAutoRun: null,
}

/** Backup envelope wrapping a single session export. */
interface BackupEnvelope {
  version: string
  exportedAt: number
  backupOf: string
  session: unknown
}

/** Report returned by the cleanup routine. */
interface CleanupReport {
  deleted: string[]
  skippedPinned: string[]
  failed: string[]
}

/** Report returned by the backup-retention routine. */
interface RetentionReport {
  removed: string[]
  protected: string[]
  skippedRecent: string[]
  corrupt: string[]
}

/**
 * Migrate raw state to the current SMState schema.
 * Pure function: one input (`unknown`), one output (`SMState`), no side effects.
 * Returns `DEFAULT_STATE` when `raw` is not a valid state object.
 */
function migrateState(raw: unknown): SMState {
  if (
    raw === null ||
    typeof raw !== "object" ||
    !("version" in raw) ||
    typeof (raw as Record<string, unknown>).version !== "string"
  ) {
    return { ...DEFAULT_STATE }
  }

  const versioned = raw as Record<string, unknown>
  const currentVersion = versioned.version as string

  // Migration chain: apply steps if version is behind.
  // Currently only "1.0.0" exists, so the chain is empty.
  // future: 1.0.0 -> 1.1.0
  // future: 1.1.0 -> 1.2.0
  const migratedVersion = currentVersion

  // Merge with DEFAULT_STATE to fill in missing fields from future schema additions.
  const merged = {
    ...DEFAULT_STATE,
    ...versioned,
    settings: {
      ...DEFAULT_STATE.settings,
      ...(typeof versioned.settings === "object" && versioned.settings !== null
        ? versioned.settings
        : {}),
    },
    version: migratedVersion,
    pinned: Array.isArray(versioned.pinned) ? versioned.pinned : DEFAULT_STATE.pinned,
  } as SMState

  return merged
}

/**
 * Load plugin state from the JSON file.
 * Returns `DEFAULT_STATE` when the file is missing or contains invalid JSON.
 * Uses `migrateState` to handle version upgrades and fill missing fields.
 */
function loadState(): SMState {
  try {
    if (!existsSync(STATE_FILE)) {
      return { ...DEFAULT_STATE }
    }
    const raw = readFileSync(STATE_FILE, "utf-8")
    const parsed = JSON.parse(raw)
    return migrateState(parsed)
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/**
 * Save plugin state atomically: write to a `.tmp` file, then rename.
 * Returns `true` on success, `false` on failure.
 */
function saveState(state: SMState): boolean {
  try {
    const tmpPath = STATE_FILE + ".tmp"
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8")
    renameSync(tmpPath, STATE_FILE)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 0.3 — CLI wrappers
// ---------------------------------------------------------------------------

/**
 * Parse JSON from opencode CLI stdout, stripping any prefix noise
 * (e.g. `[page-assist] CLI mode …` lines).
 */
function parseJson(stdout: string): unknown {
  const start = stdout.search(/[\[{]/)
  const slice = start >= 0 ? stdout.slice(start) : stdout
  return JSON.parse(slice)
}

/** Session info returned by `opencode session list --format json`. */
interface SessionInfo {
  id: string
  title: string
  updated: number
  created: number
  projectId: string
  directory: string
}

/**
 * List all sessions via `opencode session list --format json`.
 * Returns an empty array on failure.
 */
async function listSessions($: Plugin["$"]): Promise<SessionInfo[]> {
  try {
    const res = await $`opencode session list --format json`
    const stdout = res.stdout.toString()
    const parsed = parseJson(stdout) as SessionInfo[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Find a single session by its ID.
 * Returns `null` when not found or on error.
 */
async function findSessionById($: Plugin["$"], id: string): Promise<SessionInfo | null> {
  try {
    const sessions = await listSessions($)
    return sessions.find((s) => s.id === id) ?? null
  } catch {
    return null
  }
}

/**
 * Search sessions by a case-insensitive substring match on `title`.
 * Returns an empty array on failure.
 */
async function searchSessions($: Plugin["$"], query: string): Promise<SessionInfo[]> {
  try {
    const sessions = await listSessions($)
    const lower = query.toLowerCase()
    return sessions.filter((s) => s.title.toLowerCase().includes(lower))
  } catch {
    return []
  }
}

/**
 * Export a session via `opencode export <id>`.
 * Returns the raw stdout (native JSON round-trip format).
 * Returns an empty string on failure.
 */
async function exportSession($: Plugin["$"], id: string): Promise<string> {
  try {
    const res = await $`opencode export ${id}`
    return res.stdout.toString()
  } catch {
    return ""
  }
}

/**
 * Import a session from a JSON file via `opencode import <file>`.
 * Returns `true` when the command exits successfully.
 */
async function importSession($: Plugin["$"], filePath: string): Promise<boolean> {
  try {
    await $`opencode import ${filePath}`
    return true
  } catch {
    return false
  }
}

/**
 * Delete a session via `opencode session delete <id>`.
 * Returns `true` when the command exits successfully.
 */
async function deleteSession($: Plugin["$"], id: string): Promise<boolean> {
  try {
    await $`opencode session delete ${id}`
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 2.0 — Backup helpers
// ---------------------------------------------------------------------------

/**
 * Back up a single session to a JSON file in the given directory.
 * Returns `{ ok, path, error }` result object.
 */
async function backupOne($: Plugin["$"], sessionId: string, targetDir = DEFAULT_BACKUP_DIR): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const session = await findSessionById($, sessionId)
    if (!session) {
      return { ok: false, error: `Session not found: ${sessionId}` }
    }

    const exportedRaw = await exportSession($, sessionId)
    if (!exportedRaw.trim()) {
      return { ok: false, error: `Backup failed: could not export ${sessionId}` }
    }

    const sessionData = parseJson(exportedRaw)
    const envelope: BackupEnvelope = {
      version: "1.0.0",
      exportedAt: Date.now(),
      backupOf: sessionId,
      session: sessionData,
    }

    mkdirSync(targetDir, { recursive: true })
    const filePath = join(targetDir, `${sessionId}.json`)
    const tmpPath = filePath + ".tmp"
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), "utf-8")
    renameSync(tmpPath, filePath)

    return { ok: true, path: filePath }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Unknown error during backup" }
  }
}

// ---------------------------------------------------------------------------
// 3.0 — Cleanup & retention helpers (reusable by tools and hooks)
// ---------------------------------------------------------------------------

/**
 * Run cleanup: backup-then-delete for stale, non-pinned sessions.
 * @param $ - Bun shell context
 * @param force - if true, ignore autoCleanupEnabled setting (used by manual tool)
 */
async function runCleanup($: Plugin["$"], force = false): Promise<CleanupReport> {
  const state = loadState()
  if (!force && !state.settings.autoCleanupEnabled) {
    return { deleted: [], skippedPinned: [], failed: [] }
  }

  const cutoff = Date.now() - state.settings.autoCleanupDays * 86400000
  const sessions = await listSessions($)
  const pinnedIds = new Set(state.pinned.map((p) => p.sessionId))

  const deleted: string[] = []
  const skippedPinned: string[] = []
  const failed: string[] = []

  for (const s of sessions) {
    if (pinnedIds.has(s.id)) {
      skippedPinned.push(s.id)
      continue
    }
    if (s.updated >= cutoff) {
      continue
    }

    const backupResult = await backupOne($, s.id)
    if (!backupResult.ok) {
      failed.push(s.id)
      continue
    }

    const deletedOk = await deleteSession($, s.id)
    if (!deletedOk) {
      failed.push(s.id)
      continue
    }

    deleted.push(s.id)
  }

  return { deleted, skippedPinned, failed }
}

/**
 * Run backup retention: remove stale backups while protecting pinned and orphaned ones.
 * @param $ - Bun shell context
 */
async function runBackupRetention($: Plugin["$"]): Promise<RetentionReport> {
  const state = loadState()
  if (!state.settings.backupRetentionEnabled) {
    return { removed: [], protected: [], skippedRecent: [], corrupt: [] }
  }

  const cutoff = Date.now() - state.settings.backupRetentionDays * 86400000
  const sessions = await listSessions($)
  const aliveIds = new Set(sessions.map((s) => s.id))
  const pinnedIds = new Set(state.pinned.map((p) => p.sessionId))

  const removed: string[] = []
  const protectedList: string[] = []
  const skippedRecent: string[] = []
  const corrupt: string[] = []

  try {
    const files = readdirSync(DEFAULT_BACKUP_DIR)
    const backupFiles = files.filter((f) => f.endsWith(".json"))

    for (const file of backupFiles) {
      const filePath = join(DEFAULT_BACKUP_DIR, file)
      let envelope: BackupEnvelope | null = null

      try {
        const raw = readFileSync(filePath, "utf-8")
        envelope = JSON.parse(raw) as BackupEnvelope
      } catch {
        try {
          renameSync(filePath, filePath + ".corrupt")
        } catch { /* best effort */ }
        corrupt.push(file)
        continue
      }

      if (!envelope || typeof envelope.backupOf !== "string" || typeof envelope.exportedAt !== "number") {
        try {
          renameSync(filePath, filePath + ".corrupt")
        } catch { /* best effort */ }
        corrupt.push(file)
        continue
      }

      if (pinnedIds.has(envelope.backupOf)) {
        protectedList.push(file)
        continue
      }

      if (!aliveIds.has(envelope.backupOf)) {
        protectedList.push(file)
        continue
      }

      if (envelope.exportedAt < cutoff) {
        try {
          unlinkSync(filePath)
          removed.push(file)
        } catch { /* best effort */ }
        continue
      }

      skippedRecent.push(file)
    }
  } catch {
    // If backup dir doesn't exist, nothing to clean
  }

  return { removed, protected: protectedList, skippedRecent, corrupt }
}

// ---------------------------------------------------------------------------
// 0.5 — Formatting helpers
// ---------------------------------------------------------------------------

function formatDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function truncateId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "..." : id
}

/**
 * Check if backup files exist in DEFAULT_BACKUP_DIR.
 */
function hasBackupFiles(): boolean {
  try {
    const files = readdirSync(DEFAULT_BACKUP_DIR)
    return files.some((f) => f.endsWith(".json"))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 0.1 — Plugin skeleton
// ---------------------------------------------------------------------------

export const SessionManagerPlugin: Plugin = async ({ client, $ }) => {
  // CLI wrappers are bound to the plugin's $ (Bun shell) context.
  // Tools (sm_pin, sm_search, …) will be added in Phase 1+.
  // Hooks (session.deleted, session.idle) will get real logic in Phase 3.

  return {
    tool: {
      // Pin a session so it is protected from auto-cleanup.
      sm_pin: tool({
        description: "Pin a session by its ID to protect it from auto-cleanup. Optionally attach a note.",
        args: {
          sessionId: tool.schema.string(),
          note: tool.schema.string().optional(),
        },
        async execute(args) {
          const session = await findSessionById($, args.sessionId)
          if (!session) return `Session not found: ${args.sessionId}`

          const state = loadState()
          const existing = state.pinned.find((p) => p.sessionId === args.sessionId)
          if (existing) return `Already pinned: ${existing.title}`

          state.pinned.push({
            sessionId: args.sessionId,
            title: session.title,
            pinnedAt: Date.now(),
            note: args.note ?? "",
          })
          saveState(state)
          return `Pinned: ${session.title} (${args.sessionId})`
        },
      }),

      // Unpin a previously pinned session.
      sm_unpin: tool({
        description: "Unpin a session by its ID, removing it from the protected list.",
        args: {
          sessionId: tool.schema.string(),
        },
        async execute(args) {
          const state = loadState()
          const idx = state.pinned.findIndex((p) => p.sessionId === args.sessionId)
          if (idx === -1) return `Not pinned: ${args.sessionId}`

          const entry = state.pinned[idx]
          state.pinned.splice(idx, 1)
          saveState(state)
          return `Unpinned: ${entry.title}`
        },
      }),

      // List all currently pinned sessions.
      sm_list: tool({
        description: "List all pinned sessions with their titles, pin dates, and notes.",
        args: {},
        async execute() {
          const state = loadState()
          if (state.pinned.length === 0) {
            let msg = "No pinned sessions."
            if (hasBackupFiles()) {
              msg += `\nHint: session DB looks empty. Backups available in ${DEFAULT_BACKUP_DIR}; use sm_restore.`
            }
            return msg
          }

          const rows: string[] = []
          for (const entry of state.pinned) {
            const alive = await findSessionById($, entry.sessionId)
            const titleStr = entry.title + (alive ? "" : " [DELETED]")
            rows.push(
              `${truncateId(entry.sessionId).padEnd(16)}${titleStr.padEnd(32)}${formatDate(entry.pinnedAt).padEnd(16)}${entry.note}`,
            )
          }

          return [
            `Pinned sessions (${state.pinned.length}):`,
            "──────────────────────────────────────────────────",
            `${"ID".padEnd(16)}${"Title".padEnd(32)}${"Pinned".padEnd(16)}Note`,
            "──────────────────────────────────────────────────",
            ...rows,
            "──────────────────────────────────────────────────",
          ].join("\n")
        },
      }),

      // Search sessions by title substring.
      sm_search: tool({
        description: "Search sessions by a case-insensitive title substring. Pinned sessions are marked with *.",
        args: {
          query: tool.schema.string(),
        },
        async execute(args) {
          const sessions = await searchSessions($, args.query)
          if (sessions.length === 0) {
            let msg = `No sessions match: ${args.query}`
            const allSessions = await listSessions($)
            if (allSessions.length === 0 && hasBackupFiles()) {
              msg += `\nHint: session DB looks empty. Backups available in ${DEFAULT_BACKUP_DIR}; use sm_restore.`
            }
            return msg
          }

          const state = loadState()
          const pinnedIds = new Set(state.pinned.map((p) => p.sessionId))

          const rows: string[] = []
          for (const s of sessions) {
            const isPinned = pinnedIds.has(s.id)
            const prefix = isPinned ? "* " : "  "
            rows.push(
              `${prefix}${truncateId(s.id).padEnd(16)}${s.title.padEnd(32)}${formatDate(s.updated).padEnd(16)}${isPinned ? "Yes" : "No"}`,
            )
          }

          return [
            `Sessions matching "${args.query}" (${sessions.length}):`,
            "──────────────────────────────────────────────────",
            `${"ID".padEnd(16)}${"Title".padEnd(32)}${"Updated".padEnd(16)}Pinned`,
            "──────────────────────────────────────────────────",
            ...rows,
            "──────────────────────────────────────────────────",
            "Use: opencode -s <full_id> to continue a session",
          ].join("\n")
        },
      }),

      // Back up a single session to a JSON file.
      sm_backup: tool({
        description: "Back up a single session by its ID to a JSON file in the backup directory.",
        args: {
          sessionId: tool.schema.string(),
        },
        async execute(args) {
          const session = await findSessionById($, args.sessionId)
          if (!session) return `Session not found: ${args.sessionId}`

          const result = await backupOne($, args.sessionId)
          if (!result.ok) return result.error ?? "Backup failed"

          return `Backed up: ${session.title} -> ${result.path}`
        },
      }),

      // Back up all pinned sessions.
      sm_backup_all: tool({
        description: "Back up all pinned sessions to JSON files in the backup directory.",
        args: {},
        async execute() {
          const state = loadState()
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

      // Restore a session from a backup file.
      sm_restore: tool({
        description: "Restore a session from a backup JSON file. Use force=true to overwrite an existing session.",
        args: {
          filePath: tool.schema.string(),
          force: tool.schema.boolean().optional(),
        },
        async execute(args) {
          if (!existsSync(args.filePath)) {
            return `Restore failed: file not found: ${args.filePath}`
          }

          let envelope: BackupEnvelope
          try {
            const raw = readFileSync(args.filePath, "utf-8")
            envelope = JSON.parse(raw) as BackupEnvelope
          } catch {
            return "Restore failed: invalid backup envelope"
          }

          // Validation mirrors backup-schema.json (root of this repo).
          // No ajv dependency — manual check kept lightweight.
          if (
            typeof envelope.version !== "string" ||
            !/^\d+\.\d+\.\d+$/.test(envelope.version) ||
            typeof envelope.exportedAt !== "number" ||
            typeof envelope.backupOf !== "string" ||
            typeof envelope.session !== "object" ||
            envelope.session === null
          ) {
            return "Restore failed: invalid backup envelope"
          }

          const sessionId = envelope.backupOf
          const existing = await findSessionById($, sessionId)

          if (existing) {
            if (args.force !== true) {
              return `Session already exists: ${sessionId}. Re-run with force=true to overwrite (current one will be deleted first).`
            }
            await deleteSession($, sessionId)
          }

          try {
            const tmpFile = join(tmpdir(), `sm-restore-${sessionId}-${Date.now()}.json`)
            writeFileSync(tmpFile, JSON.stringify(envelope.session, null, 2), "utf-8")

            const ok = await importSession($, tmpFile)
            try {
              unlinkSync(tmpFile)
            } catch { /* best-effort cleanup */ }

            if (!ok) {
              return `Restore failed: import error for ${sessionId}`
            }

            const title =
              (envelope.session as any)?.info?.title ?? sessionId
            return `Restored: ${title} (${sessionId})`
          } catch (err: any) {
            return `Restore failed: ${err?.message ?? "unknown error"}`
          }
        },
      }),

      // Show current plugin settings.
      sm_settings: tool({
        description: "Display current session-manager settings.",
        args: {},
        async execute() {
          const state = loadState()
          const backupDirDisplay =
            state.settings.backupDir === DEFAULT_BACKUP_DIR
              ? "~/.local/share/opencode/backups"
              : state.settings.backupDir
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

      // Update a single plugin setting by key/value.
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

          const state = loadState()
          ;(state.settings as Record<string, unknown>)[args.key] = converted
          saveState(state)
          return `Setting updated: ${args.key} = ${converted}`
        },
      }),

      // Manual cleanup of stale sessions (backup-then-delete).
      sm_cleanup: tool({
        description: "Clean up stale, non-pinned sessions by backing them up and deleting them.",
        args: {},
        async execute() {
          const report = await runCleanup($, true)

          const lines = [
            `Cleanup complete: ${report.deleted.length} sessions backed up + deleted, ${report.skippedPinned.length} skipped (pinned), ${report.failed.length} failed`,
          ]
          for (const id of report.deleted) lines.push(`  deleted: ${truncateId(id)}`)
          for (const id of report.skippedPinned) lines.push(`  pinned: ${truncateId(id)}`)
          for (const id of report.failed) lines.push(`  failed: ${truncateId(id)}`)
          return lines.join("\n")
        },
      }),

      // Remove stale backups while protecting pinned and orphaned ones.
      sm_cleanup_backups: tool({
        description: "Remove stale backup files while protecting pinned and orphaned backups.",
        args: {},
        async execute() {
          const report = await runBackupRetention($)

          const lines = [
            `Backup rotation: ${report.removed.length} removed, ${report.protected.length} protected (pinned/orphaned), ${report.skippedRecent.length} skipped (recent)`,
          ]
          for (const f of report.removed) lines.push(`  removed: ${f}`)
          for (const f of report.protected) lines.push(`  protected: ${f}`)
          for (const f of report.skippedRecent) lines.push(`  recent: ${f}`)
          if (report.corrupt.length > 0) {
            for (const f of report.corrupt) lines.push(`  corrupt: ${f}`)
          }
          return lines.join("\n")
        },
      }),

      // Full backup: all pinned sessions + state + plugin + restore instructions.
      sm_full_backup: tool({
        description: "Create a full backup archive with all pinned sessions, state file, plugin, and restore instructions.",
        args: {
          targetDir: tool.schema.string().optional(),
        },
        async execute(args) {
          const targetDir = args.targetDir ?? join(DEFAULT_BACKUP_DIR, `full-backup-${Date.now()}`)
          mkdirSync(targetDir, { recursive: true })

          const state = loadState()
          let backedUp = 0
          const failures: string[] = []

          for (const entry of state.pinned) {
            const result = await backupOne($, entry.sessionId, targetDir)
            if (result.ok) {
              backedUp++
            } else {
              failures.push(`  failed: ${entry.title} (${entry.sessionId}): ${result.error}`)
            }
          }

          let hasState = false
          if (existsSync(STATE_FILE)) {
            try {
              copyFileSync(STATE_FILE, join(targetDir, "session-manager.json"))
              hasState = true
            } catch { /* skip */ }
          }

          let hasPlugin = false
          const pluginPath = join(homedir(), ".config", "opencode", "plugins", "session-manager.ts")
          if (existsSync(pluginPath)) {
            try {
              copyFileSync(pluginPath, join(targetDir, "session-manager.ts"))
              hasPlugin = true
            } catch { /* skip */ }
          }

          const restoreMd = `# OpenCode Session Restore

## Recovery after reinstall

1. Install opencode normally
2. Copy the plugin:
   cp .${sep}session-manager.ts ~/.config/opencode/plugins/
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
          writeFileSync(join(targetDir, "RESTORE.md"), restoreMd, "utf-8")

          const parts = [`${backedUp} sessions`]
          if (hasState) parts.push("state")
          if (hasPlugin) parts.push("plugin")
          parts.push("RESTORE.md")

          let summary = `Full backup created: ${targetDir} (${parts.join(", ")})`
          if (failures.length > 0) {
            summary += "\n" + failures.join("\n")
          }
          return summary
        },
      }),
    },

    // Phase 3: remove deleted session from pinned list.
    "session.deleted": async (input: unknown, _output: unknown) => {
      try {
        const state = loadState()
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
          saveState(state)
        }
      } catch {
        // Never crash the hook
      }
    },

    // Phase 3: auto-cleanup + backup retention (debounced 1 h).
    "session.idle": async (_input: unknown, _output: unknown) => {
      try {
        const state = loadState()
        if (state.lastAutoRun && Date.now() - state.lastAutoRun < 3600000) {
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
        saveState(state)

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
