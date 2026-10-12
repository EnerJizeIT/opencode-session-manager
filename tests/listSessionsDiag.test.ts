import { afterEach, afterAll, describe, expect, it, mock } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"

/**
 * TODO-0011 regression: the listSessions diagnostics must not change the
 * return contract (CLI failure -> [], success -> sessions) and must write
 * one fact line per call on both paths.
 *
 * logHookEvent is mocked so the test never touches the user's real
 * session-manager-hooks.log (bun's os.homedir() ignores $HOME, so env
 * redirection is not an option). The child "opencode" is replaced by a
 * PATH shim / empty PATH — no real CLI call, no DB touch.
 */
const captured: string[] = []
const realState = await import("../src/state")
mock.module("../src/state", () => ({
  ...realState,
  logHookEvent: (hook: string, detail = "") => {
    captured.push(`${hook}  ${detail}`)
  },
}))
const { listSessions, invalidateSessionCache } = await import("../src/cli")

const TMP = mkdtempSync("/tmp/opencode/sm-diag-")
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
afterEach(() => {
  captured.length = 0
  invalidateSessionCache()
})

describe("listSessions diagnostics (TODO-0011)", () => {
  it("CLI failure: returns [] and logs exactly one ERROR fact line", async () => {
    const emptyBin = `${TMP}/empty-bin`
    mkdirSync(emptyBin, { recursive: true })
    const realPath = process.env.PATH
    process.env.PATH = emptyBin // no "opencode" on PATH -> ENOENT
    try {
      const sessions = await listSessions(null)
      expect(sessions).toEqual([])
    } finally {
      process.env.PATH = realPath
    }
    expect(captured.filter((l) => l.includes("ERROR code=ENOENT")).length).toBe(1)
    const line = captured.find((l) => l.includes("ERROR code=ENOENT"))
    expect(line).toContain("cmd=opencode session list --format json -n 100000")
    expect(line).toContain("cwd=")
  })

  it("success with stderr noise: returns sessions and logs OK count", async () => {
    const bin = `${TMP}/bin`
    mkdirSync(bin, { recursive: true })
    const shim = `${bin}/opencode`
    writeFileSync(
      shim,
      "#!/bin/sh\necho \"[page-assist] CLI mode - skipping WS server\" >&2\necho '[{\"id\":\"ses_test1\",\"title\":\"T1\"},{\"id\":\"ses_test2\",\"title\":\"T2\"}]'\n",
    )
    chmodSync(shim, 0o755)
    const realPath = process.env.PATH
    process.env.PATH = `${bin}:${realPath}`
    try {
      const sessions = await listSessions(null)
      expect(sessions.map((s) => s.id)).toEqual(["ses_test1", "ses_test2"])
    } finally {
      process.env.PATH = realPath
    }
    expect(captured.filter((l) => l.includes("OK count=2")).length).toBe(1)
  })
})
