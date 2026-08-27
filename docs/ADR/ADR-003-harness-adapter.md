# ADR-003: Harness Adapter

Status: accepted

## Decision

All Extension Host business code depends on `HarnessAdapter`; only `DeepSeekHarnessAdapter` knows JSON-RPC method names and native Harness event shapes.

The adapter exposes sessions, history, status, prompt admission, cancellation, steering, approvals, and credential status. Native events are translated into the stable `HarnessEvent` union.

## Consequences

Harness protocol changes are localized. UI code remains testable and cannot accidentally import runtime internals.
