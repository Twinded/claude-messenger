# Plan d'implémentation — claude-messenger

> Réimplémentation indépendante de [codex-messenger](https://github.com/anisayari/codex-messenger) avec le **Claude Agent SDK** comme backend. Conservation totale de l'UI MSN Messenger 7, remplacement intégral de la couche Codex/OpenAI par Anthropic.

## Objectifs

1. Conserver 100 % de l'expérience visuelle/sonore MSN du projet upstream
2. Remplacer `codex app-server` (sous-process JSON-RPC) par le **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) en TypeScript strict
3. Mapper les concepts MSN sur les primitives Claude (subagents, skills, MCPs, sessions resumable)
4. Auth conforme : OAuth Claude Code existante OU clé API Anthropic via Keychain/Credential Manager
5. Aucun hijack de l'installation Claude Code de l'utilisateur (lecture seule)

## Inventaire upstream (codex-messenger)

Cartographie issue de l'analyse du repo cloné dans `~/www/codex-messenger/` :

```
codex-messenger/
├── electron/                 ← MAIN PROCESS (Node)
│   ├── codexAppServerClient.js   403 lignes  ★ cœur Codex à RÉÉCRIRE
│   ├── ipcHandlers.js                        ⚠ adapter (renommer canaux + payloads)
│   ├── main.js                                ⚠ adapter (bootstrap, références)
│   ├── notifications.js                       ⚠ adapter (références Codex)
│   ├── preload.cjs                            ⚠ adapter (canaux IPC renommés)
│   ├── security.js                            ✓ garder
│   ├── settingsStore.js                       ✓ garder (clé API, prefs)
│   ├── updateService.js                       ⚠ adapter (références dépôt GitHub)
│   └── windowManager.js                       ⚠ adapter (références Codex)
│
├── shared/                   ← partagé main/renderer
│   ├── codexAppServerClient.js  (côté shared utility)
│   ├── codexExecutable.js     26 ll          ✘ supprimer (SDK remplace)
│   ├── codexImages.js        104 ll           ⚠ adapter → claudeImages.ts
│   ├── codexOptions.js       103 ll           ✘ remplacer (options SDK différentes)
│   ├── codexSetup.js         223 ll           ✘ remplacer (auth/setup différent)
│   ├── languages.js                           ✓ garder (i18n)
│   ├── threadSelection.js                     ✓ garder (logique pure)
│   ├── updateAssets.js                        ⚠ adapter (assets de version)
│   └── versionUtils.js                        ✓ garder
│
├── src/                      ← RENDERER (React 19)
│   ├── chatParts.jsx                          ✓ garder
│   ├── chatTextStyle.js                       ✓ garder
│   ├── codexConfigurationDialog.jsx           ⚠ renommer + adapter champs
│   ├── composer.jsx                           ✓ garder
│   ├── gamesPanel.jsx                         ✓ garder
│   ├── i18n.js                                ⚠ adapter chaînes (Codex → Claude)
│   ├── main.jsx                               ⚠ adapter point d'entrée
│   ├── mediaPanels.jsx                        ✓ garder
│   ├── messageFormatting.jsx                  ✓ garder
│   ├── msnDisplayPictures.js                  ✓ garder
│   ├── msnEmoticons.js                        ✓ garder
│   ├── rosterUtils.js                         ⚠ adapter (groupes contacts)
│   ├── rosterView.jsx                         ⚠ adapter libellés
│   ├── soundEffects.js                        ✓ garder
│   ├── styles.css                             ✓ garder
│   ├── threadTabs.jsx                         ✓ garder
│   ├── updateDialog.jsx                       ⚠ adapter
│   ├── useCodexEvents.js     168 ll           ⚠ renommer → useClaudeEvents.ts
│   ├── usePromptDialog.jsx                    ✓ garder
│   ├── useUnreadState.js                      ✓ garder
│   ├── useUpdates.js                          ⚠ adapter (URLs releases)
│   ├── versionLabel.js                        ✓ garder
│   ├── windowChrome.jsx                       ✓ garder
│   └── winks.js                               ✓ garder
│
├── scripts/                  ← outillage
│   ├── bootstrap-codex-env.mjs                ✘ remplacer → bootstrap-claude-env
│   ├── check-codex.mjs                        ✘ remplacer → check-claude
│   ├── dev-electron.mjs                       ✓ garder
│   ├── electron-builder-release-version.mjs   ⚠ adapter (env var)
│   ├── package-mac-release.mjs                ⚠ adapter (signing)
│   └── release-check.mjs                      ⚠ adapter (versions)
│
├── public/                   ← assets MSN
│   └── (sons, icônes, GIFs, emoticons, winks) ✓ tout garder (vendor)
│
├── launchers/                                  ⚠ adapter noms
├── codexmessenger.net/                         ✘ ne pas porter (site landing)
├── tests/                                      ⚠ adapter
└── build/                                      ⚠ adapter (icônes, metadata)
```

**Bilan quantitatif** :

