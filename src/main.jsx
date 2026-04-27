/**
 * Renderer entry — MSN Messenger style shell wired to the Claude Agent SDK.
 *
 * The visual layout, classNames, and most of the chrome match the upstream
 * codex-messenger so the cascade in `styles.css` lights up the windows the
 * same way. The data model is Claude-native: messages flow through the
 * `claude:*` IPC stream channels and are adapted to the flat shape the
 * vendored `chatParts.jsx` expects.
 *
 * Pieces that still need porting from upstream (full RosterView with
 * project picker, AgentCreator, ProfileEditor, Settings dialog with
 * sandbox/MCP UI, demo mode, GamesPanel, multi-window per conversation)
 * are tracked in IMPLEMENTATION_PLAN.md and will land in follow-up commits.
 */

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import "./styles-claude-messenger.css";

import { ClaudeConfigurationDialog } from "./claudeConfigurationDialog.jsx";
import { Message as MsnMessage } from "./chatParts.jsx";
import { extractWinkFromText } from "./winks.js";
import { renderFormattedMessageText } from "./messageFormatting.jsx";
import {
  playNewMessage,
  playWink,
  playWizz
} from "./soundEffects.js";
import { Logo, ResizeGrip, Titlebar } from "./windowChrome.jsx";
import { useClaudeEvents } from "./useClaudeEvents.js";

const api = window.claudeMsn;

// ── Helpers ───────────────────────────────────────────────────────────

function nowTime() {
  const date = new Date();
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function previewFromContent(content) {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block.type === "text" && block.text) return block.text.slice(0, 80);
  }
  return "";
}

/**
 * Adapt a Claude Message into the flat shape the vendored MSN
 * `chatParts.Message` component expects.
 */
function claudeMessageToMsn(message, contactName) {
  if (!message) return null;
  const flatText = (message.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const toolUse = (message.content || []).find((block) => block.type === "tool_use");
  const toolResult = (message.content || []).find((block) => block.type === "tool_result");
  const image = (message.content || []).find((block) => block.type === "image");

  if (toolUse) {
    return {
      id: message.id,
      from: "them",
      author: contactName,
      time: nowTime(),
      itemType: "mcpToolCall",
      text: `${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 80)}…)`,
      status: "completed"
    };
  }

  if (toolResult) {
    const text = typeof toolResult.content === "string"
      ? toolResult.content
      : JSON.stringify(toolResult.content);
    return {
      id: message.id,
      from: "them",
      author: contactName,
      time: nowTime(),
      itemType: "fileChange",
      text: text.slice(0, 800),
      status: toolResult.isError ? "failed" : "completed"
    };
  }

  if (image) {
    let src = "";
    if (image.source?.type === "base64") {
      src = `data:${image.source.media_type ?? "image/png"};base64,${image.source.data}`;
    } else if (image.source?.type === "url") {
      src = image.source.url;
    }
    return {
      id: message.id,
      from: message.role === "user" ? "me" : "them",
      author: message.role === "user" ? "Toi" : contactName,
      time: nowTime(),
      text: flatText,
      attachment: src ? { type: "image", src } : null
    };
  }

  return {
    id: message.id,
    from: message.role === "user" ? "me" : (message.role === "assistant" ? "them" : "system"),
    author: message.role === "user" ? "Toi" : (message.role === "assistant" ? contactName : "Système"),
    time: nowTime(),
    text: flatText
  };
}

// ── App router ────────────────────────────────────────────────────────

function App() {
  const [bootstrapResult, setBootstrapResult] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    void api.bootstrap().then(setBootstrapResult);
  }, []);

  if (!bootstrapResult) {
    return (
      <main className="msn-window">
        <Titlebar title="Claude Messenger" />
        <div className="boot-screen">Connexion à Claude…</div>
      </main>
    );
  }

  if (!bootstrapResult.authReady || showSettings) {
    return (
      <main className="msn-window">
        <Titlebar title="Claude Messenger — Configuration" />
        <div className="settings-shell">
          <ClaudeConfigurationDialog
            onClose={async () => {
              setShowSettings(false);
              const refreshed = await api.bootstrap();
              setBootstrapResult(refreshed);
            }}
          />
        </div>
        <ResizeGrip />
      </main>
    );
  }

  return <MainShell bootstrap={bootstrapResult} onOpenSettings={() => setShowSettings(true)} />;
}

