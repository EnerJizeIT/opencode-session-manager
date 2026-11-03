/**
 * Diagnostic harness for the "empty DB" bug (TODO-0011).
 *
 * Run from inside a LIVE opencode process (a worker session is the target
 * context — the DB is open by the parent, exactly where the plugin breaks):
 *
 *   bun scripts/diag-cli.ts          # from the repo root
 *
 * What it prints:
 *   1. RAW    — the same `execFile("opencode", ["session","list",...])` call
 *               the plugin no longer makes, with a hard 30 s cap: code,
 *               signal, killed, duration, stdout size + tail, stderr tail.
 *   2. PLUGIN — `listSessions()` from src/cli.ts (errors are swallowed there,
 *               so expect a count; the error facts land in
 *               ~/.local/share/opencode/session-manager-hooks.log).
 *   3. SCHEMA — which session tables the DB has and the row count per table
 *               (`session_v2` on opencode 2.x + legacy `session`).
 *
 * Each subprocess is capped at 30 s (kill) — the harness never hangs.
 * No secrets are printed (env values are never read).
 */

import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import {
  listSessions, invalidateSessionCache, readAllSessionsDetailed, OPENCODE_DB,
} from "../src/cli"
import { parseJson } from "../src/state"

const execFile = promisify(execFileCb)

/** Hard cap for every subprocess in the harness. */
const CAP_MS = 30_000
const MAX_BUFFER = 64 * 1024 * 1024
const TAIL = 1000

const tail = (value: unknown, n = TAIL): string => {
  if (value === undefined || value === null) return ""
  const str = Buffer.isBuffer(value) ? value.toString("utf-8") : String(value)
  const flat = str.replace(/\s+/g, " ").trim()
  return flat.length > n ? "…<cut>" + flat.slice(-n) : flat
}

/** Race a promise against a cap; never rejects, never keeps the process alive. */
function withCap<T>(p: Promise<T>, ms: number): Promise<{ value: T | null; capped: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ value: null, capped: true }), ms)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve({ value, capped: false })
      },
      () => {
        clearTimeout(timer)
        resolve({ value: null, capped: false })
      },
    )
  })
}

const t0 = Date.now()

// 1. Raw execFile — exactly the plugin's call, 30 s cap.
const rawT0 = Date.now()
let raw: Record<string, unknown>
try {
  const r = await execFile("opencode", ["session", "list", "--format", "json", "-n", "100000"], {
    maxBuffer: MAX_BUFFER,
    timeout: CAP_MS,
  })
  let rawCount: number | null = null
  try {
    rawCount = (parseJson(r.stdout) as unknown[]).length
  } catch { /* unparseable — count stays null */ }
  raw = {
    ok: true,
    code: 0,
    signal: null,
    killed: false,
    ms: Date.now() - rawT0,
    count: rawCount,
    stdoutLen: r.stdout.length,
    stdoutTail: tail(r.stdout),
    stderr: tail(r.stderr),
  }
} catch (e: any) {
  raw = {
    ok: false,
    code: e?.code ?? "n/a",
    signal: e?.signal ?? "n/a",
    killed: e?.killed ?? false,
    ms: Date.now() - rawT0,
    stdoutLen: e?.stdout?.length ?? 0,
    stdoutTail: tail(e?.stdout),
    stderr: tail(e?.stderr),
    message: tail(e?.message, 300),
  }
}
console.log("RAW " + JSON.stringify(raw))

// 2. Plugin path — listSessions (errors swallowed -> count, facts in hooks log).
invalidateSessionCache()
const pluginT0 = Date.now()
const plugin = await withCap(listSessions(null), CAP_MS)
const count = plugin.capped ? null : plugin.value?.length ?? -1
console.log(
  "PLUGIN " +
    JSON.stringify({
      count,
      ms: Date.now() - pluginT0,
      capped: plugin.capped,
    }),
)

// 3. Schema breakdown — a renamed/dropped table must be visible here.
let schema: Record<string, unknown>
try {
  const detail = readAllSessionsDetailed(OPENCODE_DB)
  schema = { tables: detail.tables, perTable: detail.perTable, merged: detail.sessions.length }
} catch (e: any) {
  schema = { error: tail(e?.message, 200) }
}
console.log("SCHEMA " + JSON.stringify(schema))

console.log("HARNESS " + JSON.stringify({ ms: Date.now() - t0, cwd: process.cwd() }))
