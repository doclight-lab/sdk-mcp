# @doclight/mcp

Automatic instrumentation for [MCP](https://modelcontextprotocol.io) servers via the Doclight Agent Observability SDK. Wraps `@doclight/node` with a `trackTool` convenience layer so each tool call is automatically timed and recorded without boilerplate.

## Install

```bash
npm install @doclight/mcp
```

## Before / after

```ts
// Before — plain MCP server
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
const server = new Server({ name: "my-server", version: "1.0.0" })
server.setRequestHandler(CallToolRequestSchema, handler)

// After — automatic instrumentation (+2 lines)
import { withDoclight } from "@doclight/mcp"
const server = withDoclight(new Server({ name: "my-server", version: "1.0.0" }), {
  apiKey: process.env.DOCLIGHT_API_KEY!,
  projectId: process.env.DOCLIGHT_PROJECT_ID!,
})
server.setRequestHandler(CallToolRequestSchema, handler)
```

`withDoclight` monkey-patches all tool handlers on the server instance to automatically open a session, record timing and outcome, and close the session for every tool call.

## What NEVER Gets Captured

- Tool input arguments
- Tool output / response content
- Prompt text or user messages
- Any secrets or credentials

## What gets instrumented automatically

| Event type | Trigger | Key fields |
| --- | --- | --- |
| `session_started` | Tool call begins | `goal` = tool name |
| `tool_called` | Tool handler runs | `toolName`, `durationMs`, `status` |
| `session_completed` | Tool call returns | `outcome` = success/failed/timeout |
| `error_occurred` | Handler throws | `errorType`, `errorMessage` |

## Session lifecycle

**stdio transport**: One session per tool call (session_started → tool_called → session_completed). The process lifetime may span many sessions — each tool invocation is independent.

**HTTP transport**: Same single-call lifecycle. Sessions are independent between requests; there is no shared session across concurrent HTTP calls.

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

  const result = await mcp.trackTool(
    request.params.name,
    sessionId,
    () => runTool(request.params),
  )

  mcp.endSession(sessionId, "success")
  return result
})

const transport = new StdioServerTransport()
await server.connect(transport)

process.on("SIGINT", async () => {
  await mcp.shutdown()
  process.exit(0)
})
```

## API

### `createDoclightMcp(config)`

Returns a `DoclightMcp` context. Lifecycle hooks are disabled by default so the MCP server process owns its own shutdown sequence. Pass `lifecycleHooks: true` to re-enable them.

| Method | Description |
| --- | --- |
| `startSession(goal?)` | Open a new session; returns `sessionId` |
| `endSession(sessionId, outcome)` | Close the session |
| `trackTool(name, sessionId, fn)` | Run `fn`, record duration + outcome |
| `flush()` | Flush buffered events immediately |
| `shutdown()` | Flush and close the transport |
| `client` | The underlying `Doclight` instance |

---

[Example MCP server →](https://github.com/doclight/doclight-example-mcp)

[Full documentation →](https://doclight.app/docs)
