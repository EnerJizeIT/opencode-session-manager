/**
 * Shared types for the OpenCode Session Manager plugin.
 *
 * Kept in a single file so the plugin entry, CLI wrappers and backup helpers
 * can import the contracts without pulling in implementation code.
 */

/** Session info returned by `opencode session list --format json`. */
export interface SessionInfo {
  id: string
  title: string
  updated: number
  created: number
  projectId: string
  directory: string
}

/** Backup envelope wrapping a single session export. */
export interface BackupEnvelope {
  version: string
  exportedAt: number
  backupOf: string
  session: unknown
}

/** Report returned by the cleanup routine. */
export interface CleanupReport {
  deleted: string[]
  skippedPinned: string[]
  failed: string[]
}

/** Report returned by the backup-retention routine. */
export interface RetentionReport {
  removed: string[]
  protected: string[]
  skippedRecent: string[]
  corrupt: string[]
}

/** Backup file metadata as returned by `listBackups()`. */
export interface BackupEntry {
  filename: string
  filePath: string
  sessionId: string
  title: string
  date: number
  size: number
  corrupt: boolean
}

/**
 * Outcome of a session lookup that supports short-prefix matching.
 *   - "found": exactly one session matched (full ID or unique prefix).
 *   - "not_found": zero matches.
 *   - "ambiguous": multiple sessions share the prefix — caller must disambiguate.
 *   - "error": underlying CLI / DB failed (distinguishes real errors from
 *     "session doesn't exist" — addresses audit point #8).
 */
export type FindQueryResult =
  | { kind: "found"; session: SessionInfo }
  | { kind: "not_found"; query: string }
  | { kind: "ambiguous"; query: string; matches: SessionInfo[] }
  | { kind: "error"; message: string }