| Catégorie | Lignes | Action |
|---|---:|---|
| À garder tel quel (UI MSN, assets, sons, helpers purs) | ~8 500 | Copie + vendor |
| À adapter (renommage Codex → Claude, libellés i18n, refs URL) | ~2 000 | Refactor |
| À réécrire entièrement (couche Codex/OpenAI → SDK Anthropic) | ~1 100 | Code neuf TS |
| À supprimer (landing site, scripts setup Codex) | ~600 | — |
| **Total** | **~12 200** | |

## Phasage de l'implémentation

### Phase 0 — Scaffolding (DONE — ce commit)

- [x] `git init`, `LICENSE` MIT avec attribution upstream, `.gitignore`
- [x] `README.md` avec disclaimer fair-use Anthropic
- [x] `CLAUDE.md` projet (conventions équipe)
- [x] `IMPLEMENTATION_PLAN.md` (ce fichier)
- [ ] `package.json` initial (TS, Electron 41, React 19, SDK Anthropic)
- [ ] `tsconfig.json` strict pour `electron/` et `shared/`
- [ ] `vite.config.ts` pour le renderer
- [ ] Repo GitHub public `Twinded/claude-messenger` créé + push

### Phase 1 — Vendor des assets et UI MSN (1-2 jours)

Stratégie : **copier les fichiers à conserver** depuis `~/www/codex-messenger/`, sans dépendance vers le repo upstream. Les fichiers conservés seront tagués dans un commit séparé `chore: import MSN assets and UI from codex-messenger (MIT)`.

1. Copier `public/` intégralement (sons, icônes, MSN packs, winks, emoticons)
2. Copier les composants UI listés `✓ garder` ci-dessus
3. Copier `index.html`, `vite.config.js` (à migrer en `.ts`)
4. Sauvegarder le `LICENSE` upstream sous `vendor/codex-messenger/LICENSE` + `NOTICE`
5. Premier commit : `chore: vendor MSN UI and assets from codex-messenger`

### Phase 2 — Migration TypeScript main process (2-3 jours)

1. `electron/main.js` → `electron/main.ts` (bootstrap, BrowserWindow, security)
2. `electron/preload.cjs` → `electron/preload.ts` avec contextBridge typé
3. `electron/security.js` → `electron/security.ts`
4. `electron/settingsStore.js` → `electron/settingsStore.ts` (zod-validated schema)
5. `electron/windowManager.js` → `electron/windowManager.ts`
6. Définir `shared/types.ts` : `Contact`, `Thread`, `Message`, `IpcChannel`, etc.
7. Setup `tsconfig.json` strict + `npm run typecheck`

### Phase 3 — Backend Claude Agent SDK (3-5 jours) ★

**Le morceau central.**

`electron/claudeAgentClient.ts` (remplace `codexAppServerClient.js`) :

```typescript
import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";

export class ClaudeAgentClient extends EventEmitter {
  private sessions = new Map<ContactId, SessionHandle>();

  async startSession(contact: Contact, options: SessionOptions): Promise<SessionHandle> {
    const handle: SessionHandle = {
      contactId: contact.id,
      sessionId: options.resumeSessionId,
      stream: query({
        prompt: this.makeAsyncIterablePrompt(),
        options: {
          model: contact.model ?? "claude-sonnet-4-6",
          systemPrompt: contact.systemPrompt,
          mcpServers: contact.mcpConfig,
          allowedTools: contact.allowedTools,
          permissionMode: "default",
          cwd: contact.workingDirectory,
          resume: options.resumeSessionId,
          settingSources: ["user", "project"],
          // Plus tout le reste documenté du SDK
        },
      }),
    };
    this.sessions.set(contact.id, handle);
    this.consumeStream(handle); // pousse les SDKMessage vers EventEmitter
    return handle;
  }

  async sendMessage(contactId: ContactId, text: string): Promise<void> { /* ... */ }
  async interrupt(contactId: ContactId): Promise<void> { /* ... */ }
  async closeSession(contactId: ContactId): Promise<void> { /* ... */ }
}
```

**Sous-modules à créer** :

| Fichier | Rôle | Lignes estimées |
|---|---|---:|
| `electron/claudeAgentClient.ts` | Client SDK principal, gestion des sessions | ~400 |
| `electron/contactRegistry.ts` | Découverte des subagents/skills/projets | ~250 |
| `electron/threadStore.ts` | Persistence SQLite (better-sqlite3) | ~200 |
| `electron/authBridge.ts` | OAuth Claude / API key + keytar | ~150 |
| `electron/skillsWatcher.ts` | Watch `~/.claude/skills/` (chokidar) | ~80 |
| `electron/agentsWatcher.ts` | Watch `~/.claude/agents/` | ~80 |
| `electron/mcpConfigLoader.ts` | Lit `.claude/settings.json` projet | ~120 |
| `shared/claudeOptions.ts` | Types et défauts SDK | ~80 |
| `shared/claudeSetup.ts` | Détection install + auth status | ~100 |
| **Total backend** | | **~1 460** |

### Phase 4 — IPC handlers et renderer (2-3 jours)

