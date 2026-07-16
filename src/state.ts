import { readFileSync, writeFileSync, existsSync, renameSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Plugin state shape. */
export interface SMState {
  version: string
  settings: {
    autoCleanupEnabled: boolean
    autoCleanupDays: number
    backupRetentionEnabled: boolean
    backupRetentionDays: number
    backupDir: string
  }
  pinned: Array<{ sessionId: string; title: string; pinnedAt: number; note: string }>
  lastAutoRun?: number | null
}

const DEFAULT_BACKUP_DIR = join(homedir(), ".local", "share", "opencode", "backups")

/** Default state returned when the file is missing or corrupted. */
export const DEFAULT_STATE: SMState = {
  version: "1.0.0",
  settings: {
    autoCleanupEnabled: false,
    autoCleanupDays: 30,
    backupRetentionEnabled: false,
    backupRetentionDays: 30,
    backupDir: DEFAULT_BACKUP_DIR,
  },
  pinned: [],
  lastAutoRun: null,
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Migrate raw state to the current SMState schema.
 * Pure function: one input (`unknown`), one output (`SMState`), no side effects.
 * Returns `DEFAULT_STATE` when `raw` is not a valid state object.
 */
export function migrateState(raw: unknown): SMState {
  if (
    raw === null ||
    typeof raw !== "object" ||
    !("version" in raw) ||
    typeof (raw as Record<string, unknown>).version !== "string"
  ) {
    return { ...DEFAULT_STATE }
  }

  const versioned = raw as Record<string, unknown>
  const currentVersion = versioned.version as string

  const migratedVersion = currentVersion

  const merged = {
    ...DEFAULT_STATE,
    ...versioned,
    settings: {
      ...DEFAULT_STATE.settings,
      ...(typeof versioned.settings === "object" && versioned.settings !== null
        ? versioned.settings
        : {}),
    },
    version: migratedVersion,
    pinned: Array.isArray(versioned.pinned) ? versioned.pinned : DEFAULT_STATE.pinned,
  } as SMState

  return merged
}

/**
 * Parse JSON from opencode CLI stdout, stripping any prefix noise
 * (e.g. `[page-assist] CLI mode …` lines).
 */
export function parseJson(stdout: string): unknown {
  const m = stdout.match(/(?:\[\s*\{|\{)/)
  if (!m || m.index === undefined) {
    throw new Error("no JSON found in output")
  }
  return JSON.parse(stdout.slice(m.index))
}

// ---------------------------------------------------------------------------
// State I/O (accepts optional path for testability)
// ---------------------------------------------------------------------------

/**
 * Load plugin state from a JSON file.
 * Returns `DEFAULT_STATE` when the file is missing or contains invalid JSON.
 */
export function loadState(filePath: string): SMState {
  try {
    if (!existsSync(filePath)) {
      return { ...DEFAULT_STATE }
    }
    const raw = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    return migrateState(parsed)
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/**
 * Save plugin state atomically: write to a `.tmp` file, then rename.
 * Returns `true` on success, `false` on failure.
 */
export function saveState(state: SMState, filePath: string): boolean {
  try {
    const tmpPath = filePath + ".tmp"
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8")
    renameSync(tmpPath, filePath)
    return true
  } catch {
    return false
  }
}
