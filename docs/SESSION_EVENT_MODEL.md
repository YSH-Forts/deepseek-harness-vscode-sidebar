# Session Event Model

The UI is event-driven. `sendMessage` only queues input; responses arrive through notifications.

`HarnessEventMapper` converts `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `todo/write`, `turn/end`, status, and approval notifications into the extension-owned `HarnessEvent` union. React never imports Harness types. History replay and live streaming use the same mapper, preserving event ordering and avoiding separate rendering paths.

Assistant text and reasoning deltas are accumulated for display. Tool calls are correlated by `callId`. The durable final assistant message closes streaming presentation but is not duplicated when deltas already produced the visible response.
