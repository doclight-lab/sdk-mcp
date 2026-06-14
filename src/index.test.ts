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
import { withDoclight } from "./index"

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

  it("does not double-wrap when called twice with the same pre-registered tool", async () => {
    const server = makeServer()

    server.tool("shared_tool", async () => ({
      content: [{ type: "text" as const, text: "x" }],
    }))

    // Two independent clients both wrap the pre-registered handler.
    // The second call should detect the already-wrapped handler and skip.
    withDoclight(server, cfg(sink.baseUrl))
    withDoclight(server, cfg(sink.baseUrl))

    await callTool(server, "shared_tool")
    await new Promise((r) => setTimeout(r, 200))

    // Each withDoclight() creates its own client, so 2 tool_called events
    // is expected — one per instrumentation layer. Without the DOCLIGHT_WRAPPED
    // guard, the second layer's wrap of an already-wrapped handler would
    // produce 3 events (outer → inner → original).
    const hits = toolCalledEvents(sink).filter((e) => e.toolName === "shared_tool")
    expect(hits.length).toBe(2)
  })
})
