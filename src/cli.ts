/**
 * Session discovery + CLI wrappers for export/import/delete.
 *
 * Each wrapper returns a normalised type. Errors are swallowed and surfaced
 * as empty results — callers can distinguish "no sessions" from "DB broken"
 * via `findSessionByQuery`, which returns a typed error result.
 *
 * Session listing (TODO-0012): `listSessions` reads the opencode database
 * directly (`bun:sqlite`, readonly) instead of `opencode session list`.
 * The CLI scopes its list to the current project directory — from a
 * project the plugin went blind to every other project's sessions (pinned
 * ones included) and mislabelled them [DELETED]. A readonly select of six
 * columns is project-independent, takes milliseconds, and has no
 * subprocess that can die inside a live opencode.
 *
 * Export / import / delete still go through the CLI: `opencode export <id>`
 * works for any session regardless of cwd (verified in the TODO-0012
 * investigation), so the backup/restore path stays untouched.
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
export function setSessionDbPath(path: string | null): void {
  dbPathOverride = path
}

/**
 * Read every session from the `session` table — six display columns only
 * (never message/part, the DB is multi-GB). Opens the DB readonly and
 * always closes it. Throws on any failure; the caller decides what to do.
 */
export function readAllSessions(dbPath: string): SessionInfo[] {
  if (!existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`)
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db
      .query(
        "SELECT id, title, time_created, time_updated, project_id, directory FROM session ORDER BY time_updated DESC",
      )
      .all() as Array<{
      id: string
      title: string | null
      time_created: number | null
      time_updated: number | null
      project_id: string | null
      directory: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? "",
      created: Number(r.time_created) || 0,
      updated: Number(r.time_updated) || 0,
      projectId: r.project_id ?? "",
      directory: r.directory ?? "",
    }))
  } finally {
    db.close()
  }
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
 * The source is a readonly `bun:sqlite` select, not the CLI:
 * `opencode session list` scopes results to the current project directory,
 * which made the plugin blind to sessions from other projects (pinned ones
 * included) and mislabel them as deleted.
 */
export async function listSessions(_$: unknown): Promise<SessionInfo[]> {
  if (listCache && Date.now() - listCache.ts < LIST_CACHE_TTL_MS) {
    return listCache.sessions
  }
  const dbPath = dbPathOverride ?? OPENCODE_DB
  const startedAt = Date.now()
  try {
    const sessions = readAllSessions(dbPath)
    const ms = Date.now() - startedAt
    if (sessions.length === 0) {
      logHookEvent("listSessions", `OK count=0 ms=${ms} db=${dbPath}`)
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
 * Export a session via `opencode export <id>`.
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
        const child = spawn("opencode", ["export", id], {
          stdio,
          timeout: CLI_TIMEOUT_MS,
        }) as unknown as {
          on(event: "error", listener: (err: Error) => void): unknown
          on(event: "close", listener: (code: number | null) => void): unknown
        }
        child.on("error", reject)
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`opencode export exited with code ${code}`)),
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
 * Import a session from a JSON file via `opencode import <file>`.
 * Returns `true` when the command exits successfully.
 * Invalidates the session-list cache (a new session appeared in the DB).
 */
export async function importSession(_: unknown, filePath: string): Promise<boolean> {
  try {
    await execFile("opencode", ["import", filePath], {
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
