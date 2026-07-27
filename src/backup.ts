/**
 * Backup, cleanup and retention helpers.
 *
 * All paths go through `getBackupDir()` so the `backupDir` setting is honoured
 * everywhere (previously hardcoded — bug C2). Cleanup/retention support a
 * `dryRun` flag so the manual tools can default to safe preview behaviour.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync,
  unlinkSync, copyFileSync, statSync,
} from "fs"
import { join, sep } from "path"
import { homedir, tmpdir } from "os"
import {
  parseJson, loadStateDefault, saveStateDefault, getBackupDir,
  STATE_FILE, DEFAULT_BACKUP_DIR,
} from "./state"
import type {
  BackupEnvelope, CleanupReport, RetentionReport, BackupEntry, SessionInfo,
} from "./types"
import { findSessionById, listSessions, exportSession, importSession, deleteSession } from "./cli"

/** Bun shell context bound to the plugin runtime. */
type Shell = PluginInput["$"]

/** Path to the local-dev plugin source (used by full_backup). */
const LOCAL_PLUGIN_PATH = join(homedir(), ".config", "opencode", "plugins", "session-manager.ts")

/**
 * Back up a single session to a JSON file in the given directory.
 * When `targetDir` is omitted, the active backup directory from state
 * (`settings.backupDir` or `DEFAULT_BACKUP_DIR`) is used.
 * Returns `{ ok, path, error }` result object.
 */
export async function backupOne(
  $: Shell,
  sessionId: string,
  targetDir?: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const resolvedDir = targetDir ?? getBackupDir()
  try {
    const session = await findSessionById($, sessionId)
    if (!session) {
      return { ok: false, error: `Session not found: ${sessionId}` }
    }

    const exportedRaw = await exportSession($, sessionId)
    if (!exportedRaw.trim()) {
      return { ok: false, error: `Backup failed: could not export ${sessionId}` }
    }

    const sessionData = parseJson(exportedRaw)
    const envelope: BackupEnvelope = {
      version: "1.0.0",
      exportedAt: Date.now(),
      backupOf: sessionId,
      session: sessionData,
    }

    mkdirSync(resolvedDir, { recursive: true })
    const filePath = join(resolvedDir, `${sessionId}.json`)
    const tmpPath = filePath + ".tmp"
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), "utf-8")
    renameSync(tmpPath, filePath)

    return { ok: true, path: filePath }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Unknown error during backup" }
  }
}

/**
 * Run cleanup: backup-then-delete for stale, non-pinned sessions.
 * @param $      Bun shell context
 * @param force  ignore autoCleanupEnabled setting (used by manual tool)
 * @param dryRun if true, no writes/deletes — only report what would happen
 */
export async function runCleanup(
  $: Shell,
  force = false,
  dryRun = false,
): Promise<CleanupReport> {
  const state = loadStateDefault()
  if (!force && !state.settings.autoCleanupEnabled) {
    return { deleted: [], skippedPinned: [], failed: [] }
  }

  const cutoff = Date.now() - state.settings.autoCleanupDays * 86400000
  const sessions = await listSessions($)
  const pinnedIds = new Set(state.pinned.map((p) => p.sessionId))

  const deleted: string[] = []
  const skippedPinned: string[] = []
  const failed: string[] = []

  for (const s of sessions) {
    if (pinnedIds.has(s.id)) {
      skippedPinned.push(s.id)
      continue
    }
    if (s.updated >= cutoff) {
      continue
    }

    if (dryRun) {
      deleted.push(s.id)
      continue
    }

    const backupResult = await backupOne($, s.id)
    if (!backupResult.ok) {
      failed.push(s.id)
      continue
    }

    const deletedOk = await deleteSession($, s.id)
    if (!deletedOk) {
      failed.push(s.id)
      continue
    }

    deleted.push(s.id)
  }

  return { deleted, skippedPinned, failed }
}

/**
 * Run backup retention: remove stale backups while protecting pinned and orphaned ones.
 * @param $      Bun shell context
 * @param dryRun if true, do not delete or rename anything — only report
 */
