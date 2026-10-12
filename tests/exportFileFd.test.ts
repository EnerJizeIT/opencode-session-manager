import { afterEach, afterAll, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"

/**
 * TODO-0012 regression: exportSession captures the export's stdout through
 * a temp file, not a pipe (opencode 1.19.0 truncates `export` output in
 * pipe mode — nondeterministic cut, exit 0). Contract pinned here:
 *   - large stdout round-trips completely (tail included),
 *   - nonzero exit -> "",
 *   - no sm-export-* temp file of this process is left behind.
 *
 * The "opencode" child is replaced by a PATH shim — no real CLI, no DB.
 */
const { exportSession, exportTempPath } = await import("../src/cli")

const TMP = mkdtempSync("/tmp/opencode/sm-export-")
const BIN = `${TMP}/bin`
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

function installShim(script: string): void {
  mkdirSync(BIN, { recursive: true })
  const shim = `${BIN}/opencode`
  writeFileSync(shim, script)
  chmodSync(shim, 0o755)
  process.env.PATH = `${BIN}:${process.env.PATH}`
}

const REAL_PATH = process.env.PATH
afterEach(() => {
  process.env.PATH = REAL_PATH
})

describe("exportSession file-fd capture (TODO-0012)", () => {
  it("round-trips large stdout completely (tail included)", async () => {
    installShim(
      ["#!/bin/sh", "yes 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | head -n 20000", "echo 'END_MARKER_OK'", ""].join("\n"),
    )
    const out = await exportSession(null, "ses_test_export")
    expect(out.length).toBeGreaterThan(700_000)
    expect(out.endsWith("END_MARKER_OK\n")).toBe(true)
  })

  it("nonzero exit: returns empty string", async () => {
    installShim("#!/bin/sh\necho boom >&2\nexit 3\n")
    const out = await exportSession(null, "ses_test_export")
    expect(out).toBe("")
  })

  it("leaves no sm-export-* temp file of this process", async () => {
    installShim("#!/bin/sh\necho '{}'\n")
    await exportSession(null, "ses_test_export")
    const leftovers = readdirSync(tmpdir()).filter(
      (f) => f.startsWith(`sm-export-${process.pid}-`),
    )
    expect(leftovers).toEqual([])
  })

  it("exportTempPath: same id, many calls — no two paths collide", () => {
    // Without the random suffix, pid+ms+id collides for parallel exports of
    // the same session (concurrent sm_backup calls) and both children would
    // write into one file.
    const paths = new Set(Array.from({ length: 1000 }, () => exportTempPath("ses_same_id")))
    expect(paths.size).toBe(1000)
  })

  it("parallel exports of the same id both round-trip completely", async () => {
    installShim(
      ["#!/bin/sh", "yes 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | head -n 20000", "echo 'END_MARKER_OK'", ""].join("\n"),
    )
    const [a, b] = await Promise.all([
      exportSession(null, "ses_parallel"),
      exportSession(null, "ses_parallel"),
    ])
    expect(a.length).toBeGreaterThan(700_000)
    expect(a.endsWith("END_MARKER_OK\n")).toBe(true)
    expect(b.length).toBeGreaterThan(700_000)
    expect(b.endsWith("END_MARKER_OK\n")).toBe(true)
  })
})
