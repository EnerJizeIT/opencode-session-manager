/**
 * Session discovery + CLI wrappers for export/import/delete.
 *
 * Each wrapper returns a normalised type. Errors are swallowed and surfaced
 * as empty results — callers can distinguish "no sessions" from "DB broken"
 * via `findSessionByQuery`, which returns a typed error result.
 *
 * Session listing: `listSessions` reads the opencode database directly
 * (`bun:sqlite`, readonly) instead of `opencode session list` — the CLI
 * scopes its list to the current project directory (TODO-0012). opencode
 * 2.x writes new sessions to `session_v2` and that table is the source of
 * truth; the legacy `session` table is a migration remnant the 2.x CLI
 * cannot export or delete (verified 03.11: `session export` says "not
 * found", `session delete` leaves the row), so surfacing it would create
 * phantom sessions. In a 1.x environment only `session` exists — we read it.
 * (Bug of 30.10: only the legacy table was read, so every new session was
 * invisible — sm_pin said "Session not found" for a session that existed.)
 *
 * Export / import / delete still go through the CLI. The command layout
 * differs between versions, so the plugin adapter picks the flavor at load
 * time (`setCliFlavor`): v1 — `opencode export|import <arg>`, v2 —
 * `opencode session export|import <arg>`; `session delete` exists in both.
 *
 * Process invocation — node:child_process.execFile, NOT Bun Shell:
 *   - Bun Shell inherits subprocess stdout/stderr onto the parent terminal,
 *     so every background CLI call painted the user's terminal with the
 *     session JSON (delete), progress lines ("Exporting session: …") and
 *     "[page-assist] …" noise (verified experimentally).
 *   - Bun Shell's parser rejects stacked redirects (`cmd > f 2>/dev/null` —
 *     "expected a command or assignment but got: Redirect"), and .quiet()
 *     support varies with the bundled Bun version inside opencode.
 *   - execFile captures both streams by default (stdio: "pipe") — nothing
 *     reaches the terminal, ever. maxBuffer is raised above the default 1 MB
 *     so multi-MB session exports don't truncate (the reason a pipe-capture
 *     fix was needed for Bun.spawn in v1.0.2).
 *
 * Performance: the DB select over ~10k rows takes milliseconds.
 * `listSessions` caches the result for 5 s; delete/import invalidate it.
 */

