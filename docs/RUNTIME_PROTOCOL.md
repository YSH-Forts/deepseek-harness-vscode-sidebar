# Runtime Protocol

The extension launches `dsh-py sdk` and exchanges one JSON-RPC 2.0 object per UTF-8 line. Stdout is protocol-only and diagnostics use stderr.

## Requests

| Method | Purpose |
|---|---|
| `initialize` | Select workspace/provider/model and verify runtime identity. |
| `session/list` | List persisted top-level sessions for the initialized workspace. |
| `session/history` | Create or resume a session and return durable native events. |
| `session/status` | Recover current `idle`/`running` state. |
| `session/prompt` | Durably admit one user message. |
| `session/cancel` | Cancel current work and queued input. |
| `session/steer` | Admit an adaptive instruction. |
| `approval/list` | Recover answerable pending approvals. |
| `approval/respond` | Resolve a pending approval. |
| `credentials/describe` | Return DeepSeek key status without the value. |
| `credentials/set` | Store a new DeepSeek API key in Harness credential storage. |
| `credentials/unset` | Remove the stored DeepSeek API key. |
| `shutdown` | Flush, dispose, and stop the owned runtime. |

## Notifications

- `session.event`: one authoritative durable Harness event.
- `session.status`: whole-session `idle` or `running` state.
- `approval.requested`: one answerable approval with opaque approval id.

Unknown native events are ignored only by presentation; Harness retains the complete validated log. Runtime shutdown resolves unanswered approvals as unavailable. Transport loss never implies permission.

## Compatibility

- Runtime identity: `deepseek-harness-sdk-runtime`
- Protocol version: `0.1.0`
- Pinned Harness baseline: repository commit `b659117aaf78c6103ed1bec32dce5b7915320445` plus the SDK additions in this workspace.
