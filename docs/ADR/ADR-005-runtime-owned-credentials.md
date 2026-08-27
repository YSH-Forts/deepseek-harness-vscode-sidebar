# ADR-005: Runtime-owned credentials

Status: accepted

## Decision

The Webview may submit a new API key as a one-shot user intent. The Extension forwards it directly to the Harness runtime, which stores it through `CredentialRegistry` in `~/.dsh/.credentials.yaml` with owner-only permissions.

No API returns the secret. UI state contains only `configured`, `writable`, and `source`. The value is never written to extension logs, VS Code settings, global state, or session events.

## Consequences

The VS Code and Web clients share the same credential without duplicating secret storage. Environment-provided credentials remain read-only and cannot be shadowed through the UI.
