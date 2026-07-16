import { describe, expect, it } from "bun:test"
import { migrateState, DEFAULT_STATE, type SMState } from "../src/state"

describe("migrateState", () => {
  it("returns DEFAULT_STATE for null input", () => {
    const result = migrateState(null)
    expect(result).toEqual(DEFAULT_STATE)
  })

  it("returns DEFAULT_STATE for non-object input", () => {
    expect(migrateState("string")).toEqual(DEFAULT_STATE)
    expect(migrateState(42)).toEqual(DEFAULT_STATE)
    expect(migrateState([])).toEqual(DEFAULT_STATE)
  })

  it("returns DEFAULT_STATE for object without version", () => {
    const result = migrateState({ settings: {} })
    expect(result).toEqual(DEFAULT_STATE)
  })

  it("returns DEFAULT_STATE when version is not a string", () => {
    const result = migrateState({ version: 123 })
    expect(result).toEqual(DEFAULT_STATE)
  })

  it("returns valid state as-is when all fields present", () => {
    const input: SMState = {
      version: "1.0.0",
      settings: {
        autoCleanupEnabled: true,
        autoCleanupDays: 10,
        backupRetentionEnabled: true,
        backupRetentionDays: 15,
        backupDir: "/custom/path",
      },
      pinned: [{ sessionId: "s1", title: "T", pinnedAt: 100, note: "n" }],
      lastAutoRun: 200,
    }
    const result = migrateState(input)
    expect(result.version).toBe("1.0.0")
    expect(result.settings.autoCleanupEnabled).toBe(true)
    expect(result.settings.autoCleanupDays).toBe(10)
    expect(result.settings.backupDir).toBe("/custom/path")
    expect(result.pinned).toHaveLength(1)
    expect(result.pinned[0].sessionId).toBe("s1")
    expect(result.lastAutoRun).toBe(200)
  })

  it("fills missing settings fields from DEFAULT_STATE (forward-compat merge)", () => {
    const input = {
      version: "1.0.0",
      settings: {
        autoCleanupEnabled: true,
      },
      pinned: [],
    }
    const result = migrateState(input)
    expect(result.settings.autoCleanupEnabled).toBe(true)
    expect(result.settings.autoCleanupDays).toBe(DEFAULT_STATE.settings.autoCleanupDays)
    expect(result.settings.backupRetentionEnabled).toBe(DEFAULT_STATE.settings.backupRetentionEnabled)
    expect(result.settings.backupRetentionDays).toBe(DEFAULT_STATE.settings.backupRetentionDays)
    expect(result.settings.backupDir).toBe(DEFAULT_STATE.settings.backupDir)
  })

  it("replaces non-array pinned with default empty array", () => {
    const input = {
      version: "1.0.0",
      settings: {},
      pinned: "not-an-array",
    }
    const result = migrateState(input)
    expect(result.pinned).toEqual([])
  })

  it("replaces non-object settings with default settings", () => {
    const input = {
      version: "1.0.0",
      settings: "invalid",
      pinned: [],
    }
    const result = migrateState(input)
    expect(result.settings).toEqual(DEFAULT_STATE.settings)
  })
})
