import { describe, expect, it, beforeAll } from "bun:test"
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmdirSync } from "fs"
import { join } from "path"
import { loadState, saveState, DEFAULT_STATE, migrateState, type SMState } from "../src/state"

let tmpDir: string
let tmpFile: string

beforeAll(() => {
  tmpDir = join(import.meta.dir, "..", ".tmp-test-" + Date.now())
  mkdirSync(tmpDir, { recursive: true })
  tmpFile = join(tmpDir, "state.json")
})

describe("saveState / loadState — round-trip & robustness", () => {
  it("save → load returns equivalent state (round-trip)", () => {
    const state: SMState = {
      version: "1.0.0",
      settings: {
        autoCleanupEnabled: true,
        autoCleanupDays: 7,
        backupRetentionEnabled: false,
        backupRetentionDays: 30,
        backupDir: "/test/dir",
      },
      pinned: [
        { sessionId: "abc", title: "Test Session", pinnedAt: 1234567890, note: "test" },
      ],
      lastAutoRun: null,
    }
    const ok = saveState(state, tmpFile)
    expect(ok).toBe(true)

    const loaded = loadState(tmpFile)
    expect(loaded.version).toBe(state.version)
    expect(loaded.settings.autoCleanupEnabled).toBe(true)
    expect(loaded.settings.autoCleanupDays).toBe(7)
    expect(loaded.settings.backupDir).toBe("/test/dir")
    expect(loaded.pinned).toHaveLength(1)
    expect(loaded.pinned[0].sessionId).toBe("abc")
  })

  it("atomic save leaves no .tmp file after success", () => {
    const state: SMState = {
      ...DEFAULT_STATE,
      version: "1.0.0",
      settings: { ...DEFAULT_STATE.settings },
      pinned: [],
    }
    saveState(state, tmpFile)
    const tmpPath = tmpFile + ".tmp"
    expect(existsSync(tmpPath)).toBe(false)
  })

  it("loadState on missing file returns DEFAULT_STATE", () => {
    const missing = join(tmpDir, "nonexistent.json")
    const result = loadState(missing)
    expect(result).toEqual(DEFAULT_STATE)
  })

  it("loadState on corrupted file returns DEFAULT_STATE", () => {
    const corruptFile = join(tmpDir, "corrupt.json")
    writeFileSync(corruptFile, "this is not valid json {{{", "utf-8")
    const result = loadState(corruptFile)
    expect(result).toEqual(DEFAULT_STATE)
  })

  it("loadState on empty file returns DEFAULT_STATE", () => {
    const emptyFile = join(tmpDir, "empty.json")
    writeFileSync(emptyFile, "", "utf-8")
    const result = loadState(emptyFile)
    expect(result).toEqual(DEFAULT_STATE)
  })

  it("loadState migrates old state with missing fields", () => {
    const oldStateFile = join(tmpDir, "old-state.json")
    const oldState = { version: "1.0.0", pinned: [] }
    writeFileSync(oldStateFile, JSON.stringify(oldState), "utf-8")
    const result = loadState(oldStateFile)
    expect(result.version).toBe("1.0.0")
    expect(result.settings).toEqual(DEFAULT_STATE.settings)
    expect(result.pinned).toEqual([])
  })
})
