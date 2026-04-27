# Security Policy

Claude Messenger is a community front-end for the Claude Agent SDK. We
take security seriously, especially around credentials and IPC isolation.

## Reporting a vulnerability

Please **do not** open public GitHub issues for security reports.
Instead, email the maintainer privately or use GitHub's private security
advisory feature on this repository:

  https://github.com/Twinded/claude-messenger/security/advisories

We aim to acknowledge reports within 7 days.

## Scope

In scope:

- Anthropic API key exposure or leakage outside the OS keychain
- IPC channels that could be abused by a compromised renderer
- URL validation bypasses in `electron/security.ts`
- Path traversal in file-saving handlers
- Code injection via crafted MCP server configurations

Out of scope:

- Vulnerabilities in upstream Anthropic services or in the
  `@anthropic-ai/claude-agent-sdk` package itself — please report those
  directly to Anthropic.
- Issues that require an attacker to already have full local OS access.

## Hardening checklist

- The renderer runs sandboxed with `contextIsolation: true`,
  `nodeIntegration: false`, and `sandbox: true`.
- Only allowlisted IPC channels are exposed via `contextBridge`.
- External URL navigation is filtered by `isSafeExternalUrl()` to a
  small set of Anthropic, GitHub, and npm hosts.
- API keys are stored in the OS keychain via `keytar` and never sent to
  the renderer.
- The Anthropic OAuth credentials at `~/.claude/.credentials.json` are
  read-only — Claude Messenger never writes to that file.
