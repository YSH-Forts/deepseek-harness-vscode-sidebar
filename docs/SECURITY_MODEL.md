# Security Model

The Harness runtime is the authority for workspace access, tool execution, sandbox policy, approval, model access, sessions, and credentials.

| Capability | Policy |
|---|---|
| Read | Allowed according to Harness policy. |
| Write | Enforced by the Harness workspace sandbox. |
| Execute | Harness requests approval when required. |
| Destructive | Harness requests approval and fails closed without an answer. |

The Webview has no Node.js access and cannot read files, execute a shell, or call Harness. Its messages are a closed TypeScript union handled by the Extension Host. The Extension Host does not execute model-authored commands or apply model-authored patches; these operations remain Harness tools.

## Credentials

The settings UI can submit a DeepSeek API key as an explicit one-shot intent. The value is forwarded to `credentials/set` and stored by Harness in `~/.dsh/.credentials.yaml` with directory mode `0700` and file mode `0600`.

The key is never:

- returned by a status API;
- stored in Webview state, extension global state, or VS Code settings;
- added to session events or model context;
- written to extension/runtime diagnostic logs.

Only `configured`, `writable`, and non-secret source metadata return to the Webview. An environment-provided key is read-only and cannot be shadowed by a stored value.

## Editor context

Current file path, cursor, selection, tabs, diagnostics, Git diff, and explicit attachments may be sent as model context. Current file content is not automatically copied. Explicit attached content is limited to 96 KiB per item, Git diff to 64 KiB, and diagnostics to 100 entries.