// ── Roster + chat split shell ─────────────────────────────────────────

function MainShell({ bootstrap, onOpenSettings }) {
  const [activeContactId, setActiveContactId] = useState(null);
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState(bootstrap.contacts);

  useEffect(() => {
    setContacts(bootstrap.contacts);
  }, [bootstrap.contacts]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return contacts;
    return contacts.filter((c) => c.displayName.toLowerCase().includes(term));
  }, [contacts, search]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const contact of filtered) {
      const list = map.get(contact.group) ?? [];
      list.push(contact);
      map.set(contact.group, list);
    }
    return [...map.entries()];
  }, [filtered]);

  const activeContact = contacts.find((c) => c.id === activeContactId) ?? null;

  return (
    <div className="msn-shell">
      <main className="msn-window">
        <Titlebar title="Claude Messenger" />
        <div className="toolbar-shell">
          <nav className="toolbar">
            <span className="toolbar-brand">
              <Logo small />
              <span>Claude Messenger</span>
            </span>
            <button type="button" onClick={onOpenSettings} className="top-update-button" aria-label="Réglages">
              ⚙ Réglages
            </button>
          </nav>
        </div>

        <div className="roster">
          <div className="contact-actions">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Rechercher un contact…"
              className="msn-combo-input"
            />
          </div>

          <div className="groups">
            {grouped.map(([group, items]) => (
              <RosterGroup
                key={group}
                title={group}
                contacts={items}
                activeContactId={activeContactId}
                onSelect={setActiveContactId}
              />
            ))}
          </div>
        </div>
        <ResizeGrip />
      </main>

      {activeContact ? (
        <ChatWindow contact={activeContact} />
      ) : null}
    </div>
  );
}

