import { createDoclight, type CreateDoclightConfig } from "@doclight/node"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export type { CreateDoclightConfig }

export type DoclightMcpConfig = CreateDoclightConfig

export type ToolOutcome = "success" | "failed" | "timeout" | "cancelled"

export interface DoclightMcp {
  /** The underlying Doclight client for direct access when needed. */
  client: ReturnType<typeof createDoclight>
  /**
   * Open a new session for one agent interaction. Returns the sessionId to
   * pass to {@link trackTool} and {@link endSession}.
   */
  startSession(goal?: string): string
  /**
   * Close a session opened with {@link startSession}.
   */
  endSession(sessionId: string, outcome: ToolOutcome): void
  /**
   * Wrap an async tool handler so its duration and outcome are automatically
   * recorded to Doclight.
   *
   * ```ts
   * const result = await mcp.trackTool("search_files", sessionId, () =>
   *   mySearchHandler(args),
   * )
   * ```
   */
  trackTool<T>(
    toolName: string,
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T>
  /** Flush all buffered events immediately. */
  flush(): Promise<void>
  /** Flush and shut down the underlying transport. */
  shutdown(): Promise<void>
}

/**
 * Create a Doclight context pre-wired for MCP server instrumentation.
 *
 * Lifecycle hooks are **disabled** by default so the MCP server process owns
 * its own shutdown sequence. Pass `lifecycleHooks: true` to re-enable them.
 */
export function createDoclightMcp(
  config: DoclightMcpConfig,
): DoclightMcp {
  const client = createDoclight({ lifecycleHooks: false, ...config })

  return {
    client,

    startSession(goal?: string): string {
      return client.startSession(goal)
    },

    endSession(sessionId: string, outcome: ToolOutcome): void {
      client.endSession(sessionId, outcome)
    },

    async trackTool<T>(
      toolName: string,
      sessionId: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      const start = Date.now()
      try {
        const result = await fn()
        client.trackToolCall({
          sessionId,
          toolName,
          status: "success",
          durationMs: Date.now() - start,
        })
        return result
      } catch (err) {
        client.trackToolCall({
          sessionId,
          toolName,
          status: "failed",
          durationMs: Date.now() - start,
        })
        throw err
      }
    },

    flush(): Promise<void> {
      return client.flush()
    },

    shutdown(): Promise<void> {
      return client.shutdown()
    },
  }
}

type AnyHandler = (...args: unknown[]) => unknown

// Minimal duck-typed interface for the private McpServer internals we access.
interface McpServerInternals {
  tool: (...args: unknown[]) => unknown
  registerTool: (name: string, config: unknown, cb: AnyHandler) => unknown
  _registeredTools?: Record<string, { handler: AnyHandler }>
}

/**
 * Instrument a {@link McpServer} with Doclight observability in two lines.
 *
 * Monkey-patches `server.tool()` and `server.registerTool()` so every handler
 * — registered **before or after** this call — is automatically wrapped with a
 * Doclight session that records duration and outcome for every tool invocation.
 *
 * ```ts
 * const server = new McpServer({ name: "my-server", version: "1.0.0" })
 *
 * withDoclight(server, {
 *   apiKey: process.env.DOCLIGHT_API_KEY!,
 *   projectId: process.env.DOCLIGHT_PROJECT_ID!,
 * })
 *
 * // All tools registered below are automatically instrumented:
 * server.tool("my_tool", { q: z.string() }, async ({ q }) => { ... })
 * ```
 *
 * Returns the same server instance so the call can be chained.
 */
export function withDoclight(
  server: McpServer,
  config: DoclightMcpConfig,
): McpServer {
  const mcp = createDoclightMcp(config)
  const srv = server as unknown as McpServerInternals

  function wrapHandler(toolName: string, handler: AnyHandler): AnyHandler {
    return async (...args: unknown[]) => {
      const sessionId = mcp.startSession(toolName)
      try {
        const result = await mcp.trackTool(
          toolName,
          sessionId,
          () => handler(...args) as Promise<unknown>,
        )
        mcp.endSession(sessionId, "success")
        return result
      } catch (err) {
        mcp.endSession(sessionId, "failed")
        throw err
      }
    }
  }

  // Wrap handlers that were registered BEFORE this call.
  if (srv._registeredTools) {
    for (const [toolName, registered] of Object.entries(srv._registeredTools)) {
      registered.handler = wrapHandler(toolName, registered.handler)
    }
  }

  // Intercept tool() so handlers registered AFTER this call are wrapped too.
  // All overloads share the same shape: (name, ...rest, handler) — name first,
  // handler last.
  const origTool = srv.tool.bind(server)
  srv.tool = (...args: unknown[]) => {
    const toolName = args[0] as string
    const lastIdx = args.length - 1
    args[lastIdx] = wrapHandler(toolName, args[lastIdx] as AnyHandler)
    return origTool(...args)
  }

  // Also intercept the newer registerTool(name, config, cb) API.
  const origRegisterTool = srv.registerTool.bind(server)
  srv.registerTool = (name: string, config: unknown, cb: AnyHandler) => {
    return origRegisterTool(name, config, wrapHandler(name, cb))
  }

  return server
}
