/**
 * Pinned-check harness (TODO-0012).
 *
 * Verifies the DB-list fix against the REAL state without touching sm_*
 * tools (they would trigger auto-maintenance with auto-cleanup):
 *
 *   1. findSessionById for every pinned session — the new DB source must
 *      find all of them, from any cwd.
 *   2. ensurePinnedBackups — refresh stale pinned backups. The session
 *      exports it performs are expected and allowed here.
 *
 * Run from the repo root:  bun scripts/check-pinned.ts
 */

import { loadStateDefault } from "../src/state"
import { findSessionById, invalidateSessionCache } from "../src/cli"
import { ensurePinnedBackups } from "../src/backup"

const state = loadStateDefault()
invalidateSessionCache()

const found: string[] = []
const missing: string[] = []
for (const p of state.pinned) {
  const s = await findSessionById(null, p.sessionId)
  if (s) {
    found.push(p.sessionId)
    console.log(`FOUND   ${p.sessionId}  ${s.title}  (project=${s.projectId} dir=${s.directory})`)
  } else {
    missing.push(p.sessionId)
    console.log(`MISSING ${p.sessionId}  ${p.title}`)
  }
}

const refresh = await ensurePinnedBackups(null)
console.log(
  "REFRESH " +
    JSON.stringify({
      refreshed: refresh.refreshed.length,
      current: refresh.current.length,
      failed: refresh.failed.length,
      failedIds: refresh.failed,
    }),
)
console.log(
  "CHECK " +
    JSON.stringify({
      pinned: state.pinned.length,
      found: found.length,
      missing: missing.length,
      missingIds: missing,
    }),
)
