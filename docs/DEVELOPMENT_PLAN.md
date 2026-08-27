# Development Plan

## V0.1

V0.1 includes the Activity Bar chat, new and resumed sessions, continuous conversation, assistant streaming, tool-call status and results, workspace context, cancellation, allow/reject approval, and runtime restart/error reporting.

## Deferred

Subagent UI, MCP marketplace, memory management, remote agents, cloud sync, collaboration, voice, workflow design, inline completion, automatic pull requests, and durable allow-list policies remain outside V0.1.

## Verification

The release path runs TypeScript strict checking, adapter/mapper unit tests, Python SDK tests, production builds, a keyless JSON-RPC process smoke test, and manual Extension Development Host validation. Real-model testing additionally requires `DEEPSEEK_API_KEY`.