import { execFile as execFileCb, spawn } from "child_process"
import { promisify } from "util"
import { existsSync, openSync, closeSync, readFileSync, unlinkSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"
import { Database } from "bun:sqlite"
import { loadStateDefault, logHookEvent } from "./state"
import type { SessionInfo, FindQueryResult } from "./types"

const execFile = promisify(execFileCb)

/** Session exports can be multi-MB; 64 MB leaves generous headroom. */
const MAX_BUFFER = 64 * 1024 * 1024

/** Kill a hanging CLI call after 2 minutes (network/hung TUI safety). */
const CLI_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------------------
// CLI flavor: opencode 1.x keeps export/import at the root, 2.x moved them
// under `session` (`opencode session export|import`). The plugin-API version
// is not proof (a V2 runtime still loads a legacy server() plugin), so the
// CLI binary's own version is the ground truth: probed once per process and
// cached. The adapter hint (`setCliFlavor`) is only a fallback for a failed
// probe.
// ---------------------------------------------------------------------------

export type CliFlavor = "v1" | "v2"

let cliFlavorHint: CliFlavor = "v1"

/** Set by the probe on first CLI use; null until then. */
let resolvedFlavor: CliFlavor | null = null

/** Adapter hint (V1 runtime "v1", V2 runtime "v2"); also the test seam. */
export function setCliFlavor(flavor: CliFlavor): void {
  cliFlavorHint = flavor
  resolvedFlavor = null
}

export function getCliFlavor(): CliFlavor {
  return resolvedFlavor ?? cliFlavorHint
}

/**
 * Resolve the installed CLI generation once per process: opencode 2.x moved
 * export/import under `session`. Falls back to the adapter hint if the probe
 * fails. Never throws.
 */
async function resolveCliFlavor(): Promise<CliFlavor> {
  if (resolvedFlavor) return resolvedFlavor
  try {
    const { stdout } = await execFile("opencode", ["--version"], { timeout: 10_000 })
    const major = Number.parseInt(String(stdout).match(/(\d+)\./)?.[1] ?? "", 10)
    if (Number.isFinite(major)) resolvedFlavor = major >= 2 ? "v2" : "v1"
  } catch { /* keep the hint */ }
  return resolvedFlavor ?? cliFlavorHint
}

/** Bun shell context — kept in call-sites for API stability; unused here. */

// ---------------------------------------------------------------------------
// Diagnostic logging for listSessions (bug: empty DB — facts before fixes)
// ---------------------------------------------------------------------------

/**
 * Reduce a stream (stdout/stderr) or message to a single-line tail for the
 * diagnostic log. Newlines are flattened, length capped, no env values.
 */
function tailForLog(value: unknown, max = 500): string {
  if (value === undefined || value === null) return ""
  const str = Buffer.isBuffer(value) ? value.toString("utf-8") : String(value)
  const flat = str.replace(/\s+/g, " ").trim()
  return flat.length > max ? "…<cut>" + flat.slice(-max) : flat
}

// ---------------------------------------------------------------------------
// Session list: direct DB read (project-independent)
// ---------------------------------------------------------------------------

/** Default opencode database location. */
export const OPENCODE_DB = join(homedir(), ".local", "share", "opencode", "opencode.db")

/** Test seam: point listSessions at a different DB; null restores the default. */
let dbPathOverride: string | null = null

/** Last logged schema signature — one line per process/schema change. */
let lastSchemaSignature: string | null = null

export function setSessionDbPath(path: string | null): void {
  dbPathOverride = path
  lastSchemaSignature = null
}

/** Session tables the plugin reads, in preference order (v2 wins on id collisions). */
const SESSION_TABLES = ["session_v2", "session"] as const
type SessionTable = (typeof SESSION_TABLES)[number]

/** Columns the plugin needs — never message/part (the DB is multi-GB). */
const SESSION_COLUMNS = "id, title, time_created, time_updated, project_id, directory"

export interface SessionReadResult {
  /** Merged sessions, newest first, deduplicated by id. */
  sessions: SessionInfo[]
  /** Tables actually read, in preference order. */
  tables: SessionTable[]
  /** Row count read per table (before merging). */
  perTable: Record<string, number>
}

interface SessionRow {
  id: string
  title: string | null
  time_created: number | null
  time_updated: number | null
  project_id: string | null
  directory: string | null
}

function readSessionTable(db: Database, table: SessionTable): SessionInfo[] {
  const rows = db
    .query(`SELECT ${SESSION_COLUMNS} FROM ${table}`)
    .all() as SessionRow[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? "",
    created: Number(r.time_created) || 0,
    updated: Number(r.time_updated) || 0,
    projectId: r.project_id ?? "",
    directory: r.directory ?? "",
  }))
}

