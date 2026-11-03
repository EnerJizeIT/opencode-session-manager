import { afterEach, afterAll, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { Database } from "bun:sqlite"

/**
 * Session-list source regression (opencode 2.x):
 * `listSessions` reads `session_v2` when it exists (the source of truth —
 * the 2.x CLI cannot export/delete legacy `session` rows), and falls back to
 * the legacy table only in a 1.x environment. Legacy rows must NOT surface in
 * a v2 DB: they would become phantom sessions that cleanup can never remove.
 *
 * Diagnostics contract: one ERROR line per failed read, one OK line for an
 * empty read, one `schema` line per process/schema change.
 *
 * logHookEvent is mocked so the test never touches the real hooks log. The DB
 * is a throwaway temp file — the user's opencode.db is never opened, no CLI
 * is called.
 */
const captured: string[] = []
const realState = await import("../src/state")
mock.module("../src/state", () => ({
  ...realState,
  logHookEvent: (hook: string, detail = "") => {
    captured.push(`${hook}  ${detail}`)
  },
}))
const { listSessions, invalidateSessionCache, setSessionDbPath } = await import("../src/cli")

const TMP = mkdtempSync("/tmp/opencode/sm-db-")
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
afterEach(() => {
  captured.length = 0
  setSessionDbPath(null)
  invalidateSessionCache()
})

type Row = [
  id: string,
  title: string | null,
  created: number,
  updated: number,
  projectId: string,
  directory: string,
]

/** Create a throwaway DB; a table is created only when its rows are provided. */
function makeDb(path: string, spec: { v1?: Row[]; v2?: Row[]; extra?: string }): void {
  const db = new Database(path)
  const tables = [
    ["session", spec.v1],
    ["session_v2", spec.v2],
  ] as const
  for (const [table, rows] of tables) {
    if (rows === undefined) continue
    db.run(
      `CREATE TABLE ${table} (id TEXT, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)`,
    )
    const ins = db.query(
      `INSERT INTO ${table} (id, title, time_created, time_updated, project_id, directory) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const [id, title, created, updated, projectId, directory] of rows) {
      ins.run(id, title, created, updated, projectId, directory)
    }
  }
  if (spec.extra) db.run(spec.extra)
  db.close()
}

describe("listSessions DB source: session_v2 is the source of truth", () => {
  it("both tables: only session_v2 rows are returned, legacy-only rows are ignored", async () => {
    const dbPath = `${TMP}/both.db`
    makeDb(dbPath, {
      v1: [
        ["ses_legacy_dup", "Stale duplicate", 100, 100, "p1", "/a"],
        ["ses_legacy_only", "Phantom", 50, 50, "p1", "/a"],
      ],
      v2: [
        ["ses_legacy_dup", "Live title", 200, 400, "p2", "/b"],
        ["ses_v2_new", "Fresh", 250, 300, "p2", "/b"],
      ],
    })
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions.map((s) => s.id)).toEqual(["ses_legacy_dup", "ses_v2_new"])
    expect(sessions[0]).toEqual({
      id: "ses_legacy_dup",
      title: "Live title",
      created: 200,
      updated: 400,
      projectId: "p2",
      directory: "/b",
    })
  })

  it("v2-only DB works (normal opencode 2.x install)", async () => {
    const dbPath = `${TMP}/v2only.db`
    makeDb(dbPath, { v2: [["ses_v2", "V2", 1, 1, "global", "/h"]] })
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions.map((s) => s.id)).toEqual(["ses_v2"])
  })

  it("legacy-only DB works (opencode 1.x environment)", async () => {
    const dbPath = `${TMP}/v1only.db`
    makeDb(dbPath, { v1: [["ses_v1", "V1", 1, 1, "global", "/h"]] })
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions.map((s) => s.id)).toEqual(["ses_v1"])
  })

  it("NULL title in session_v2 maps to an empty string", async () => {
    const dbPath = `${TMP}/nulltitle.db`
    makeDb(dbPath, { v2: [["ses_untitled", null, 1, 1, "global", "/h"]] })
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions[0]?.title).toBe("")
  })

  it("no session table at all: [] plus one ERROR naming the available tables", async () => {
    const dbPath = `${TMP}/noschema.db`
    makeDb(dbPath, { extra: "CREATE TABLE unrelated (x TEXT)" })
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions).toEqual([])
    const errors = captured.filter((l) => l.includes("ERROR"))
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("no session table found")
    expect(errors[0]).toContain("unrelated")
  })

  it("missing DB file: [] plus one ERROR fact line", async () => {
    const dbPath = `${TMP}/nope.db`
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions).toEqual([])
    const errors = captured.filter((l) => l.includes("ERROR"))
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain(`db=${dbPath}`)
    expect(errors[0]).toContain("DB not found")
  })

  it("empty session_v2: [] plus one OK line carrying the read table", async () => {
    const dbPath = `${TMP}/empty.db`
    makeDb(dbPath, { v1: [["ses_legacy", "Legacy", 1, 1, "global", "/h"]], v2: [] })
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions).toEqual([])
    const oks = captured.filter((l) => l.includes("OK count=0"))
    expect(oks.length).toBe(1)
    expect(oks[0]).toContain("tables=session_v2")
  })

  it("schema line: once per process/schema change, not on every read", async () => {
    const dbPath = `${TMP}/schema.db`
    makeDb(dbPath, { v2: [["ses_x", "X", 1, 1, "global", "/h"]] })
    setSessionDbPath(dbPath)
    await listSessions(null)
    const schemaLines = () => captured.filter((l) => l.includes("schema tables="))
    expect(schemaLines().length).toBe(1)
    expect(schemaLines()[0]).toContain("tables=session_v2")
    expect(schemaLines()[0]).toContain("count=1")

    invalidateSessionCache()
    await listSessions(null)
    expect(schemaLines().length).toBe(1)
  })
})
