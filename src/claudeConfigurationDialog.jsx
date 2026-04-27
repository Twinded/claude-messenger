/**
 * Auth and model configuration dialog. Replaces codexConfigurationDialog.jsx.
 *
 * Lets the user pick between reusing existing Claude Code OAuth credentials
 * (when ~/.claude/.credentials.json is present) or storing an Anthropic
 * API key in the OS keychain. Also exposes the default model and
 * permission mode.
 */

import { useEffect, useState } from "react";

const SUPPORTED_MODELS = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }
];

const PERMISSION_MODES = [
  { id: "default", label: "Default — ask for risky tools" },
  { id: "acceptEdits", label: "Accept file edits automatically" },
  { id: "plan", label: "Plan mode — read-only" },
  { id: "bypassPermissions", label: "Bypass all permissions (advanced)" }
];

export function ClaudeConfigurationDialog({ onClose }) {
  const api = window.claudeMsn;
  const [authStatus, setAuthStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.authStatus(), api.getSettings()]).then(([status, current]) => {
      if (cancelled) return;
      setAuthStatus(status);
      setSettings(current);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!authStatus || !settings) {
    return (
      <div className="claude-config-dialog">
        <p>Chargement…</p>
      </div>
    );
  }

  async function handleUseOauth() {
    setBusy(true);
    setError("");
    try {
      await api.signIn({ mode: "oauth-claude" });
      const next = await api.authStatus();
      setAuthStatus(next);
      onClose?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleStoreApiKey() {
    if (!apiKeyDraft.trim()) {
      setError("Saisis une clé API Anthropic.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.signIn({ mode: "api-key", apiKey: apiKeyDraft.trim() });
      const next = await api.authStatus();
      setAuthStatus(next);
      setApiKeyDraft("");
      onClose?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    setError("");
    try {
      await api.signOut();
      const next = await api.authStatus();
      setAuthStatus(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function patchSettings(patch) {
    setBusy(true);
    setError("");
    try {
      const next = await api.setSettings(patch);
      setSettings(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="claude-config-dialog" role="dialog" aria-label="Claude Messenger settings">
      <h2>Claude Messenger</h2>

      <section>
        <h3>Authentification</h3>
        <p className="muted">Mode actuel : <strong>{authStatus.mode}</strong></p>
        {authStatus.hasOauthCredentials ? (
          <button type="button" onClick={handleUseOauth} disabled={busy}>
            Utiliser les identifiants Claude Code (~/.claude)
          </button>
        ) : (
          <p className="muted">Aucune session Claude Code détectée localement.</p>
        )}

        <div className="api-key-row">
          <label htmlFor="anthropic-api-key">Clé API Anthropic</label>
          <input
            id="anthropic-api-key"
            type="password"
            placeholder="sk-ant-..."
            value={apiKeyDraft}
            onChange={(event) => setApiKeyDraft(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" onClick={handleStoreApiKey} disabled={busy}>
            Enregistrer dans le trousseau
          </button>
        </div>

        {(authStatus.hasStoredApiKey || authStatus.mode === "api-key") && (
          <button type="button" onClick={handleSignOut} disabled={busy} className="danger">
            Effacer la clé enregistrée
          </button>
        )}
      </section>

      <section>
        <h3>Modèle par défaut</h3>
        <select
          value={settings.defaultModel}
          onChange={(event) => patchSettings({ defaultModel: event.target.value })}
          disabled={busy}
        >
          {SUPPORTED_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </section>

      <section>
        <h3>Permissions sur les outils</h3>
        <select
          value={settings.permissionMode}
          onChange={(event) => patchSettings({ permissionMode: event.target.value })}
          disabled={busy}
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </section>

      {error && <p className="error">{error}</p>}

      <footer>
        <button type="button" onClick={onClose} disabled={busy}>
          Fermer
        </button>
      </footer>
    </div>
  );
}

export default ClaudeConfigurationDialog;