1. `electron/ipcHandlers.ts` : canaux renommés `codex:*` → `claude:*`, payloads typés via `shared/types.ts`
2. `src/useCodexEvents.js` → `src/useClaudeEvents.ts` (hooks React typés)
3. `src/codexConfigurationDialog.jsx` → `src/claudeConfigurationDialog.jsx` (champs : modèle, clé API, MCP, permissions)
4. Adapter `src/i18n.js` : recherche/remplace "Codex" → "Claude" + chaînes spécifiques (login Anthropic, OAuth)
5. Adapter `src/rosterView.jsx`, `src/rosterUtils.js` : nouveaux groupes "Subagents", "Skills", "Projets", "MCP"

### Phase 5 — Auth + onboarding (1-2 jours)

1. Premier lancement : détecter `~/.claude/.credentials.json` → proposer reuse OAuth
2. Sinon, formulaire clé API (`ANTHROPIC_API_KEY`) → stocker via `keytar`
3. Bouton "Test connexion" qui ping `claude-haiku-4-5` (1 token)
4. Status bar : compteur tokens session (via SDKMessage `usage`)

### Phase 6 — Packaging et release (1 jour)

1. Adapter `package.json` `build.appId` → `com.twinded.claude-messenger`
2. Adapter `productName` → `Claude Messenger`
3. Icônes : générer depuis le branding du projet (placeholder pour l'instant)
4. CI GitHub Actions : ports les workflows upstream (`ci.yml`, `codeql.yml`, `dependency-review.yml`) en supprimant les références Codex
5. Premier release `v0.0.1-alpha` avec `.dmg` et `.exe` non signés

### Phase 7 — Tests et polish (continu)

- `tests/agentClient.test.mts` avec mock du SDK
- `tests/contactRegistry.test.mts`
- E2E Playwright sur les flows principaux (déjà configuré upstream)

## Estimation totale

| Phase | Jours dev solo |
|---|---:|
| 0 — Scaffolding | 0,5 (en cours) |
| 1 — Vendor UI/assets | 1-2 |
| 2 — Migration TS main | 2-3 |
| 3 — Backend SDK ★ | 3-5 |
| 4 — IPC + renderer | 2-3 |
| 5 — Auth onboarding | 1-2 |
| 6 — Packaging | 1 |
| 7 — Tests/polish | continu |
| **Total MVP** | **~12-17 jours** |

## Conformité Anthropic

- ✅ Usage exclusif du SDK officiel (`@anthropic-ai/claude-agent-sdk`)
- ✅ Pas d'interception réseau, pas de scraping, pas de reverse-engineering du protocole Claude Code
- ✅ Disclaimer "non affilié à Anthropic" dans README, About, et premier lancement
- ✅ Nominative fair use du nom "Claude" (jamais comme nom principal de l'app sur les stores/sites tiers — toujours "Claude Messenger" ou "for Claude")
- ✅ Lecture seule de `~/.claude/` (jamais d'écriture, jamais de modification de la config Claude Code de l'utilisateur)
- ✅ Stockage sécurisé des secrets via Keychain/Credential Manager
- ✅ Aucune clé API exposée au renderer ou loggée

## Risques identifiés

1. **⚠ SDK shape à valider contre la version réelle** : `electron/claudeAgentClient.ts` définit `SdkModuleShape` et l'union `SDKMessage` (avec les types `system/assistant/result/stream_event`) à partir d'une lecture de la documentation et de mémoire. **Un audit indépendant a flaggé ce point comme bloqueur** : tant que le client n'a pas été exécuté contre `@anthropic-ai/claude-agent-sdk` réel, considérer que la signature `query()`, le format des messages SDK retournés, et la callback `canUseTool` peuvent diverger. Premier travail de Phase 5+ : `npm install @anthropic-ai/claude-agent-sdk@latest` puis aligner les types et le `handleSdkMessage` switch sur la vraie API.
2. **Évolution du SDK Anthropic** : le SDK est jeune, des breaking changes sont possibles. Mitigation : pin de version stricte, suivi du changelog.
2. **Skills/MCP en lecture-seule** : si la structure de `~/.claude/skills/` change, le watcher casse. Mitigation : parser tolérant + fallback.
3. **Branding Anthropic** : risque si on est trop visible. Mitigation : disclaimer omniprésent, pas de logo Anthropic, naming prudent.
4. **Performance multi-sessions** : plusieurs `query()` simultanés en mémoire. Mitigation : LRU sur les sessions inactives, pause/resume sur fermeture de fenêtre.
5. **Coût API** : un utilisateur qui laisse 5 contacts ouverts en streaming peut bruler vite. Mitigation : compteur visible, paramètre `max_thinking_tokens` raisonnable, alertes.

## Prochaines étapes immédiates

1. ✅ Créer le repo public `Twinded/claude-messenger`
2. ✅ Push initial avec scaffolding (ce commit)
3. ⏭ Phase 1 : vendor de l'UI MSN depuis codex-messenger (commit séparé)
4. ⏭ Phase 2 : migration TypeScript main process