function RosterGroup({ title, contacts, activeContactId, onSelect }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="roster-group">
      <header className="group-heading" onClick={() => setCollapsed(!collapsed)}>
        <strong>
          {collapsed ? "▶" : "▼"} {title}
        </strong>
        <span className="group-sort-label">{contacts.length}</span>
      </header>
      {!collapsed ? (
        <div className="group-box">
          {contacts.map((contact) => (
            <button
              key={contact.id}
              type="button"
              className={`contact-line ${activeContactId === contact.id ? "expanded" : ""} ${contact.unread > 0 ? "has-unread" : ""}`}
              onClick={() => onSelect(contact.id)}
            >
              <span className="contact-mini-avatar">
                <span className={`avatar status-${contact.status}`} aria-hidden="true" />
              </span>
              <span className="contact-line-copy">
                <span className="contact-name">{contact.displayName}</span>
                {contact.statusMessage ? (
                  <span className="contact-mood"> — {contact.statusMessage}</span>
                ) : null}
              </span>
              {contact.unread > 0 ? (
                <span className="contact-unread-bubble">{contact.unread}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ── Chat window ───────────────────────────────────────────────────────

function ChatWindow({ contact }) {
  const [thread, setThread] = useState(null);
  const [historicalMessages, setHistoricalMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [winkAnimation, setWinkAnimation] = useState(null);
  const transcriptRef = useRef(null);

  const { state } = useClaudeEvents(thread?.id ?? null);

  useEffect(() => {
    setThread(null);
    setHistoricalMessages([]);
    void api.loadThread({ contactId: contact.id }).then((result) => {
      setThread(result.thread);
      setHistoricalMessages(result.messages || []);
    });
  }, [contact.id]);

  const allMessages = useMemo(() => {
    const fromHistory = historicalMessages.map((m) => claudeMessageToMsn(m, contact.displayName)).filter(Boolean);
    const fromStream = state.messages.map((m) => claudeMessageToMsn(m, contact.displayName)).filter(Boolean);
    const merged = [...fromHistory];
    for (const msg of fromStream) {
      if (!merged.some((m) => m.id === msg.id)) merged.push(msg);
    }
    return merged;
  }, [historicalMessages, state.messages, contact.displayName]);

  // Auto-scroll on new messages
  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [allMessages.length, state.streamingText, state.thinkingText]);

  // Play sound on new completed assistant message
  const lastMessageIdRef = useRef(null);
  useEffect(() => {
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === "assistant" && last.id !== lastMessageIdRef.current) {
      lastMessageIdRef.current = last.id;
      const text = (last.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
      const wink = extractWinkFromText(text).wink;
      if (wink) {
        playWink(wink);
        setWinkAnimation({ wink, kind: "incoming" });
        setTimeout(() => setWinkAnimation(null), 4000);
      } else {
        playNewMessage();
      }
    }
  }, [state.messages]);

  // Listen for the wizz IPC event
  useEffect(() => {
    return api.on("window:wizz", () => {
      playWizz();
      const node = transcriptRef.current?.parentElement?.parentElement;
      if (node) {
        node.classList.add("wizz-shake");
        setTimeout(() => node.classList.remove("wizz-shake"), 800);
      }
    });
  }, []);

  const handleSend = useCallback(async (event) => {
    event.preventDefault();
    if (!draft.trim() || !thread) return;
    const text = draft;
    setDraft("");
    await api.sendMessage({ contactId: contact.id, threadId: thread.id, text });
  }, [contact.id, draft, thread]);

  const handleWizz = useCallback(() => {
    void api.wizz(contact.id);
    playWizz();
  }, [contact.id]);

  const handleInterrupt = useCallback(async () => {
    if (!thread) return;
    await api.interruptTurn({ contactId: contact.id, threadId: thread.id });
  }, [contact.id, thread]);

  return (
    <main className="msn-window chat" key={contact.id}>
      <Titlebar title={`${contact.displayName} — Conversation`} />

      <div className="toolbar-shell">
        <nav className="toolbar">
          <span className="toolbar-brand">
            <Logo small />
            <span>{contact.displayName}</span>
          </span>
          <span className="conversation-model">{contact.model || ""}</span>
        </nav>
      </div>

      <section className="chat-body">
        <div className="chat-main">
          <div className="to-line">À : {contact.displayName}</div>

          <div ref={transcriptRef} className="transcript">
            {allMessages.length === 0 ? (
              <p className="system">Démarre la conversation en envoyant un message ci-dessous.</p>
            ) : null}
            {allMessages.map((message) => (
              <MsnMessage
                key={message.id}
                message={message}
                extractWinkFromText={extractWinkFromText}
                renderFormattedMessageText={renderFormattedMessageText}
                onOpenAttachment={(att) => att?.src && api.app.openPath(att.src)}
              />
            ))}
            {state.thinkingText ? (
              <p className="system thinking">
                <em>{contact.displayName} réfléchit… {state.thinkingText.slice(-160)}</em>
              </p>
            ) : null}
            {state.streamingText ? (
              <article className="message">
                <header>
                  <strong>{contact.displayName}</strong>
                  <time>{nowTime()}</time>
                </header>
                <div className="message-content">{state.streamingText}</div>
              </article>
            ) : null}
            {state.error ? (
              <p className="system error">⚠ {state.error}</p>
            ) : null}
            {winkAnimation ? (
              <div className="wink-animation-card">{winkAnimation.wink}</div>
            ) : null}
          </div>

          <form className="composer" onSubmit={handleSend}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend(event);
                }
              }}
              rows={3}
              placeholder={`Écris à ${contact.displayName}…`}
            />
            <div className="format-strip">
              <button type="button" onClick={handleWizz} title="Wizz / Nudge">⚡ Wizz</button>
              {state.isStreaming ? (
                <button type="button" onClick={handleInterrupt} className="format-status">
                  ⏹ Stop
                </button>
              ) : null}
              <button type="submit" disabled={!draft.trim() || state.isStreaming}>
                Envoyer
              </button>
            </div>
          </form>
        </div>

        <aside className="chat-side">
          <div className="display-frame-caption">
            <strong>{contact.displayName}</strong>
            <small>{contact.model || "claude-sonnet-4-6"}</small>
          </div>
          {contact.statusMessage ? (
            <p className="display-frame-menu-status">{contact.statusMessage}</p>
          ) : null}
          {state.lastUsage ? (
            <div className="msn-service-panel">
              <strong className="msn-service-title">Tokens</strong>
              <div className="msn-service-body">
                in {state.lastUsage.inputTokens} · out {state.lastUsage.outputTokens}
                {state.lastUsage.cacheReadInputTokens
                  ? <> · cache {state.lastUsage.cacheReadInputTokens}</>
                  : null}
              </div>
            </div>
          ) : null}
        </aside>
      </section>

      <ResizeGrip />
    </main>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root"));
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);
