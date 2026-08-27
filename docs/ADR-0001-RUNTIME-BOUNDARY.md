# ADR 0001: Out-of-process Harness runtime

Status: accepted

## Context

A coding agent needs long-running sessions, tools, sandbox policy, approvals, and durable event logs. Implementing these inside the VS Code Extension Host would duplicate Harness behavior and couple editor lifecycle to agent execution.

## Decision

The extension spawns the published Python SDK runtime and communicates over newline-delimited JSON-RPC stdio. VS Code-specific code depends on a local `HarnessAdapter`; protocol changes stop at `DeepSeekHarnessAdapter`. The extension adds only client-oriented protocol methods to the public SDK server and does not import Harness runtime internals.

## Alternatives considered

**Agent loop in the Extension Host.** Rejected because it duplicates session, tool, model, and sandbox behavior and can destabilize the host process.

**Embed the existing browser application.** Rejected because it couples VS Code to the HTTP/WebSocket host and weakens the explicit editor-context and process-ownership model.

**ACP bridge.** Rejected for V0.1 because the current bridge intentionally omits raw assistant chunks, durable history replay, and full tool presentation required by this UI.

## Consequences

Runtime crashes are isolated and restartable, Harness remains the sole execution authority, and future API changes are localized to the adapter. Deployment must provide a compatible `dsh-py` executable, and protocol version negotiation must be added before independently versioned releases diverge.
