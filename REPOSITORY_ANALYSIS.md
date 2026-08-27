# DeepSeek Harness VS Code Repository Analysis

## Scope

The workspace contains three relevant projects:

- `deepseek-harness-python`: the Python Harness implementation and the runtime bundled by the extension.
- `deepseek-harness-master`: the upstream TypeScript Harness repository used as the Web UI and protocol reference.
- `deepseek-harness-vscode`: the VS Code client implemented in this workspace.

The first distributable target is macOS Apple Silicon. The VSIX embeds a PyInstaller `arm64` executable and communicates with it over newline-delimited JSON-RPC on stdio.

## Technology stack

| Layer | Technology |
|---|---|
| Extension Host | TypeScript, VS Code Extension API, esbuild |
| Webview | React 18, TypeScript, Vite, react-markdown |
| Runtime | Python 3, asyncio, DeepSeek Harness plugin graph |
| Transport | JSON-RPC 2.0, one UTF-8 object per line over stdio |
| Persistence | Harness session repository under `~/.dsh` |
| Credentials | Harness `CredentialRegistry` and owner-only `.credentials.yaml` |

## Harness integration points

- CLI entry: `deepseek_harness_py.cli`, command `sdk`.
- SDK server: `deepseek_harness_py.packages.sdk.sdk_server.HarnessSdkJsonRpcServer`.
- SDK protocol: `deepseek_harness_py.packages.sdk.sdk_protocol.JsonRpcLineTransport`.
- Agent loop: the runtime-provided `agents` service.
- Sessions: `SessionStore` plus `SessionQueryEngine` for persisted discovery.
- Approvals: the runtime-provided `ApprovalService` answerer chain.
- Credentials: `CredentialRegistry`, backed by `~/.dsh/.credentials.yaml`.

## Runtime startup

The extension starts `bin/dsh-py sdk`, reserves stdout for JSON-RPC, sends `initialize`, and waits for the runtime identity `deepseek-harness-sdk-runtime/0.1.0`. Stderr is routed to the `DeepSeek Harness Runtime` output channel.

## Session and event APIs

The VS Code adapter uses `session/list`, `session/history`, `session/status`, `session/prompt`, `session/cancel`, and `session/steer`. Durable native events are forwarded as `session.event`; transient running state is forwarded as `session.status`. Every native event crosses `HarnessEventMapper` before entering the Webview.

## Tool and approval APIs

Tools remain entirely inside Harness. The extension only presents `tool/call` and `tool/result`. Runtime approvals are exposed through `approval.requested`, recovered with `approval/list`, and answered with `approval/respond`.

## Reused code and design

The VS Code Webview reuses the upstream Web UI's design vocabulary, event grouping, Markdown presentation, reasoning disclosure, tool summary rows, model settings semantics, and credential storage behavior. It does not import the complete browser shell because that shell depends on workspace navigation, host remotes, browser routing, and modules that are inappropriate for a narrow VS Code view.

## Explicit non-goals for V0.1

Subagent UI, marketplace UI, remote agents, cloud sync, workflow design, inline completion, and automatic PR workflows remain outside this version.
