import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, appendFileSync } from "fs"
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

// ---------------------------------------------------------------------------
// Paths (single source of truth)
// ---------------------------------------------------------------------------

/** Path to the plugin state file. */
export const STATE_FILE = join(homedir(), ".local", "share", "opencode", "session-manager.json")

/** Default directory for session backups. */
export const DEFAULT_BACKUP_DIR = join(homedir(), ".local", "share", "opencode", "backups")

/** Path to a diagnostic log file for hook invocation. */
export const HOOKS_LOG_FILE = join(homedir(), ".local", "share", "opencode", "session-manager-hooks.log")

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

// ---------------------------------------------------------------------------
// Default-path wrappers (used by the plugin runtime + helpers)
// ---------------------------------------------------------------------------

/** Load state from the default STATE_FILE path. */
export function loadStateDefault(): SMState { return loadState(STATE_FILE) }

/** Save state to the default STATE_FILE path. */
export function saveStateDefault(state: SMState): boolean { return saveState(state, STATE_FILE) }

/**
 * Resolve the active backup directory: user-configured `settings.backupDir`
 * if set and non-empty, otherwise `DEFAULT_BACKUP_DIR`. All backup/retention
 * operations MUST go through this helper so the `backupDir` setting actually
 * takes effect (previously hardcoded to DEFAULT_BACKUP_DIR — bug C2).
 */
export function getBackupDir(): string {
  const dir = loadStateDefault().settings.backupDir
  return dir && dir.trim() ? dir : DEFAULT_BACKUP_DIR
}

/**
 * Append a single diagnostic line to HOOKS_LOG_FILE (best-effort).
 * Used to verify whether opencode actually invokes session.idle /
 * session.deleted hooks (see Q1 in the audit).
 */
export function logHookEvent(hook: string, detail = ""): void {
  const line = `${new Date().toISOString()}  ${hook}${detail ? "  " + detail : ""}\n`
  try {
    mkdirSync(join(homedir(), ".local", "share", "opencode"), { recursive: true })
    appendFileSync(HOOKS_LOG_FILE, line, "utf-8")
  } catch { /* best-effort */ }
}
