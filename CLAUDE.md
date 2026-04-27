# claude-messenger — Instructions Claude Code

Client desktop Electron style MSN Messenger 7 pour piloter Claude via le Claude Agent SDK officiel. Réimplémentation indépendante de [codex-messenger](https://github.com/anisayari/codex-messenger) (MIT, Anis AYARI) — l'UI/UX et les assets MSN sont conservés, le backend Codex est entièrement remplacé par le SDK Anthropic.

## Stack

- **Electron 41+** main process en **TypeScript strict** (vs JS pur côté upstream — choix Claude Messenger)
- **Renderer** : React 19 + Vite (gardé tel quel)
- **Backend Claude** : `@anthropic-ai/claude-agent-sdk` (TS) — pas de spawn de `claude` CLI
- **Storage local** : `better-sqlite3` pour transcripts/threads, `keytar` pour secrets
- **Packaging** : `electron-builder` (gardé tel quel)
- **Tests** : `node --test`

## Conventions

- **Langue** : français (UI par défaut + commits + communication)
- **Commits** : Conventional Commits français (`feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`)
- **Pas de README générés** sauf si demandé (sauf le README racine déjà initialisé)
- **TypeScript strict** côté `electron/` et `shared/` ; le renderer reste en JS/JSX (cohérent avec upstream tant qu'on ne touche pas)
- **Avatars Discord obligatoires** côté UI (règle workspace ~/www)

## Règles d'architecture

1. **Aucune clé API exposée au renderer.** Toute communication Anthropic passe par le main process via IPC.
2. **Pas de hijack de Claude Code.** Lecture seule de `~/.claude/skills/`, `~/.claude/agents/`, `~/.claude/.credentials.json`. Jamais d'écriture dans `~/.claude/`.
3. **1 contact = 1 session SDK.** L'`AgentSessionManager` mappe `contactId → query() session` avec resume via `sessionId` persisté en SQLite.
4. **Skills auto-découvertes.** Le `FileWatcher` regarde `~/.claude/skills/*/SKILL.md` et expose chaque skill comme contact dans le groupe "Skills".
5. **MCPs par contact.** Chaque contact peut avoir une config MCP propre (chargée dans le `query()` correspondant).

## Mapping codex-messenger → claude-messenger

Voir [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) pour le mapping fichier par fichier.

## Vérifications avant commit

- TypeScript : `npx tsc -b`
- Tests : `npm test`
- Lint : `npm run lint` (à mettre en place — eslint + prettier sur le main process)

## Sources de référence

- Code source upstream lecture seule : `~/www/codex-messenger/`
- Docs Claude Agent SDK : https://docs.anthropic.com/claude/docs/agents-and-tools/agent-sdk
- Brand Anthropic : https://www.anthropic.com/brand