export async function runBackupRetention(
  $: Shell,
  dryRun = false,
): Promise<RetentionReport> {
  const state = loadStateDefault()
  if (!state.settings.backupRetentionEnabled) {
    return { removed: [], protected: [], skippedRecent: [], corrupt: [] }
  }

  const cutoff = Date.now() - state.settings.backupRetentionDays * 86400000
  const sessions = await listSessions($)
  const aliveIds = new Set(sessions.map((s) => s.id))
  const pinnedIds = new Set(state.pinned.map((p) => p.sessionId))
  const backupDir = getBackupDir()

  const removed: string[] = []
  const protectedList: string[] = []
  const skippedRecent: string[] = []
  const corrupt: string[] = []

  try {
    const files = readdirSync(backupDir)
    const backupFiles = files.filter((f) => f.endsWith(".json"))

    for (const file of backupFiles) {
      const filePath = join(backupDir, file)
      let envelope: BackupEnvelope | null = null

      try {
        const raw = readFileSync(filePath, "utf-8")
        envelope = JSON.parse(raw) as BackupEnvelope
      } catch {
        if (!dryRun) {
          try { renameSync(filePath, filePath + ".corrupt") } catch { /* best effort */ }
        }
        corrupt.push(file)
        continue
      }

      if (!envelope || typeof envelope.backupOf !== "string" || typeof envelope.exportedAt !== "number") {
        if (!dryRun) {
          try { renameSync(filePath, filePath + ".corrupt") } catch { /* best effort */ }
        }
        corrupt.push(file)
        continue
      }

      if (pinnedIds.has(envelope.backupOf)) {
        protectedList.push(file)
        continue
      }

      if (!aliveIds.has(envelope.backupOf)) {
        protectedList.push(file)
        continue
      }

      if (envelope.exportedAt < cutoff) {
        if (!dryRun) {
          try {
            unlinkSync(filePath)
            removed.push(file)
          } catch { /* best effort */ }
        } else {
          removed.push(file)
        }
        continue
      }

      skippedRecent.push(file)
    }
  } catch {
    // If backup dir doesn't exist, nothing to clean
  }

  return { removed, protected: protectedList, skippedRecent, corrupt }
}

/** Check if any backup files exist in the active backup directory. */
export function hasBackupFiles(): boolean {
  try {
    const files = readdirSync(getBackupDir())
    return files.some((f) => f.endsWith(".json"))
  } catch {
    return false
  }
}

/**
 * Enumerate backup files in the active backup directory with parsed metadata.
 * Newest first. Unreadable files are listed with `corrupt: true` so the user
 * can see them and decide what to do.
 */
export function listBackups(): BackupEntry[] {
  const dir = getBackupDir()
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  const out: BackupEntry[] = []
  for (const f of files) {
    const filePath = join(dir, f)
    let size = 0
    try { size = statSync(filePath).size } catch { /* keep 0 */ }
    try {
      const raw = readFileSync(filePath, "utf-8")
      const envelope = JSON.parse(raw) as BackupEnvelope
      out.push({
        filename: f,
        filePath,
        sessionId: typeof envelope.backupOf === "string" ? envelope.backupOf : "?",
        title: (envelope.session as any)?.info?.title ?? "(unknown)",
        date: typeof envelope.exportedAt === "number" ? envelope.exportedAt : 0,
        size,
        corrupt: false,
      })
    } catch {
      out.push({ filename: f, filePath, sessionId: "?", title: "(unreadable)", date: 0, size, corrupt: true })
    }
  }
  return out.sort((a, b) => b.date - a.date)
}

/**
 * Restore a session from a backup file into the active opencode DB.
 *
 * Safe-delete protocol (bug C3): if `force=true` and the session already
 * exists, we back up the existing session to a safety file BEFORE deleting.
 * If the subsequent import fails, the user still has a recovery file.
 *
 * Returns `{ ok, message }`. `safetyPath` is set when a safety backup was created.
 */
