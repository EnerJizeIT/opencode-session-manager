/**
 * Wrappers around the `opencode` CLI for session discovery and manipulation.
 *
 * Each wrapper takes the plugin's Bun shell context (`$`) and returns a
 * normalised type. Errors are swallowed and surfaced as empty results —
 * callers can distinguish "no sessions" from "CLI broken" via `findSessionByQuery`
 * which returns a typed error result.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { readFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { parseJson, loadStateDefault } from "./state"
import type { SessionInfo, FindQueryResult } from "./types"

/** Bun shell context bound to the plugin runtime. */
type Shell = PluginInput["$"]

/**
 * List all sessions via `opencode session list --format json`.
 * Returns an empty array on failure.
 */
export async function listSessions($: Shell): Promise<SessionInfo[]> {
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
 * Find a single session by exact ID.
 * Returns `null` when not found or on error. Use `findSessionByQuery` for
 * prefix-aware lookups in user-facing tools.
 */
export async function findSessionById($: Shell, id: string): Promise<SessionInfo | null> {
  try {
    const sessions = await listSessions($)
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
export async function findSessionByQuery($: Shell, query: string): Promise<FindQueryResult> {
  let sessions: SessionInfo[]
  try {
    sessions = await listSessions($)
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
  $: Shell,
  query: string,
  scope: "title" | "title+note" = "title",
): Promise<SessionInfo[]> {
  try {
    const sessions = await listSessions($)
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

/**
 * Export a session via `opencode export <id>`.
 * Returns the raw stdout (native JSON round-trip format).
 * Returns an empty string on failure.
 *
 * Implementation note: streamed to a temp file instead of capturing stdout
 * into a string — Bun's pipe capture truncates at ~200 KB, which corrupts
 * large sessions (multi-MB) -> "Unterminated string" in parseJson.
 * Shell redirection (`>`) writes the full output to disk.
 */
export async function exportSession($: Shell, id: string): Promise<string> {
  const tmp = `${tmpdir()}/sm-export-${id}-${Date.now()}.json`
  try {
    await $`opencode export ${id} > ${tmp}`
    return readFileSync(tmp, "utf-8")
  } catch {
    return ""
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

/**
 * Import a session from a JSON file via `opencode import <file>`.
 * Returns `true` when the command exits successfully.
 */
export async function importSession($: Shell, filePath: string): Promise<boolean> {
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
export async function deleteSession($: Shell, id: string): Promise<boolean> {
  try {
    await $`opencode session delete ${id}`
    return true
  } catch {
    return false
  }
}
