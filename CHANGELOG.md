## Unreleased

- `withDoclight` is idempotent per server, skips non-function handlers, preserves `this`/arguments/results/errors and isolates telemetry failures.
- MCP `isError: true` results are recorded as `failed`; error messages are never captured (class name only).
- Added `getDoclightMcp(server)` for flush/shutdown ownership; `flush()`/`shutdown()` never reject.
- `createDoclightMcp` rejects `transport.batchSize` above the 500-event ingest limit.
- Peer range tightened to `@modelcontextprotocol/sdk >=1.12.0`; README now documents `McpServer` only.