export async function restoreFromBackup(
  $: Shell,
  filePath: string,
  force: boolean = false,
): Promise<{ ok: boolean; message: string; safetyPath?: string }> {
  if (!existsSync(filePath)) {
    return { ok: false, message: `Restore failed: file not found: ${filePath}` }
  }

  let envelope: BackupEnvelope
  try {
    const raw = readFileSync(filePath, "utf-8")
    envelope = JSON.parse(raw) as BackupEnvelope
  } catch {
    return { ok: false, message: "Restore failed: invalid backup envelope" }
  }

  // Manual validation mirrors backup-schema.json (no ajv dependency).
  if (
    typeof envelope.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(envelope.version) ||
    typeof envelope.exportedAt !== "number" ||
    typeof envelope.backupOf !== "string" ||
    typeof envelope.session !== "object" ||
    envelope.session === null
  ) {
    return { ok: false, message: "Restore failed: invalid backup envelope" }
  }

  const sessionId = envelope.backupOf
  const existing = await findSessionById($, sessionId)

  let safetyPath: string | undefined
  if (existing) {
    if (force !== true) {
      return {
        ok: false,
        message: `Session already exists: ${sessionId}. Re-run with force=true to overwrite (a safety backup of the current session is created automatically before deletion).`,
      }
    }
    // Back up BEFORE deleting — protects against import failure (bug C3).
    const safetyBackup = await backupOne($, sessionId)
    if (!safetyBackup.ok || !safetyBackup.path) {
      return {
        ok: false,
        message: `Restore aborted: could not create safety backup of the existing session (${safetyBackup.error ?? "unknown error"}). The original session is untouched.`,
      }
    }
    safetyPath = safetyBackup.path
    await deleteSession($, sessionId)
  }

  const tmpFile = join(tmpdir(), `sm-restore-${sessionId}-${Date.now()}.json`)
  try {
    writeFileSync(tmpFile, JSON.stringify(envelope.session, null, 2), "utf-8")
    const ok = await importSession($, tmpFile)
    try { unlinkSync(tmpFile) } catch { /* best-effort cleanup */ }

    if (!ok) {
      const recoveryLine = safetyPath
        ? `\n  ⚠️  The existing session was already deleted, but a safety backup was saved:\n      ${safetyPath}\n  Restore it with sm_restore ${safetyPath}`
        : ""
      return { ok: false, message: `Restore failed: import error for ${sessionId}${recoveryLine}`, safetyPath }
    }

    const title = (envelope.session as any)?.info?.title ?? sessionId
    return {
      ok: true,
      message: `Restored: ${title} (${sessionId})\n  resume: opencode -s ${sessionId}`,
      safetyPath,
    }
  } catch (err: any) {
    return { ok: false, message: `Restore failed: ${err?.message ?? "unknown error"}` }
  }
}

/**
 * Create a full backup archive: pinned sessions + state + plugin + restore
 * instructions, in a single directory (default: a timestamped subdir of
 * the active backup dir).
 *
 * Returns `{ dir, sessionCount, hasState, hasPlugin, failures }`.
 */
export async function createFullBackup(
  $: Shell,
  targetDir?: string,
): Promise<{
  dir: string
  sessionCount: number
  hasState: boolean
  hasPlugin: boolean
  pluginFile?: string
  failures: string[]
}> {
  const dir = targetDir ?? join(getBackupDir(), `full-backup-${Date.now()}`)
  mkdirSync(dir, { recursive: true })

  const state = loadStateDefault()
  let backedUp = 0
  const failures: string[] = []

  for (const entry of state.pinned) {
    const result = await backupOne($, entry.sessionId, dir)
    if (result.ok) {
      backedUp++
    } else {
      failures.push(`  failed: ${entry.title} (${entry.sessionId}): ${result.error}`)
    }
  }

  let hasState = false
  if (existsSync(STATE_FILE)) {
    try {
      copyFileSync(STATE_FILE, join(dir, "session-manager.json"))
      hasState = true
    } catch { /* skip */ }
  }

  let hasPlugin = false
  let pluginFile: string | undefined
  // Local dev install is the common case during development; npm cache is
  // the common case for end users. Try local first, then fall back to cache.
  if (existsSync(LOCAL_PLUGIN_PATH)) {
    try {
      copyFileSync(LOCAL_PLUGIN_PATH, join(dir, "session-manager.ts"))
      hasPlugin = true
      pluginFile = "session-manager.ts"
    } catch { /* skip */ }
  } else {
    const pluginSrc = findNpmPluginSource()
    if (pluginSrc) {
      try {
        pluginFile = "plugin.js"
        copyFileSync(pluginSrc, join(dir, pluginFile))
        hasPlugin = true
      } catch { /* skip */ }
    }
  }

  return { dir, sessionCount: backedUp, hasState, hasPlugin, pluginFile, failures }
}

/** Try a list of well-known npm-cache layouts for the plugin bundle. */
function findNpmPluginSource(): string | null {
  const candidates = [
    join(homedir(), ".cache", "opencode", "packages",
      "@enerjizeit-opencode-session-manager@latest",
      "node_modules", "@enerjizeit-opencode-session-manager",
      "dist", "plugin.js"),
    join(homedir(), ".cache", "opencode", "packages",
      "@enerjizeit-opencode-session-manager@latest",
      "node_modules", "@enerjizeit", "opencode-session-manager",
      "dist", "plugin.js"),
    join(homedir(), ".cache", "opencode", "packages",
      "opencode-session-manager@latest",
      "node_modules", "opencode-session-manager",
      "dist", "plugin.js"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** re-exports for backwards compatibility with the old single-file layout. */
export { saveStateDefault, getBackupDir, STATE_FILE, DEFAULT_BACKUP_DIR }
