import { afterEach, afterAll, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { Database } from "bun:sqlite"

/**
 * TODO-0012 regression: listSessions reads the opencode DB directly
 * (bun:sqlite, readonly) — the project-scoped CLI source is gone. The
 * diagnostics contract survives the switch: one ERROR fact line per failed
 * read, one OK line for an empty table, and the return contract is
 * unchanged (failure -> [], success -> mapped sessions).
 *
 * logHookEvent is mocked so the test never touches the user's real
 * session-manager-hooks.log (bun's os.homedir() ignores $HOME, so env
 * redirection is not an option). The DB is a throwaway temp file created
 * with the same `session` table shape — the user's opencode.db is never
 * opened, no CLI is called.
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

/** Create a throwaway DB with the `session` table shape (6 display columns). */
function makeDb(
  path: string,
  rows: Array<[string, string, number, number, string, string]>,
): void {
  const db = new Database(path)
  db.run(
    "CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)",
  )
  const ins = db.query(
    "INSERT INTO session (id, title, time_created, time_updated, project_id, directory) VALUES (?, ?, ?, ?, ?, ?)",
  )
  for (const [id, title, created, updated, projectId, directory] of rows) {
    ins.run(id, title, created, updated, projectId, directory)
  }
  db.close()
}

describe("listSessions DB source (TODO-0012)", () => {
  it("maps DB rows to SessionInfo, newest first, all six fields", async () => {
    const dbPath = `${TMP}/map.db`
    makeDb(dbPath, [
      ["ses_old", "Old", 100, 100, "p1", "/a"],
      ["ses_new", "New", 200, 300, "p2", "/b"],
    ])
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions.map((s) => s.id)).toEqual(["ses_new", "ses_old"])
    expect(sessions[0]).toEqual({
      id: "ses_new",
      title: "New",
      created: 200,
      updated: 300,
      projectId: "p2",
      directory: "/b",
    })
  })

  it("missing DB: returns [] and logs exactly one ERROR fact line", async () => {
    const dbPath = `${TMP}/nope.db`
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions).toEqual([])
    const errors = captured.filter((l) => l.includes("ERROR"))
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain(`db=${dbPath}`)
    expect(errors[0]).toContain("DB not found")
    expect(errors[0]).toContain("ms=")
  })

  it("empty table: returns [] and logs exactly one OK fact line", async () => {
    const dbPath = `${TMP}/empty.db`
    makeDb(dbPath, [])
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions).toEqual([])
    const oks = captured.filter((l) => l.includes("OK count=0"))
    expect(oks.length).toBe(1)
    expect(oks[0]).toContain(`db=${dbPath}`)
  })

  it("non-empty read: logs nothing (no stderr to report anymore)", async () => {
    const dbPath = `${TMP}/two.db`
    makeDb(dbPath, [
      ["ses_x", "X", 1, 1, "global", "/h"],
      ["ses_y", "Y", 2, 2, "global", "/h"],
    ])
    setSessionDbPath(dbPath)
    const sessions = await listSessions(null)
    expect(sessions.length).toBe(2)
    expect(captured).toEqual([])
  })
})
