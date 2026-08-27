# ADR-004: Compact Harness Webview

Status: accepted

## Decision

Implement a compact React client that follows Harness Web's design tokens and interaction semantics instead of embedding the complete browser application.

The view provides session selection, Markdown conversation rendering, reasoning disclosure, tool rows, approval cards, context attachments, runtime recovery, and a Models/API Key settings page. It uses VS Code theme variables so the Harness visual language remains legible inside any editor theme.

## Consequences

The sidebar stays simple and native to VS Code. Pixel identity with the full-width browser shell is not expected, but core components and behavior remain recognizably consistent.
