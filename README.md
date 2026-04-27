# Claude Messenger

> MSN Messenger 7-inspired Electron desktop client for Claude — every Claude agent, project, or recent thread becomes a contact, every conversation a chat window.

**Status:** ⚠️ Work in progress — initial scaffolding.

This project is an independent reimplementation of [codex-messenger](https://github.com/anisayari/codex-messenger) by [Anis AYARI](https://github.com/anisayari), adapted to drive **Claude** (via the official [Claude Agent SDK](https://docs.anthropic.com/claude/docs/agents-and-tools/agent-sdk)) instead of OpenAI Codex. Original MSN-style UI, sounds, emoticons, and Electron scaffolding are reused under the upstream MIT license.

## Important disclaimer

Claude Messenger is **only a local front-end client** for the Claude Agent SDK and the Anthropic API. **It is not Claude itself**, is not affiliated with or endorsed by Anthropic, does not own your conversations, and should not be treated as a backup or storage layer for Claude data. Use it at your own risk, with your own Anthropic API key or Claude Code OAuth credentials.

"Claude" is a trademark of Anthropic. This project uses the name only in its nominative-fair-use form ("for Claude") and follows Anthropic's brand guidelines.

## Planned features

- Windows XP / MSN Messenger 7 inspired interface (preserved from upstream)
- One desktop window per Claude conversation
- Connection to the Claude Agent SDK from the Electron main process
- No API keys exposed to the renderer
- Multi-language UI (FR default, EN, ES, JP — preserved from upstream)
- Contacts for the main agent, subagents, local projects, custom agents, recent threads
- Auto-discovery of skills from `~/.claude/skills`
- Auto-discovery of subagents from `~/.claude/agents`
- MCP servers as configurable per-contact tools
- Streaming Claude responses
- MSN sounds for new messages, Wizz/Nudge, status changes
- Generated avatars for agents, projects, and conversations
- Demo mode with isolated showcase agents
- Skills and MCP groups in the contact list

## Architecture

See [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for the file-by-file roadmap.

```
┌─ Renderer (UI MSN, React 19) ──────────────────────────────┐
│  Conversations, contacts, wizz, sons, emoticons, skins…    │
└─────────────────────────▲──────────────────────────────────┘
                          │  IPC (electron preload, sandbox)
┌─────────────────────────▼──────────────────────────────────┐
│  Main process — Node + TypeScript                          │
│  ├─ AgentSessionManager (1 session par fenêtre/contact)    │
│  │     → @anthropic-ai/claude-agent-sdk: query()           │
│  ├─ ContactRegistry (subagents, skills, projets, MCPs)     │
│  ├─ AuthBridge (OAuth ~/.claude OU ANTHROPIC_API_KEY)      │
│  └─ FileWatcher (~/.claude/skills, ~/.claude/agents)       │
└─────────────────────────▲──────────────────────────────────┘
                          │
                  Anthropic Messages API officielle
                  (via Agent SDK, streaming SSE)
```

## Authentication

Two modes, in order of preference:

1. **Existing Claude Code OAuth** — if `~/.claude/.credentials.json` exists and is valid, Claude Messenger reuses it via the Agent SDK. No re-login required.
2. **Anthropic API key** — set `ANTHROPIC_API_KEY` in environment, or enter it in the in-app settings (stored in macOS Keychain / Windows Credential Manager via `keytar`, never in plain text and never exposed to the renderer).

## Credits

- **Original MSN-style client and assets:** [codex-messenger](https://github.com/anisayari/codex-messenger) by Anis AYARI (MIT)
- **MSN Messenger 7.5.0322 assets:** extracted from the archived Microsoft installer (legal status documented upstream)
- **Claude Agent SDK:** [Anthropic](https://docs.anthropic.com/claude/docs/agents-and-tools/agent-sdk)

## License

MIT — see [`LICENSE`](LICENSE). Original codex-messenger LICENSE is preserved at `vendor/codex-messenger/LICENSE` once vendored assets are imported.
