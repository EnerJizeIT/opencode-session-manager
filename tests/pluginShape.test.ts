/**
 * Dual-API shape: one package must present a V2 definition (`id` + `setup`)
 * and a V1 entrypoint (`server()` → `{ tool, "tool.execute.before" }`), with
 * the same tool names on both sides.
 *
 * This is the contract the plugin sets out to keep across the 1.x → 2.x move.
 * It does not exercise state or the CLI; it checks the registration surface.
 */

import { describe, expect, test } from "bun:test"
import plugin, { SessionManagerPlugin, SessionManagerV2 } from "../session-manager"

const EXPECTED_TOOLS = [
  "sm_pin", "sm_unpin", "sm_list", "sm_search", "sm_current_session",
  "sm_status", "sm_backup", "sm_backup_all", "sm_restore", "sm_list_backups",
  "sm_full_backup", "sm_settings", "sm_config", "sm_cleanup",
  "sm_cleanup_backups", "sm_cleanup_pinned",
].sort()

describe("default export", () => {
  test("carries both entrypoints", () => {
    expect(plugin.id).toBe("session-manager")
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
    expect(plugin.server).toBe(SessionManagerPlugin)
  })
})

describe("V1 entrypoint", () => {
  test("returns every tool plus the session-tracking hook", async () => {
    const hooks: any = await SessionManagerPlugin({} as any)
    expect(Object.keys(hooks.tool).sort()).toEqual(EXPECTED_TOOLS)
    expect(typeof hooks["tool.execute.before"]).toBe("function")
    for (const name of EXPECTED_TOOLS) {
      expect(typeof hooks.tool[name].execute).toBe("function")
      expect(typeof hooks.tool[name].description).toBe("string")
      expect(hooks.tool[name].args).toBeTypeOf("object")
    }
  })

  test("executes a tool without a session", async () => {
    const hooks: any = await SessionManagerPlugin({} as any)
    const result = await hooks.tool.sm_current_session.execute({}, {})
    expect(result).toContain("No active session is known yet")
  })
})

describe("V2 entrypoint", () => {
  test("registers the same tools and the execute.before hook", async () => {
    const added: any[] = []
    let hookName: string | undefined

    const ctx = {
      tool: {
        transform: async (cb: (editor: any) => void) => {
          cb({ add: (def: any) => added.push(def) })
        },
        hook: async (name: string) => { hookName = name },
      },
    }

    await (SessionManagerV2.setup as any)(ctx)

    expect(added.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS)
    expect(hookName).toBe("execute.before")
    for (const def of added) {
      expect(typeof def.description).toBe("string")
      expect(def.input).toBeDefined()
      expect(typeof def.execute).toBe("function")
    }
  })

  test("execution returns structured content", async () => {
    const added: any[] = []
    const ctx = {
      tool: {
        transform: async (cb: (editor: any) => void) => {
          cb({ add: (def: any) => added.push(def) })
        },
        hook: async () => {},
      },
    }

    await (SessionManagerV2.setup as any)(ctx)
    const current = added.find((t) => t.name === "sm_current_session")
    const result = await current.execute({}, {})
    expect(result.content).toContain("No active session is known yet")
  })
})
