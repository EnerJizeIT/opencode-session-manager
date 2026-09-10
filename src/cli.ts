/**
 * Wrappers around the `opencode` CLI for session discovery and manipulation.
 *
 * Each wrapper returns a normalised type. Errors are swallowed and surfaced
 * as empty results — callers can distinguish "no sessions" from "CLI broken"
 * via `findSessionByQuery`, which returns a typed error result.
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
 * Performance: `opencode session list` costs ~2 s on a large DB.
 * `listSessions` caches the result for 5 s; delete/import invalidate it.
 */

import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import { parseJson, loadStateDefault } from "./state"
import type { SessionInfo, FindQueryResult } from "./types"

const execFile = promisify(execFileCb)

/** Session exports can be multi-MB; 64 MB leaves generous headroom. */
const MAX_BUFFER = 64 * 1024 * 1024

/** Kill a hanging CLI call after 2 minutes (network/hung TUI safety). */
const CLI_TIMEOUT_MS = 120_000

/** Bun shell context — kept in call-sites for API stability; unused here. */

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
 * List all sessions via `opencode session list --format json`.
 * Cached for 5 seconds — repeated calls within the TTL return instantly.
 * Returns an empty array on failure.
 *
 * `-n 100000`: the CLI defaults to the 100 most recent sessions, which made
 * the plugin blind to older (often pinned) sessions and mislabel them as
 * deleted. A large limit asks for everything the CLI can see.
 */
export async function listSessions(_$: unknown): Promise<SessionInfo[]> {
  if (listCache && Date.now() - listCache.ts < LIST_CACHE_TTL_MS) {
    return listCache.sessions
  }
  try {
    const { stdout } = await execFile(
      "opencode",
      ["session", "list", "--format", "json", "-n", "100000"],
      { maxBuffer: MAX_BUFFER, timeout: CLI_TIMEOUT_MS },
    )
    const parsed = parseJson(stdout) as SessionInfo[]
    const sessions = Array.isArray(parsed) ? parsed : []
    listCache = { sessions, ts: Date.now() }
    return sessions
  } catch (err: any) {
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
 * execFile captures stdout fully (no pipe truncation, maxBuffer 64 MB) and
 * never inherits the CLI's stderr progress line ("Exporting session: …").
 */
export async function exportSession(_: unknown, id: string): Promise<string> {
  try {
    const { stdout } = await execFile("opencode", ["export", id], {
      maxBuffer: MAX_BUFFER,
      timeout: CLI_TIMEOUT_MS,
    })
    return stdout
  } catch {
    return ""
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
