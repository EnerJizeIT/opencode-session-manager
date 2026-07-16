import { describe, expect, it } from "bun:test"
import { parseJson } from "../src/state"

describe("parseJson", () => {
  it("parses a clean JSON object", () => {
    const result = parseJson('{"a":1}')
    expect(result).toEqual({ a: 1 })
  })

  it("parses a clean JSON array", () => {
    const result = parseJson('[{"id":"x"}]')
    expect(result).toEqual([{ id: "x" }])
  })

  it("handles [page-assist] noise prefix then JSON array (regression case)", () => {
    const stdout = "[page-assist] CLI mode … (serve mode only)\n[{\"id\":\"session-1\",\"title\":\"Test\"}]"
    const result = parseJson(stdout)
    expect(Array.isArray(result)).toBe(true)
    expect(result[0]).toEqual({ id: "session-1", title: "Test" })
  })

  it("handles [page-assist] noise prefix then JSON object", () => {
    const stdout = "[page-assist] CLI mode … (serve mode only)\n{\"id\":\"session-1\"}"
    const result = parseJson(stdout)
    expect(result).toEqual({ id: "session-1" })
  })

  it("handles leading whitespace and newlines before JSON", () => {
    const result = parseJson("\n\n  \n{\"key\":\"value\"}")
    expect(result).toEqual({ key: "value" })
  })

  it("throws on empty string", () => {
    expect(() => parseJson("")).toThrow("no JSON found in output")
  })

  it("throws when there is no JSON at all", () => {
    expect(() => parseJson("just text")).toThrow("no JSON found in output")
  })

  it("does not confuse [page-assist] bracket with array start", () => {
    const stdout = "[page-assist] CLI mode only\nsome other text"
    expect(() => parseJson(stdout)).toThrow()
  })
})
