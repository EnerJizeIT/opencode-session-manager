/**
 * OpenCode Session Manager Plugin
 *
 * Pin sessions, backup, restore, auto-cleanup and search.
 * Phase 0: plugin skeleton + state management + CLI wrappers.
 *
 * @version 1.0.0
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs"
import { join, homedir } from "path"

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

/**
 * Load plugin state from the JSON file.
 * Returns `DEFAULT_STATE` when the file is missing or contains invalid JSON.
 */
function loadState(): SMState {
  try {
    if (!existsSync(STATE_FILE)) {
      return { ...DEFAULT_STATE }
    }
    const raw = readFileSync(STATE_FILE, "utf-8")
    const parsed = JSON.parse(raw) as SMState
    return parsed
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/**
 * Save plugin state atomically: write to a `.tmp` file, then rename.
 */
function saveState(state: SMState): void {
  try {
    const tmpPath = STATE_FILE + ".tmp"
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8")
    renameSync(tmpPath, STATE_FILE)
  } catch {
    // Graceful — state save failure is non-fatal for read operations.
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
// 0.5 — Formatting helpers
// ---------------------------------------------------------------------------

function formatDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function truncateId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "..." : id
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
          if (state.pinned.length === 0) return "No pinned sessions."

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
          if (sessions.length === 0) return `No sessions match: ${args.query}`

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
    },

    // Phase 3: remove deleted session from pinned list.
    "session.deleted": async (_input: unknown, _output: unknown) => {
      // TODO: implement in Phase 3
    },

    // Phase 3: auto-cleanup + backup retention (debounced 1 h).
    "session.idle": async (_input: unknown, _output: unknown) => {
      // TODO: implement in Phase 3
    },
  }
}
