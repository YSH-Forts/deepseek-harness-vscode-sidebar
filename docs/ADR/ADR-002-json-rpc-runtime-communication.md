# ADR-002: JSON-RPC over stdio

Status: accepted

## Decision

Launch one Harness child process per VS Code workspace and exchange JSON-RPC 2.0 frames over newline-delimited UTF-8 stdio. Stdout is protocol-only; stderr is diagnostic-only.

## Consequences

The transport is local, does not require ports, and works with a bundled executable. Requests are validated at both ends, have bounded timeouts, and fail closed on transport loss. Protocol compatibility is identified during `initialize`.