/** Session tables present in this DB, plus every table name for diagnostics. */
function probeSessionTables(db: Database): { tables: SessionTable[]; available: string[] } {
  const available = (
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
  const present = new Set(available)
  return { tables: SESSION_TABLES.filter((t) => present.has(t)), available }
}

/**
 * Read sessions from the active table — `session_v2` when present (opencode
 * 2.x, the source of truth and the table the 2.x CLI manages), otherwise the
 * legacy `session` (1.x). Six display columns only, newest first. Opens the
 * DB readonly and always closes it. Throws on any failure — the caller
 * decides what to do.
 */
export function readAllSessionsDetailed(dbPath: string): SessionReadResult {
  if (!existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`)
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    const { tables, available } = probeSessionTables(db)
    if (tables.length === 0) {
      throw new Error(
        `no session table found (have: ${available.slice(0, 40).join(",") || "none"})`,
      )
    }
    // opencode 2.x is the source of truth: its `session_v2` table only. The
    // legacy `session` table is a migration remnant — the 2.x CLI cannot
    // export or delete its rows (verified 03.11), so surfacing them would
    // produce phantom sessions that cleanup could never remove.
    const table: SessionTable = tables.includes("session_v2") ? "session_v2" : "session"
    const sessions = readSessionTable(db, table).sort((a, b) => b.updated - a.updated)
    return { sessions, tables: [table], perTable: { [table]: sessions.length } }
  } finally {
    db.close()
  }
}

/** Merged session list (back-compat wrapper around readAllSessionsDetailed). */
export function readAllSessions(dbPath: string): SessionInfo[] {
  return readAllSessionsDetailed(dbPath).sessions
}

// ---------------------------------------------------------------------------
// Session list cache (listSessions is the hottest call — ~2 s per invocation)
// ---------------------------------------------------------------------------

const LIST_CACHE_TTL_MS = 5000
let listCache: { sessions: SessionInfo[]; ts: number } | null = null

/** Drop the cached session list. Call after any DB mutation (delete/import). */
export function invalidateSessionCache(): void {
  listCache = null
}

/**
 * List all sessions from the opencode DB (project-independent — TODO-0012).
 * Cached for 5 seconds — repeated calls within the TTL return instantly.
 * Returns an empty array on failure.
 *
 * The source is a readonly `bun:sqlite` select over every known session table
 * (`session_v2` on opencode 2.x, legacy `session`), merged with the v2 row
 * preferred on id collisions. The CLI is not used: it scopes results to the
 * current project directory and made the plugin blind to other projects'
 * sessions (pinned ones included, mislabelled as deleted).
 */
export async function listSessions(_$: unknown): Promise<SessionInfo[]> {
  if (listCache && Date.now() - listCache.ts < LIST_CACHE_TTL_MS) {
    return listCache.sessions
  }
  const dbPath = dbPathOverride ?? OPENCODE_DB
  const startedAt = Date.now()
  try {
    const { sessions, tables } = readAllSessionsDetailed(dbPath)
    const ms = Date.now() - startedAt
    const signature = tables.join("+")
    const schemaChanged = signature !== lastSchemaSignature
    lastSchemaSignature = signature
    if (sessions.length === 0) {
      logHookEvent("listSessions", `OK count=0 ms=${ms} db=${dbPath} tables=${signature}`)
    } else if (schemaChanged) {
      // One line per process/schema change: a renamed or dropped table shows
      // up in the hooks log without an investigation (the 2.x bug hid here).
      logHookEvent("listSessions", `schema tables=${signature} count=${sessions.length}`)
    }
    listCache = { sessions, ts: Date.now() }
    return sessions
  } catch (err: any) {
    const ms = Date.now() - startedAt
    logHookEvent(
      "listSessions",
      `ERROR db=${dbPath} ms=${ms} msg=${tailForLog(err?.message, 200)}`,
    )
    return []
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find a single session by exact ID.
 * Returns `null` when not found or on error. Use `findSessionByQuery` for
 * prefix-aware lookups in user-facing tools.
 */
export async function findSessionById(_: unknown, id: string): Promise<SessionInfo | null> {
  try {
    const sessions = await listSessions(null)
    return sessions.find((s) => s.id === id) ?? null
  } catch {
    return null
  }
}

/**
 * Resolve a session ID or short prefix to a single session.
 * Behaviour (git-like):
 *   - Exact full-ID match: returned immediately.
 *   - Prefix length >= 4: matched against session IDs. If exactly one hit,
 *     it is returned. If multiple hits, returns "ambiguous" with all matches.
 *   - Prefix < 4 chars: treated as "too short" — returns "ambiguous" to force
 *     the caller to be more specific (avoids accidental mass operations).
 */
export async function findSessionByQuery(_: unknown, query: string): Promise<FindQueryResult> {
  let sessions: SessionInfo[]
  try {
    sessions = await listSessions(null)
  } catch (err: any) {
    return { kind: "error", message: err?.message ?? "failed to list sessions" }
  }

  if (sessions.length === 0) {
    return { kind: "not_found", query }
  }

  const exact = sessions.find((s) => s.id === query)
  if (exact) return { kind: "found", session: exact }

  if (query.length < 4) {
    return { kind: "ambiguous", query, matches: [] }
  }
  const matches = sessions.filter((s) => s.id.startsWith(query))
  if (matches.length === 0) return { kind: "not_found", query }
  if (matches.length === 1) {
    const only = matches[0]
    if (only) return { kind: "found", session: only }
  }
  return { kind: "ambiguous", query, matches }
}

/** Format an ambiguous-match result as a user-facing multi-line string. */
export function formatAmbiguous(result: { query: string; matches: SessionInfo[] }): string {
  const header = `Ambiguous session ID "${result.query}" — ${result.matches.length} matches:`
  const lines = result.matches.slice(0, 20).map(
    (m) => `  ${m.id}  ${m.title}`,
  )
  const trailer = result.matches.length > 20
    ? `\n  ...and ${result.matches.length - 20} more. Use a longer prefix.`
    : ""
  return [header, ...lines, trailer].join("\n")
}

/**
 * Search sessions by a case-insensitive substring match.
 * Scope controls where the query is matched:
 *   - "title"      — only the session title (default; backwards compatible).
 *   - "title+note" — title, plus the pinned note if any.
 * Returns an empty array on failure.
 */
export async function searchSessions(
  _: unknown,
  query: string,
  scope: "title" | "title+note" = "title",
): Promise<SessionInfo[]> {
  try {
    const sessions = await listSessions(null)
    const lower = query.toLowerCase()
    if (scope === "title") {
      return sessions.filter((s) => s.title.toLowerCase().includes(lower))
    }
    const state = loadStateDefault()
    const noteById = new Map(state.pinned.map((p) => [p.sessionId, p.note ?? ""]))
    return sessions.filter((s) => {
      if (s.title.toLowerCase().includes(lower)) return true
      const note = noteById.get(s.id)
      return note ? note.toLowerCase().includes(lower) : false
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Mutations (each invalidates the session-list cache)
// ---------------------------------------------------------------------------

/**
 * Export a session via `opencode export <id>` (v1) or
 * `opencode session export <id>` (v2, see `cliFlavor`).
 * Returns the raw stdout (native JSON round-trip format).
 * Returns an empty string on failure.
 *
 * The export's stdout is redirected to a temp file, not a pipe (TODO-0012):
 * opencode 1.19.0's `export` truncates its output when stdout is a pipe —
 * the same session gives a complete 7.7 MB JSON to a file, but a
 * nondeterministic 131–438 KB cut with exit 0 through any pipe (bun/node
 * execFile, shell `|` — verified in the TODO-0012 investigation). A
 * regular-file fd is immune; the child writes the full document. The small
 * outputs of import/delete keep the pipe: they never reach the window where
 * the truncation race bites. stderr is discarded (the old execFile call
 * captured it but never used it).
 */
/**
 * Unique temp path for one export capture. The random suffix matters:
 * parallel exports of the SAME session id (concurrent sm_backup calls)
 * would otherwise land on the same pid+ms path and write into one file.
 */
export function exportTempPath(id: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return join(tmpdir(), `sm-export-${process.pid}-${Date.now()}-${rand}-${id}.json`)
}

export async function exportSession(_: unknown, id: string): Promise<string> {
  const flavor = await resolveCliFlavor()
  const tmpFile = exportTempPath(id)
  try {
    const outFd = openSync(tmpFile, "w")
    try {
      await new Promise<void>((resolve, reject) => {
        // stdout -> temp file (pipe truncation, see above); stderr ->
        // discarded (the old execFile call captured it but never used it;
        // "ignore" also keeps the child from blocking on a full stderr pipe).
        const stdio: ["ignore", number, "ignore"] = ["ignore", outFd, "ignore"]
        // The narrowed surface: both bun-types and @types/node declare
        // "child_process", so the merged spawn overloads reduce to `never` —
        // declare exactly the events exportSession listens to.
        const args = flavor === "v2" ? ["session", "export", id] : ["export", id]
        const child = spawn("opencode", args, {
          stdio,
          timeout: CLI_TIMEOUT_MS,
        }) as unknown as {
          on(event: "error", listener: (err: Error) => void): unknown
          on(event: "close", listener: (code: number | null) => void): unknown
        }
        child.on("error", reject)
        child.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`opencode ${args.join(" ")} exited with code ${code}`)),
        )
      })
      return readFileSync(tmpFile, "utf-8")
    } finally {
      try {
        closeSync(outFd)
      } catch { /* best-effort */ }
    }
  } catch {
    return ""
  } finally {
    try {
      unlinkSync(tmpFile)
    } catch { /* best-effort */ }
  }
}

/**
 * Import a session from a JSON file via `opencode import <file>` (v1) or
 * `opencode session import <file>` (v2, see `cliFlavor`).
 * Returns `true` when the command exits successfully.
 * Invalidates the session-list cache (a new session appeared in the DB).
 */
export async function importSession(_: unknown, filePath: string): Promise<boolean> {
  try {
    const flavor = await resolveCliFlavor()
    const args = flavor === "v2" ? ["session", "import", filePath] : ["import", filePath]
    await execFile("opencode", args, {
      maxBuffer: MAX_BUFFER, timeout: CLI_TIMEOUT_MS,
    })
    invalidateSessionCache()
    return true
  } catch {
    return false
  }
}

/**
 * Delete a session via `opencode session delete <id>`.
 * Returns `true` when the command exits successfully.
 * Invalidates the session-list cache (a session disappeared from the DB).
 */
export async function deleteSession(_: unknown, id: string): Promise<boolean> {
  try {
    await execFile("opencode", ["session", "delete", id], {
      maxBuffer: MAX_BUFFER, timeout: CLI_TIMEOUT_MS,
    })
    invalidateSessionCache()
    return true
  } catch {
    return false
  }
}
