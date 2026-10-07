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
  /** Flush all buffered events immediately. Never rejects. */
  flush(): Promise<void>
  /** Flush and shut down the underlying transport. Never rejects. */
  shutdown(): Promise<void>
}

/** Maximum events the ingest backend accepts in one batch request. */
export const MAX_INGEST_BATCH_EVENTS = 500

function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // Telemetry must never change application behavior.
  }
}

function errorClass(err: unknown): string {
  if (err instanceof Error && err.name) return err.name
  return "UnknownError"
}

/** MCP reports tool failures as a result with `isError: true` instead of throwing. */
function isErrorResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  )
}

/**
 * Create a Doclight context pre-wired for MCP server instrumentation.
 *
 * Lifecycle hooks are **disabled** by default so the MCP server process owns
 * its own shutdown sequence. Pass `lifecycleHooks: true` to re-enable them.
 *
 * Telemetry is best effort: no method here throws or rejects because of a
 * telemetry failure, and nothing is ever written to stdout (stdio-safe).
 * `transport.batchSize` counts events (about 3 per tool call) and must not
 * exceed {@link MAX_INGEST_BATCH_EVENTS}.
 */
export function createDoclightMcp(
  config: DoclightMcpConfig,
): DoclightMcp {
  const batchSize = config.transport?.batchSize
  if (batchSize !== undefined && batchSize > MAX_INGEST_BATCH_EVENTS) {
    throw new RangeError(
      `transport.batchSize (${batchSize}) exceeds the ingest limit of ${MAX_INGEST_BATCH_EVENTS} events per batch`,
    )
  }
  const client = createDoclight({ lifecycleHooks: false, ...config })

  return {
    client,

    startSession(goal?: string): string {
      return client.startSession(goal)
    },

    endSession(sessionId: string, outcome: ToolOutcome): void {
      safely(() => client.endSession(sessionId, outcome))
    },

    async trackTool<T>(
      toolName: string,
      sessionId: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      const start = Date.now()
      let result: T
      try {
        result = await fn()
      } catch (err) {
        const durationMs = Date.now() - start
        safely(() => {
          client.trackToolCall({
            sessionId,
            toolName,
            status: "failed",
            durationMs,
            errorType: errorClass(err),
          })
        })
        throw err
      }
      const failed = isErrorResult(result)
      const durationMs = Date.now() - start
      safely(() => {
        client.trackToolCall({
          sessionId,
          toolName,
          status: failed ? "failed" : "success",
          durationMs,
          ...(failed ? { errorType: "ToolErrorResult" } : {}),
        })
      })
      return result
    },

    async flush(): Promise<void> {
      try {
        await client.flush()
      } catch {
        // best effort
      }
    },

    async shutdown(): Promise<void> {
      try {
        await client.shutdown()
      } catch {
        // best effort
      }
    },
  }
}

type AnyHandler = (...args: unknown[]) => unknown

// Minimal duck-typed interface for the McpServer internals we access.
interface McpServerInternals {
  tool: (...args: unknown[]) => unknown
  registerTool: (name: string, config: unknown, cb: AnyHandler) => unknown
  _registeredTools?: Record<string, { handler: unknown }>
}

const WRAPPED = Symbol.for("@doclight/mcp.wrapped")
const instrumented = new WeakMap<object, DoclightMcp>()

/**
 * Return the {@link DoclightMcp} context attached to a server by
 * {@link withDoclight}, e.g. to `flush()` / `shutdown()` it. `undefined` if the
 * server was never instrumented.
 */
export function getDoclightMcp(server: McpServer): DoclightMcp | undefined {
  return instrumented.get(server)
}

/**
 * Instrument a {@link McpServer} with Doclight observability.
 *
 * Wraps handlers registered through `server.tool()` and
 * `server.registerTool()` — both those registered **before** and **after**
 * this call. Each invocation records one session with its duration and
 * success/failed outcome (thrown errors and MCP `isError: true` results both
 * count as failed). Arguments, results and error messages are never captured.
 *
 * Calling `withDoclight` again on the same server is a no-op: the server keeps
 * its first instrumentation and the original `config` of that call.
 *
 * Ownership: this function does not register signal handlers. The caller owns
 * shutdown and should `await getDoclightMcp(server)?.shutdown()` before exit.
 *
 * Limitations: handlers swapped later via `registeredTool.update({ callback })`
 * or task-based tools (`registerToolTask`) are not wrapped.
 *
 * Compatibility: tested against `@modelcontextprotocol/sdk` ^1.12 (peer range
 * `>=1.12.0`); it relies on the `McpServer` internals `_registeredTools`,
 * `tool` and `registerTool`. The low-level `Server` class is not supported.
 */
export function withDoclight(
  server: McpServer,
  config: DoclightMcpConfig,
): McpServer {
  if (instrumented.has(server)) return server

  const srv = server as unknown as McpServerInternals
  if (
    typeof srv.tool !== "function" ||
    typeof srv.registerTool !== "function"
  ) {
    throw new TypeError(
      "withDoclight expects an McpServer (the low-level Server class is not supported)",
    )
  }

  const mcp = createDoclightMcp(config)
  instrumented.set(server, mcp)

  function wrapHandler(toolName: string, handler: AnyHandler): AnyHandler {
    if (typeof handler !== "function") return handler
    if ((handler as unknown as Record<symbol, unknown>)[WRAPPED]) return handler

    const wrapped = function (this: unknown, ...args: unknown[]) {
      let sessionId: string | undefined
      safely(() => {
        sessionId = mcp.startSession(toolName)
      })
      if (sessionId === undefined) return handler.apply(this, args)
      const sid = sessionId
      return mcp
        .trackTool(toolName, sid, async () => handler.apply(this, args))
        .then(
          (result) => {
            mcp.endSession(sid, isErrorResult(result) ? "failed" : "success")
            return result
          },
          (err: unknown) => {
            mcp.endSession(sid, "failed")
            throw err
          },
        )
    }
    Object.defineProperty(wrapped, WRAPPED, { value: true })
    return wrapped
  }

  // Wrap handlers that were registered BEFORE this call.
  if (srv._registeredTools) {
    for (const [toolName, registered] of Object.entries(srv._registeredTools)) {
      registered.handler = wrapHandler(toolName, registered.handler as AnyHandler)
    }
  }

  // Intercept tool() so handlers registered AFTER this call are wrapped too.
  // All overloads share the same shape: (name, ...rest, handler) — name first,
  // handler last.
  const origTool = srv.tool.bind(server)
  srv.tool = (...args: unknown[]) => {
    const lastIdx = args.length - 1
    if (lastIdx >= 1 && typeof args[0] === "string") {
      args[lastIdx] = wrapHandler(args[0], args[lastIdx] as AnyHandler)
    }
    return origTool(...args)
  }

  // Also intercept the newer registerTool(name, config, cb) API.
  const origRegisterTool = srv.registerTool.bind(server)
  srv.registerTool = (name: string, toolConfig: unknown, cb: AnyHandler) =>
    origRegisterTool(name, toolConfig, wrapHandler(name, cb))

  return server
}
