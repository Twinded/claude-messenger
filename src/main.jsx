/**
 * Renderer entry — minimal Claude Messenger bootstrap.
 *
 * Replaces the upstream codex-messenger main.jsx (3000+ lines glued
 * around codex app-server). The MSN-style chat UI is being progressively
 * rewired to the Claude Agent SDK over follow-up commits; this file only
 * carries the auth gate, the contact list, and a basic conversation pane
 * exercising the IPC contract end-to-end.
 */

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { ClaudeConfigurationDialog } from "./claudeConfigurationDialog.jsx";
import { useClaudeEvents } from "./useClaudeEvents.js";

const api = window.claudeMsn;

function App() {
  const [bootstrapResult, setBootstrapResult] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [activeContactId, setActiveContactId] = useState(null);

  useEffect(() => {
    void api.bootstrap().then(setBootstrapResult);
  }, []);

  if (!bootstrapResult) {
    return <div className="boot-screen">Connexion à Claude Messenger…</div>;
  }

  if (!bootstrapResult.authReady || showSettings) {
    return <ClaudeConfigurationDialog onClose={() => setShowSettings(false)} />;
  }

  return (
    <div className="app-root">
      <Roster
        contacts={bootstrapResult.contacts}
        activeContactId={activeContactId}
        onSelect={setActiveContactId}
        onOpenSettings={() => setShowSettings(true)}
      />
      {activeContactId ? (
        <ConversationPane contactId={activeContactId} contacts={bootstrapResult.contacts} />
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

function Roster({ contacts, activeContactId, onSelect, onOpenSettings }) {
  const grouped = contacts.reduce((acc, contact) => {
    if (!acc[contact.group]) acc[contact.group] = [];
    acc[contact.group].push(contact);
    return acc;
  }, {});

  return (
    <aside className="roster">
      <header className="roster-header">
        <span className="roster-title">Claude Messenger</span>
        <button type="button" onClick={onOpenSettings} aria-label="Réglages">
          ⚙
        </button>
      </header>
      <ul className="roster-groups">
        {Object.entries(grouped).map(([group, items]) => (
          <li key={group}>
            <h4>{group}</h4>
            <ul>
              {items.map((contact) => (
                <li
                  key={contact.id}
                  className={`roster-contact ${activeContactId === contact.id ? "active" : ""}`}
                  onClick={() => onSelect(contact.id)}
                >
                  <span className={`status-dot status-${contact.status}`} />
                  <span className="contact-name">{contact.displayName}</span>
                  {contact.unread > 0 && <span className="unread">{contact.unread}</span>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function EmptyState() {
  return (
    <main className="empty-state">
      <p>Sélectionne un contact pour démarrer une conversation.</p>
    </main>
  );
}

function ConversationPane({ contactId, contacts }) {
  const contact = contacts.find((c) => c.id === contactId);
  const [thread, setThread] = useState(null);
  const [draft, setDraft] = useState("");
  const { state } = useClaudeEvents(thread?.id ?? null);

  useEffect(() => {
    setThread(null);
    void api.loadThread({ contactId }).then((result) => setThread(result.thread));
  }, [contactId]);

  async function handleSend(event) {
    event.preventDefault();
    if (!draft.trim() || !thread) return;
    const text = draft;
    setDraft("");
    await api.sendMessage({ contactId, threadId: thread.id, text });
  }

  if (!contact) return <EmptyState />;
  if (!thread) {
    return (
      <main className="conversation-pane">
        <header className="conversation-header">
          <h3>{contact.displayName}</h3>
        </header>
        <div className="conversation-loading">Chargement du fil…</div>
      </main>
    );
  }

  return (
    <main className="conversation-pane">
      <header className="conversation-header">
        <h3>{contact.displayName}</h3>
        <span className="conversation-model">{contact.model ?? ""}</span>
      </header>

      <ol className="messages">
        {state.messages.map((message) => (
          <li key={message.id} className={`message message-${message.role}`}>
            {message.content.map((block, idx) => (
              <ContentBlock key={`${message.id}-${idx}`} block={block} />
            ))}
          </li>
        ))}
        {state.thinkingText && (
          <li className="message message-thinking">
            <em>{state.thinkingText}</em>
          </li>
        )}
        {state.streamingText && (
          <li className="message message-assistant streaming">{state.streamingText}</li>
        )}
        {state.error && <li className="message message-error">{state.error}</li>}
      </ol>

      <form className="composer" onSubmit={handleSend}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Message à ${contact.displayName}…`}
          rows={3}
        />
        <button type="submit" disabled={state.isStreaming || !draft.trim()}>
          Envoyer
        </button>
      </form>
    </main>
  );
}

function ContentBlock({ block }) {
  if (block.type === "text") return <span>{block.text}</span>;
  if (block.type === "tool_use") return <code>tool: {block.name}</code>;
  if (block.type === "tool_result")
    return (
      <pre className="tool-result">
        {typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content, null, 2)}
      </pre>
    );
  if (block.type === "thinking") return <em className="thinking">{block.text}</em>;
  if (block.type === "image") return <em>[image]</em>;
  return null;
}

const root = createRoot(document.getElementById("root"));
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);
