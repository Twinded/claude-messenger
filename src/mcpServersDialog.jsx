/**
 * MCP servers dialog. Lets the user list, add, edit, and remove
 * Model Context Protocol server entries persisted in the user-level
 * `~/.claude/settings.json` shared with the Claude Code CLI.
 *
 * Three transports are supported (matching Claude Agent SDK + CLI):
 *   - stdio: spawn a local command (npx, node, etc.) over stdin/stdout
 *   - sse:   subscribe to an HTTP/SSE endpoint
 *   - http:  call a JSON-RPC HTTP endpoint
 */

import { useEffect, useState } from "react";

const TRANSPORT_LABELS = {
  stdio: "Local (stdio)",
  sse: "HTTP/SSE",
  http: "HTTP/JSON-RPC"
};

const EMPTY_DRAFT = {
  name: "",
  type: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: ""
};

function configFromDraft(draft) {
  if (draft.type === "stdio") {
    const args = draft.args
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const env = {};
    for (const line of draft.env.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      env[line.slice(0, idx).trim()] = line.slice(idx + 1);
    }
    const config = { type: "stdio", command: draft.command };
    if (args.length) config.args = args;
    if (Object.keys(env).length) config.env = env;
    return config;
  }
  const headers = {};
  for (const line of draft.headers.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const config = { type: draft.type, url: draft.url };
  if (Object.keys(headers).length) config.headers = headers;
  return config;
}

function draftFromConfig(name, config) {
  if (config?.type === "stdio") {
    return {
      name,
      type: "stdio",
      command: config.command ?? "",
      args: Array.isArray(config.args) ? config.args.join("\n") : "",
      env: config.env
        ? Object.entries(config.env).map(([k, v]) => `${k}=${v}`).join("\n")
        : "",
      url: "",
      headers: ""
    };
  }
  return {
    name,
    type: config?.type ?? "http",
    command: "",
    args: "",
    env: "",
    url: config?.url ?? "",
    headers: config?.headers
      ? Object.entries(config.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
      : ""
  };
}

export function McpServersDialog({ onClose }) {
  const api = window.claudeMsn;
  const [servers, setServers] = useState({});
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      const list = await api.listMcpServers();
      setServers(list && typeof list === "object" ? list : {});
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function newServer() {
    setError("");
    setDraft({ ...EMPTY_DRAFT });
  }

  function editServer(name) {
    setError("");
    setDraft(draftFromConfig(name, servers[name]));
  }

  async function removeServer(name) {
    if (!window.confirm(`Supprimer le serveur MCP « ${name} » ?`)) return;
    setBusy(true);
    try {
      await api.removeMcpServer(name);
      await reload();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError("Le nom du serveur est requis.");
      return;
    }
    if (draft.type === "stdio" && !draft.command.trim()) {
      setError("La commande est requise pour un serveur stdio.");
      return;
    }
    if ((draft.type === "sse" || draft.type === "http") && !draft.url.trim()) {
      setError("L'URL est requise pour un serveur HTTP / SSE.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.saveMcpServer({ name: draft.name.trim(), config: configFromDraft(draft) });
      setDraft(null);
      await reload();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  const entries = Object.entries(servers);

  return (
    <div className="settings-dialog-backdrop">
      <div className="settings-dialog mcp-dialog">
        <header className="agent-editor-head">
          <h2>Serveurs MCP</h2>
          <button type="button" onClick={onClose} disabled={busy}>Fermer</button>
        </header>

        <p className="muted">
          Configuration utilisateur stockée dans <code>~/.claude/settings.json</code>. Partagée avec
          Claude Code CLI.
        </p>

        {entries.length === 0 ? (
          <p className="muted">Aucun serveur enregistré.</p>
        ) : (
          <ul className="mcp-list">
            {entries.map(([name, config]) => (
              <li key={name}>
                <div>
                  <strong>{name}</strong>
                  <small> · {TRANSPORT_LABELS[config?.type] ?? config?.type ?? "?"}</small>
                  <div className="muted">
                    {config?.type === "stdio"
                      ? `${config.command} ${(config.args ?? []).join(" ")}`.slice(0, 80)
                      : config?.url}
                  </div>
                </div>
                <div className="mcp-list-actions">
                  <button type="button" onClick={() => editServer(name)} disabled={busy}>
                    Éditer
                  </button>
                  <button type="button" onClick={() => removeServer(name)} disabled={busy} className="danger">
                    Supprimer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {!draft ? (
          <button type="button" onClick={newServer} className="msn-signin-button" disabled={busy}>
            ＋ Ajouter un serveur
          </button>
        ) : (
          <div className="mcp-form">
            <label className="msn-login-field">
              <span>Nom (clé)</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="my-mcp-server"
              />
            </label>

            <label className="msn-login-field">
              <span>Transport</span>
              <select
                value={draft.type}
                onChange={(event) => setDraft({ ...draft, type: event.target.value })}
              >
                {Object.entries(TRANSPORT_LABELS).map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </label>

            {draft.type === "stdio" ? (
              <>
                <label className="msn-login-field">
                  <span>Commande</span>
                  <input
                    value={draft.command}
                    onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                    placeholder="npx"
                  />
                </label>
                <label className="msn-login-field">
                  <span>Arguments (un par ligne)</span>
                  <textarea
                    rows={3}
                    value={draft.args}
                    onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                  />
                </label>
                <label className="msn-login-field">
                  <span>Variables d'environnement (KEY=value)</span>
                  <textarea
                    rows={3}
                    value={draft.env}
                    onChange={(event) => setDraft({ ...draft, env: event.target.value })}
                    placeholder="DEBUG=1"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="msn-login-field">
                  <span>URL</span>
                  <input
                    value={draft.url}
                    onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                    placeholder="https://example.com/mcp"
                  />
                </label>
                <label className="msn-login-field">
                  <span>Headers (Header: value)</span>
                  <textarea
                    rows={3}
                    value={draft.headers}
                    onChange={(event) => setDraft({ ...draft, headers: event.target.value })}
                    placeholder="Authorization: Bearer xxx"
                  />
                </label>
              </>
            )}

            {error ? <p className="agent-error">{error}</p> : null}

            <div className="agent-editor-actions">
              <button type="button" onClick={save} disabled={busy} className="msn-signin-button">
                Enregistrer
              </button>
              <button type="button" onClick={() => setDraft(null)} disabled={busy}>
                Annuler
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default McpServersDialog;
