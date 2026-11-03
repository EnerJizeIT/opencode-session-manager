import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { Database } from "bun:sqlite"
import type { SMState } from "../src/state"

/**
 * Backup retention policy (03.11):
 *   - pinned backups are protected forever;
 *   - backups of live sessions expire after `backupRetentionDays`;
 *   - orphaned backups (session deleted — cleanup creates these by design)
 *     expire after `orphanBackupRetentionDays`, or are kept forever when it is 0.
 *
 * The state is mocked (temp backup dir + custom settings), the session list
 * points at a throwaway DB with one live session — the real files are untouched.
 */
const TMP = mkdtempSync("/tmp/opencode/sm-retention-")
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const DAY = 86400000
let testState: SMState
let testDir: string

const realState = await import("../src/state")
mock.module("../src/state", () => ({
  ...realState,
  loadStateDefault: () => testState,
  saveStateDefault: () => true,
  getBackupDir: () => testDir,
  logHookEvent: () => {},
}))

const { runBackupRetention } = await import("../src/backup")
const { setSessionDbPath, invalidateSessionCache } = await import("../src/cli")

beforeEach(() => {
  const dbPath = `${TMP}/db-${Math.random().toString(36).slice(2)}.db`
  const db = new Database(dbPath)
  db.run(
    "CREATE TABLE session_v2 (id TEXT, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)",
  )
  db.query(
    "INSERT INTO session_v2 (id, title, time_created, time_updated) VALUES (?, ?, ?, ?)",
  ).run("ses_alive", "Alive", Date.now(), Date.now())
  db.close()
  setSessionDbPath(dbPath)
  invalidateSessionCache()
  testDir = mkdtempSync(`${TMP}/backups-`)
})

afterEach(() => {
  setSessionDbPath(null)
  invalidateSessionCache()
})

function writeBackup(id: string, ageDays: number): string {
  const path = `${testDir}/${id}.json`
  writeFileSync(
    path,
    JSON.stringify({
      version: "1.0.0",
      exportedAt: Date.now() - ageDays * DAY,
      backupOf: id,
      session: {},
    }),
  )
  return path
}

function makeState(orphanDays: number): SMState {
  return {
    ...realState.DEFAULT_STATE,
    settings: {
      ...realState.DEFAULT_STATE.settings,
      backupRetentionEnabled: true,
      backupRetentionDays: 30,
      orphanBackupRetentionDays: orphanDays,
    },
    pinned: [{ sessionId: "ses_pinned", title: "Pinned", pinnedAt: 1, note: "" }],
  }
}

describe("runBackupRetention: orphan policy (03.11)", () => {
  it("expires old orphans and old live backups, keeps pinned and recent ones", async () => {
    testState = makeState(14)
    const orphanOld = writeBackup("ses_orphan_old", 20) // > 14d → removed
    const orphanNew = writeBackup("ses_orphan_new", 5) // < 14d → kept
    const pinnedOld = writeBackup("ses_pinned", 60) // pinned → always kept
    const aliveOld = writeBackup("ses_alive", 40) // live > 30d → removed
    const aliveNew = writeBackup("ses_alive_new", 10) // recent → kept

    const report = await runBackupRetention(null, false)

    expect(report.removed.sort()).toEqual(["ses_alive.json", "ses_orphan_old.json"])
    expect(report.protected).toContain("ses_pinned.json")
    expect(report.skippedRecent.sort()).toEqual(["ses_alive_new.json", "ses_orphan_new.json"])
    expect(existsSync(orphanOld)).toBe(false)
    expect(existsSync(aliveOld)).toBe(false)
    expect(existsSync(orphanNew)).toBe(true)
    expect(existsSync(pinnedOld)).toBe(true)
    expect(existsSync(aliveNew)).toBe(true)
  })

  it("orphanBackupRetentionDays=0 keeps orphans forever", async () => {
    testState = makeState(0)
    const orphanOld = writeBackup("ses_orphan_forever", 100)

    const report = await runBackupRetention(null, false)

    expect(report.removed).toEqual([])
    expect(report.protected).toContain("ses_orphan_forever.json")
    expect(existsSync(orphanOld)).toBe(true)
  })

  it("dryRun reports removals without deleting files", async () => {
    testState = makeState(14)
    const orphanOld = writeBackup("ses_orphan_dry", 20)

    const report = await runBackupRetention(null, true)

    expect(report.removed).toContain("ses_orphan_dry.json")
    expect(existsSync(orphanOld)).toBe(true)
  })
})
