/**
 * Pure formatting / lookup helpers — no state, no side effects beyond `fs`.
 */

import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

/** Format a millisecond timestamp as `YYYY-MM-DD`. */
export function formatDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Possible locations of the installed plugin source. */
export type PluginSource = { path: string; kind: "local-tsx" | "npm-dist" }

/**
 * Locate the installed plugin source for inclusion in a full backup.
 * Tries, in order:
 *   1. Local dev install:  ~/.config/opencode/plugins/session-manager.ts
 *   2. npm cache install (scoped, modern layout)
 *   3. npm cache install (unscoped, legacy)
 * Returns the first match or `null`.
 */
export function findPluginSourcePath(): PluginSource | null {
  const candidates: PluginSource[] = [
    {
      path: join(homedir(), ".config", "opencode", "plugins", "session-manager.ts"),
      kind: "local-tsx",
    },
    {
      path: join(
        homedir(),
        ".cache",
        "opencode",
        "packages",
        "@enerjizeit-opencode-session-manager@latest",
        "node_modules",
        "@enerjizeit-opencode-session-manager",
        "dist",
        "plugin.js",
      ),
      kind: "npm-dist",
    },
    {
      path: join(
        homedir(),
        ".cache",
        "opencode",
        "packages",
        "@enerjizeit-opencode-session-manager@latest",
        "node_modules",
        "@enerjizeit",
        "opencode-session-manager",
        "dist",
        "plugin.js",
      ),
      kind: "npm-dist",
    },
    {
      path: join(
        homedir(),
        ".cache",
        "opencode",
        "packages",
        "opencode-session-manager@latest",
        "node_modules",
        "opencode-session-manager",
        "dist",
        "plugin.js",
      ),
      kind: "npm-dist",
    },
  ]
  for (const c of candidates) {
    if (existsSync(c.path)) return c
  }
  return null
}
