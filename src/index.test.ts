import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createDoclightMcp, getDoclightMcp, withDoclight } from "./index"

const API_KEY = "dl_mcp_test"
const PROJECT_ID = "proj_mcp_test"

// ─── minimal HTTP mock ────────────────────────────────────────────────────────

interface CapturedEvent {
  type: string
  toolName?: string
  status?: string
  durationMs?: number
  [k: string]: unknown
}

class CaptureSink {
  readonly events: CapturedEvent[] = []
  private _server: Server | undefined
  private _port = 0

  get baseUrl() {
    return `http://127.0.0.1:${this._port}`
  }

  async start() {
    await new Promise<void>((resolve) => {
      this._server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void this._handle(req, res)
      })
      this._server.listen(0, "127.0.0.1", () => {
        this._port = (this._server!.address() as AddressInfo).port
        resolve()
      })
    })
  }

  async stop() {
    if (!this._server) return
    await new Promise<void>((resolve, reject) => {
      this._server!.close((err) => (err ? reject(err) : resolve()))
    })
  }

  private async _handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString("utf8")
    try {
      const parsed = JSON.parse(body)
      const evs: CapturedEvent[] = Array.isArray(parsed.events) ? parsed.events : []
      this.events.push(...evs)
    } catch {
      // ignore malformed
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ accepted: 1, rejected: 0 }))
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeServer(name = "test-server") {
  return new McpServer({ name, version: "0.0.0" })
}

function cfg(endpoint: string) {
  return {
    apiKey: API_KEY,
    projectId: PROJECT_ID,
    endpoint,
    transport: { batchSize: 1, flushIntervalMs: 60_000, retries: 0 },
  } as const
}

// Invoke the registered handler directly without a real MCP transport.
async function callTool(server: McpServer, toolName: string, args: unknown = {}) {
  const tools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => unknown }
      >
    }
  )._registeredTools
  const tool = tools[toolName]
  if (!tool) throw new Error(`tool "${toolName}" not registered`)
  return tool.handler(args, {})
}

