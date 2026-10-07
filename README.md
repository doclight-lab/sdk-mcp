# @doclight/mcp

Automatic instrumentation for [MCP](https://modelcontextprotocol.io) servers via the Doclight Agent Observability SDK. Wraps `@doclight/node` with a `trackTool` convenience layer so each tool call is automatically timed and recorded without boilerplate.

## Install

```bash
npm install @doclight/mcp
```

## Compatibility

- `@modelcontextprotocol/sdk` `>=1.12.0` (tested against 1.29). Supported API: **`McpServer`** with `server.tool()` and `server.registerTool()`.
- `withDoclight` relies on `McpServer` internals (`_registeredTools`), so a future SDK major may need an update.
- The low-level `Server` class (`setRequestHandler`) is **not** auto-instrumented; use the manual quickstart below.
- Not wrapped: handlers swapped later via `registeredTool.update({ callback })` and task-based tools (`registerToolTask`).

## Before / after

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { withDoclight, getDoclightMcp } from "@doclight/mcp"

// Before — plain MCP server
const server = new McpServer({ name: "my-server", version: "1.0.0" })

// After — automatic instrumentation (+1 call)
withDoclight(server, {
  apiKey: process.env.DOCLIGHT_API_KEY!,
  projectId: process.env.DOCLIGHT_PROJECT_ID!,
})

// Tools registered before OR after withDoclight() are instrumented.
server.registerTool("my_tool", { description: "..." }, async () => ({
  content: [{ type: "text", text: "ok" }],
}))

await server.connect(new StdioServerTransport())

// You own shutdown: flush buffered events before exiting.
process.on("SIGINT", async () => {
  await getDoclightMcp(server)?.shutdown()
  process.exit(0)
})
```

`withDoclight` wraps tool handlers so every call records a session, its duration and its outcome. Handler arguments, return values, `this` and thrown errors are passed through unchanged, and telemetry failures never affect tool behavior. Calling `withDoclight` again on the same server is a no-op (no duplicate telemetry).

Outcome: a thrown error **or** an MCP result with `isError: true` is recorded as `failed`; otherwise `success`.

## Flush / shutdown ownership

`withDoclight` registers **no** process signal handlers and writes nothing to stdout, so it cannot corrupt the stdio JSON-RPC stream. The application owns lifecycle: call `getDoclightMcp(server)?.flush()` or `.shutdown()` (both never reject) before exit. With `createDoclightMcp` use `mcp.flush()` / `mcp.shutdown()`.

## Batch limits

The ingest backend accepts at most 500 events per batch. Each tool call emits about 3 events, so `transport.batchSize` (counted in events) must be `<= 500`; larger values throw a `RangeError`. These tool/session batches are separate from website telemetry sent by other Doclight SDKs.

## Manual quickstart (without `withDoclight`)

```ts
import { createDoclightMcp } from "@doclight/mcp"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const mcp = createDoclightMcp({
  apiKey: process.env.DOCLIGHT_API_KEY!,
  projectId: process.env.DOCLIGHT_PROJECT_ID!,
})

const server = new Server({ name: "my-mcp-server", version: "1.0.0" })

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const sessionId = mcp.startSession(request.params.name)
  try {
    const result = await mcp.trackTool(
      request.params.name,
      sessionId,
      () => runTool(request.params),
    )
    mcp.endSession(sessionId, "success")
    return result
  } catch (err) {
    mcp.endSession(sessionId, "failed")
    throw err
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

process.on("SIGINT", async () => {
  await mcp.shutdown()
  process.exit(0)
})
```

## API

### `getDoclightMcp(server)`

Returns the context attached by `withDoclight`, or `undefined`.

### `createDoclightMcp(config)`

Returns a `DoclightMcp` context. Lifecycle hooks are disabled by default so the MCP server process owns its own shutdown sequence. Pass `lifecycleHooks: true` to re-enable them.

| Method | Description |
| --- | --- |
| `startSession(goal?)` | Open a new session; returns `sessionId` |
| `endSession(sessionId, outcome)` | Close the session |
| `trackTool(name, sessionId, fn)` | Run `fn`, record duration + outcome |
| `flush()` | Flush buffered events immediately (never rejects) |
| `shutdown()` | Flush and close the transport (never rejects) |
| `client` | The underlying `Doclight` instance |

---

[Example MCP server →](https://github.com/doclight/doclight-example-mcp)

[Full documentation →](https://doclight.app/docs)

## Source and issues

- Source: https://github.com/doclight-lab/sdk-mcp
- Issues: https://github.com/doclight-lab/sdk-mcp/issues
