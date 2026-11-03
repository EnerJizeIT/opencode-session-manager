import { afterEach, afterAll, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"

/**
 * CLI wrapper contract (opencode 1.x and 2.x):
 *   - export stdout is captured through a temp file, not a pipe — opencode
 *     1.19+ truncates `export` output in pipe mode (nondeterministic cut,
 *     exit 0), so a large stdout must round-trip completely;
 *   - the argv layout follows the CLI generation, probed once per process via
 *     `opencode --version`: v2 moved export/import under `session`
 *     (`opencode session export|import`), v1 keeps them at the root (bug of
 *     30.10: root commands became usage errors under 2.x). A failed probe
 *     falls back to the adapter hint (`setCliFlavor`);
 *   - nonzero exit -> "", no sm-export-* temp file left behind.
 *
 * The "opencode" child is replaced by a PATH shim — no real CLI, no DB.
 */
const { exportSession, exportTempPath, importSession, setCliFlavor } = await import("../src/cli")

const TMP = mkdtempSync("/tmp/opencode/sm-export-")
const BIN = `${TMP}/bin`
const ARGV_LOG = `${TMP}/argv.log`
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

/** Shell shim: answers `--version`, runs the body for everything else. */
function shim(versionAnswer: string | null, body: string[]): string {
  const probe = versionAnswer === null
    ? 'if [ "$1" = "--version" ]; then exit 1; fi'
    : `if [ "$1" = "--version" ]; then echo "${versionAnswer}"; exit 0; fi`
  return ["#!/bin/sh", probe, ...body, ""].join("\n")
}

/** Body that records argv (one argument per line) and succeeds. */
function argvBody(): string[] {
  return [`for a in "$@"; do echo "$a"; done > "${ARGV_LOG}"`, "echo '{}'"]
}

function installShim(script: string): void {
  mkdirSync(BIN, { recursive: true })
  const file = `${BIN}/opencode`
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  process.env.PATH = `${BIN}:${process.env.PATH}`
}

function readArgv(): string[] {
  return readFileSync(ARGV_LOG, "utf-8").trim().split("\n")
}

const REAL_PATH = process.env.PATH
afterEach(() => {
  process.env.PATH = REAL_PATH
  setCliFlavor("v1") // resets the cached probe result too
})

describe("exportSession file-fd capture (TODO-0012)", () => {
  it("round-trips large stdout completely (tail included)", async () => {
    installShim(
      shim("1.19.4", [
        "yes 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | head -n 20000",
        "echo 'END_MARKER_OK'",
      ]),
    )
    const out = await exportSession(null, "ses_test_export")
    expect(out.length).toBeGreaterThan(700_000)
    expect(out.endsWith("END_MARKER_OK\n")).toBe(true)
  })

  it("nonzero exit: returns empty string", async () => {
    installShim(shim("1.19.4", ["echo boom >&2", "exit 3"]))
    const out = await exportSession(null, "ses_test_export")
    expect(out).toBe("")
  })

  it("leaves no sm-export-* temp file of this process", async () => {
    installShim(shim("1.19.4", ["echo '{}'"]))
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
      shim("1.19.4", [
        "yes 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | head -n 20000",
        "echo 'END_MARKER_OK'",
      ]),
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

describe("CLI flavor auto-detection (30.10 bug)", () => {
  it("opencode 2.x: export and import use `session` subcommands", async () => {
    installShim(shim("2.2.3", argvBody()))
    await exportSession(null, "ses_x")
    expect(readArgv()).toEqual(["session", "export", "ses_x"])

    expect(await importSession(null, "/tmp/x.json")).toBe(true)
    expect(readArgv()).toEqual(["session", "import", "/tmp/x.json"])
  })

  it("opencode 1.x: export and import stay at the root", async () => {
    installShim(shim("1.19.4", argvBody()))
    await exportSession(null, "ses_x")
    expect(readArgv()).toEqual(["export", "ses_x"])

    expect(await importSession(null, "/tmp/x.json")).toBe(true)
    expect(readArgv()).toEqual(["import", "/tmp/x.json"])
  })

  it("failed version probe: falls back to the adapter hint", async () => {
    setCliFlavor("v2")
    installShim(shim(null, argvBody()))
    await exportSession(null, "ses_x")
    expect(readArgv()).toEqual(["session", "export", "ses_x"])
  })
})