function toolCalledEvents(sink: CaptureSink) {
  return sink.events.filter((e) => e.type === "tool_called")
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("withDoclight()", () => {
  let sink: CaptureSink

  beforeEach(async () => {
    sink = new CaptureSink()
    await sink.start()
  })

  afterEach(async () => {
    await sink.stop()
  })

  it("returns the same server instance", () => {
    const server = makeServer()
    expect(withDoclight(server, cfg(sink.baseUrl))).toBe(server)
  })

  it("wraps a tool registered AFTER withDoclight() is called", async () => {
    const server = makeServer()
    withDoclight(server, cfg(sink.baseUrl))

    server.tool("after_tool", async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }))

    await callTool(server, "after_tool")
    await new Promise((r) => setTimeout(r, 200))

    const events = toolCalledEvents(sink)
    const ev = events.find((e) => e.toolName === "after_tool")
    expect(ev).toBeDefined()
    expect(ev?.status).toBe("success")
    expect(typeof ev?.durationMs).toBe("number")
  })

  it("wraps a tool registered BEFORE withDoclight() is called", async () => {
    const server = makeServer()

    server.tool("before_tool", async () => ({
      content: [{ type: "text" as const, text: "pre" }],
    }))

    withDoclight(server, cfg(sink.baseUrl))

    await callTool(server, "before_tool")
    await new Promise((r) => setTimeout(r, 200))

    const events = toolCalledEvents(sink)
    const ev = events.find((e) => e.toolName === "before_tool")
    expect(ev).toBeDefined()
    expect(ev?.status).toBe("success")
  })

  it("records status:failed and re-throws when handler throws", async () => {
    const server = makeServer()
    withDoclight(server, cfg(sink.baseUrl))

    server.tool("failing_tool", async () => {
      throw new Error("boom")
    })

    await expect(callTool(server, "failing_tool")).rejects.toThrow("boom")
    await new Promise((r) => setTimeout(r, 200))

    const events = toolCalledEvents(sink)
    const ev = events.find((e) => e.toolName === "failing_tool")
    expect(ev).toBeDefined()
    expect(ev?.status).toBe("failed")
  })

  it("does not double-wrap when withDoclight() is called twice", async () => {
    const server = makeServer()
    server.tool("shared_tool", async () => ({
      content: [{ type: "text" as const, text: "x" }],
    }))

    withDoclight(server, cfg(sink.baseUrl))
    withDoclight(server, cfg(sink.baseUrl))
    server.tool("late_tool", async () => ({ content: [] }))

    await callTool(server, "shared_tool")
    await callTool(server, "late_tool")
    await getDoclightMcp(server)!.flush()

    const hits = toolCalledEvents(sink)
    expect(hits.filter((e) => e.toolName === "shared_tool")).toHaveLength(1)
    expect(hits.filter((e) => e.toolName === "late_tool")).toHaveLength(1)
  })

  it("wraps registerTool() and preserves arguments, result and this", async () => {
    const server = makeServer()
    withDoclight(server, cfg(sink.baseUrl))
    const seen: unknown[] = []
    const result = { content: [{ type: "text" as const, text: "r" }] }
    server.registerTool(
      "reg_tool",
      { description: "d" },
      async (extra: unknown) => {
        seen.push(extra)
        return result
      },
    )
    const extra = { marker: 1 }
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (e: unknown) => Promise<unknown> }>
    })._registeredTools
    const out = await tools.reg_tool!.handler(extra)
    expect(out).toBe(result)
    expect(seen[0]).toBe(extra)
    await getDoclightMcp(server)!.flush()
    const ev = toolCalledEvents(sink).find((e) => e.toolName === "reg_tool")
    expect(ev?.status).toBe("success")
  })

  it("records MCP isError results as failed without capturing content", async () => {
    const server = makeServer()
    withDoclight(server, cfg(sink.baseUrl))
    const result = {
      isError: true,
      content: [{ type: "text" as const, text: "token=sk-supersecret" }],
    }
    server.tool("err_result", async () => result)
    expect(await callTool(server, "err_result")).toBe(result)
    await getDoclightMcp(server)!.flush()
    const ev = toolCalledEvents(sink).find((e) => e.toolName === "err_result")
    expect(ev?.status).toBe("failed")
    expect(JSON.stringify(sink.events)).not.toContain("sk-supersecret")
  })

  it("does not capture thrown error messages", async () => {
    const server = makeServer()
    withDoclight(server, cfg(sink.baseUrl))
    server.tool("throws", async () => {
      throw new TypeError("password=hunter2")
    })
    await expect(callTool(server, "throws")).rejects.toThrow("password=hunter2")
    await getDoclightMcp(server)!.flush()
    expect(JSON.stringify(sink.events)).not.toContain("hunter2")
  })

  it("isolates concurrent calls into separate sessions", async () => {
    const server = makeServer()
    withDoclight(server, cfg(sink.baseUrl))
    server.tool("slow", async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { content: [] }
    })
    server.tool("boom", async () => {
      throw new Error("x")
    })
    await Promise.allSettled([
      callTool(server, "slow"),
      callTool(server, "slow"),
      callTool(server, "boom"),
    ])
    await getDoclightMcp(server)!.flush()
    const calls = toolCalledEvents(sink)
    expect(calls).toHaveLength(3)
    expect(new Set(calls.map((e) => e.sessionId as string)).size).toBe(3)
    expect(calls.filter((e) => e.status === "failed")).toHaveLength(1)
  })

  it("does not break tools when telemetry fails", async () => {
    const server = makeServer()
    withDoclight(server, cfg(sink.baseUrl))
    const mcp = getDoclightMcp(server)!
    const boom = () => {
      throw new Error("telemetry down")
    }
    mcp.client.startSession = boom
    mcp.client.trackToolCall = boom
    mcp.client.endSession = boom
    server.tool("ok_tool", async () => ({ content: [] }))
    server.tool("bad_tool", async () => {
      throw new Error("app error")
    })
    await expect(callTool(server, "ok_tool")).resolves.toEqual({ content: [] })
    await expect(callTool(server, "bad_tool")).rejects.toThrow("app error")
  })

  it("leaves non-function (task) handlers untouched", () => {
    const server = makeServer()
    const taskHandler = { createTask: () => undefined }
    ;(server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools.t = {
      handler: taskHandler,
    }
    withDoclight(server, cfg(sink.baseUrl))
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })
      ._registeredTools
    expect(tools.t!.handler).toBe(taskHandler)
  })

  it("rejects a low-level Server-like object", () => {
    expect(() => withDoclight({} as unknown as McpServer, cfg(sink.baseUrl))).toThrow(TypeError)
  })

  it("flush() and shutdown() are safe and idempotent", async () => {
    const server = makeServer()
    withDoclight(server, cfg(sink.baseUrl))
    server.tool("t", async () => ({ content: [] }))
    await callTool(server, "t")
    const mcp = getDoclightMcp(server)!
    await mcp.shutdown()
    await mcp.shutdown()
    expect(toolCalledEvents(sink)).toHaveLength(1)
  })
})

describe("createDoclightMcp()", () => {
  it("rejects batch sizes above the 500-event ingest limit", () => {
    expect(() =>
      createDoclightMcp({
        apiKey: API_KEY,
        projectId: PROJECT_ID,
        transport: { batchSize: 501 },
      }),
    ).toThrow(RangeError)
  })
})
