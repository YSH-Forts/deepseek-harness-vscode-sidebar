# ADR-001: VS Code and Runtime Boundary

Status: accepted

## Decision

VS Code owns editor integration, presentation, user intents, and child-process lifecycle. DeepSeek Harness owns the agent loop, sessions, tools, models, sandbox, approvals, credentials, and durable persistence.

The Webview cannot access Node.js, the filesystem, the shell, or Harness directly. Every operation crosses the typed Webview protocol and then `HarnessAdapter`.

## Consequences

Runtime behavior stays compatible with Harness and security policy remains authoritative in one process. The extension requires an adapter and wire protocol but does not fork the agent implementation.
