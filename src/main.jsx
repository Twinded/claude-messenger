/**
 * Renderer entry — MSN Messenger-style shell for Claude Messenger.
 *
 * Two views are routed from the same bundle:
 *   - `?view=main` (default)            → roster window
 *   - `?view=conversation&contactId=X`  → standalone chat window
 *
 * The main process opens a fresh BrowserWindow per conversation by
 * loading the renderer with the conversation query string, mirroring the
 * MSN one-window-per-thread UX.
 */

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import "./styles-claude-messenger.css";

import { ClaudeConfigurationDialog } from "./claudeConfigurationDialog.jsx";
import { McpServersDialog } from "./mcpServersDialog.jsx";
import { CameraDialog } from "./cameraDialog.jsx";
import { createVoiceRecorder } from "./voiceRecorder.js";
import { ApprovalRequestsPanel, Message as MsnMessage } from "./chatParts.jsx";
import { extractWinkFromText } from "./winks.js";
import { animatedInlineEmoticons, renderFormattedMessageText } from "./messageFormatting.jsx";
import msnEmoticons from "./msnEmoticons.js";
import GamesPanel from "./gamesPanel.jsx";
import {
  playNewMessage,
  playSoundKey,
  playWink,
  playWizz
} from "./soundEffects.js";
import { Logo, ResizeGrip, Titlebar } from "./windowChrome.jsx";
import { useClaudeEvents } from "./useClaudeEvents.js";
import { useUpdates } from "./useUpdates.js";
import UpdateDialog from "./updateDialog.jsx";

const api = window.claudeMsn;

// ── Helpers ───────────────────────────────────────────────────────────

function nowTime() {
  const date = new Date();
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function getRouteParams() {
  const search = new URLSearchParams(window.location.search);
  return {
    view: search.get("view") ?? "main",
    contactId: search.get("contactId") ?? null
  };
}

function permissionDecisionFromUpstream(decision) {
  if (decision === "approved") return "allow";
  if (decision === "approved_for_session") return "allow-once";
  return "deny";
}

function approvalFromPermissionEvent(request) {
  return {
    approvalId: request.requestId,
    title: request.toolName,
    riskLevel: request.toolName.includes("Bash") || request.toolName.includes("Write") ? "high" : "low",
    kind: request.toolName.toLowerCase().includes("bash") ? "command" : "file",
    reason: `Claude veut utiliser l'outil ${request.toolName}.`,
    command: JSON.stringify(request.input ?? {}, null, 2).slice(0, 600),
    fileChanges: [],
    cwd: "",
    canApproveForSession: false,
    riskDescription: ""
  };
}

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
  const route = useMemo(getRouteParams, []);
  const [bootstrapResult, setBootstrapResult] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [agentCreatorOpen, setAgentCreatorOpen] = useState(false);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);

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

  // Standalone conversation window route
  if (route.view === "conversation" && route.contactId) {
    const contact = bootstrapResult.contacts.find((c) => c.id === route.contactId);
    if (!contact) {
      return (
        <main className="msn-window">
          <Titlebar title="Claude Messenger" />
          <div className="boot-screen">Contact introuvable.</div>
        </main>
      );
    }
    return <ChatWindow contact={contact} standalone />;
  }

  return (
    <>
      <MainShell
        bootstrap={bootstrapResult}
        onOpenSettings={() => setShowSettings(true)}
        onOpenProfileEditor={() => setProfileEditorOpen(true)}
        onOpenAgentCreator={() => setAgentCreatorOpen(true)}
        onOpenMcpDialog={() => setMcpDialogOpen(true)}
        refreshBootstrap={async () => setBootstrapResult(await api.bootstrap())}
      />
      {mcpDialogOpen ? (
        <McpServersDialog onClose={() => setMcpDialogOpen(false)} />
      ) : null}
      {profileEditorOpen ? (
        <ProfileEditor
          settings={bootstrapResult.settings}
          onClose={async () => {
            setProfileEditorOpen(false);
            setBootstrapResult(await api.bootstrap());
          }}
        />
      ) : null}
      {agentCreatorOpen ? (
        <AgentCreator
          onClose={async () => {
            setAgentCreatorOpen(false);
            setBootstrapResult(await api.bootstrap());
          }}
        />
      ) : null}
    </>
  );
}

// ── Main shell (roster) ───────────────────────────────────────────────

function MainShell({ bootstrap, onOpenSettings, onOpenProfileEditor, onOpenAgentCreator, onOpenMcpDialog, refreshBootstrap }) {
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState(bootstrap.contacts);
  const updates = useUpdates({ api, appVersion: bootstrap.appVersion, initialCheck: true });

  useEffect(() => {
    setContacts(bootstrap.contacts);
  }, [bootstrap.contacts]);

  // Re-fetch contacts on roster events (new agent, status change, etc.)
  useEffect(() => {
    return api.on("conversation:notify", () => {
      void api.listContacts().then(setContacts);
    });
  }, []);

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

  const openConversation = useCallback((contactId) => {
    void api.openConversation(contactId);
  }, []);

  const updateAvailable = Boolean(updates.updateState?.front?.updateAvailable);

  return (
    <main className="msn-window">
      <Titlebar title="Claude Messenger" />

      <div className="toolbar-shell">
        <nav className="toolbar">
          <span className="toolbar-brand">
            <Logo small />
            <span>Claude Messenger</span>
          </span>
          {updateAvailable ? (
            <button
              type="button"
              onClick={() => updates.checkForUpdates({ force: true })}
              className="top-update-button"
              style={{ background: "#fff3a0" }}
            >
              ⬇ Mise à jour
            </button>
          ) : null}
          <button type="button" onClick={onOpenProfileEditor} className="top-update-button">
            👤 Profil
          </button>
          <button type="button" onClick={onOpenAgentCreator} className="top-update-button">
            ＋ Agent
          </button>
          <button type="button" onClick={onOpenMcpDialog} className="top-update-button">
            🔌 MCP
          </button>
          <button type="button" onClick={onOpenSettings} className="top-update-button">
            ⚙ Réglages
          </button>
        </nav>
      </div>

      {updates.updateDialogOpen ? (
        <UpdateDialog
          state={updates.updateState}
          progress={updates.updateProgress}
          actionMessage={updates.updateActionMessage}
          installingTarget={updates.installingUpdateTarget}
          onClose={() => updates.setUpdateDialogOpen(false)}
          onRecheck={() => updates.checkForUpdates({ force: true })}
          onOpenTarget={updates.openUpdateTarget}
          onInstallTarget={updates.installUpdateTarget}
          onRestart={updates.restartForUpdate}
        />
      ) : null}

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
              onOpen={openConversation}
            />
          ))}
        </div>
      </div>
      <ResizeGrip />
    </main>
  );
}

function RosterGroup({ title, contacts, onOpen }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="roster-group">
      <header className="group-heading" onClick={() => setCollapsed(!collapsed)}>
        <strong>{collapsed ? "▶" : "▼"} {title}</strong>
        <span className="group-sort-label">{contacts.length}</span>
      </header>
      {!collapsed ? (
        <div className="group-box">
          {contacts.map((contact) => (
            <button
              key={contact.id}
              type="button"
              className={`contact-line ${contact.unread > 0 ? "has-unread" : ""}`}
              onDoubleClick={() => onOpen(contact.id)}
              onClick={() => onOpen(contact.id)}
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

function ChatWindow({ contact, standalone = false }) {
  const [thread, setThread] = useState(null);
  const [historicalMessages, setHistoricalMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [winkAnimation, setWinkAnimation] = useState(null);
  const [emoticonOpen, setEmoticonOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [threads, setThreads] = useState([]);
  const [activeGame, setActiveGame] = useState(null);
  const [recording, setRecording] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const transcriptRef = useRef(null);
  const composerRef = useRef(null);
  const voiceRef = useRef(null);
  if (!voiceRef.current) voiceRef.current = createVoiceRecorder();

  const { state } = useClaudeEvents(thread?.id ?? null);

  // Load threads list for this contact + most recent thread
  const reloadThreads = useCallback(async () => {
    const list = await api.listConversations({ contactId: contact.id, limit: 30 });
    setThreads(Array.isArray(list) ? list : []);
  }, [contact.id]);

  useEffect(() => {
    setThread(null);
    setHistoricalMessages([]);
    void reloadThreads();
    void api.loadThread({ contactId: contact.id }).then((result) => {
      setThread(result.thread);
      setHistoricalMessages(result.messages || []);
    });
  }, [contact.id, reloadThreads]);

  // Refresh thread list when a turn ends (preview / unread updates)
  useEffect(() => {
    if (!state.sessionId) return;
    void reloadThreads();
  }, [state.sessionId, reloadThreads]);

  // Listen for permission requests
  useEffect(() => {
    const off = api.on("claude:permission-request", (request) => {
      if (!thread || request.threadId !== thread.id) return;
      setPendingApprovals((current) => [
        ...current.filter((r) => r.approvalId !== request.requestId),
        approvalFromPermissionEvent(request)
      ]);
      playSoundKey?.("ring");
    });
    return off;
  }, [thread?.id]);

  const allMessages = useMemo(() => {
    const fromHistory = historicalMessages.map((m) => claudeMessageToMsn(m, contact.displayName)).filter(Boolean);
    const fromStream = state.messages.map((m) => claudeMessageToMsn(m, contact.displayName)).filter(Boolean);
    const merged = [...fromHistory];
    for (const msg of fromStream) {
      if (!merged.some((m) => m.id === msg.id)) merged.push(msg);
    }
    return merged;
  }, [historicalMessages, state.messages, contact.displayName]);

  // Auto-scroll
  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [allMessages.length, state.streamingText, state.thinkingText]);

  // Sounds + winks
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

  // Wizz event from main process
  useEffect(() => {
    return api.on("window:wizz", () => {
      playWizz();
      const node = document.body;
      if (node) {
        node.classList.add("wizz-shake");
        setTimeout(() => node.classList.remove("wizz-shake"), 800);
      }
    });
  }, []);

  const handleSend = useCallback(async (event) => {
    event?.preventDefault?.();
    if (!thread) return;
    if (!draft.trim() && attachments.length === 0) return;

    const items = [];
    for (const attachment of attachments) {
      if (attachment.dataUrl) {
        const match = attachment.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          items.push({
            type: "image",
            source: { type: "base64", data: match[2], mediaType: match[1] }
          });
        }
      }
    }
    if (draft.trim()) items.push({ type: "text", text: draft });

    const text = draft;
    setDraft("");
    setAttachments([]);
    setEmoticonOpen(false);

    if (items.length === 1 && items[0].type === "text") {
      await api.sendMessage({ contactId: contact.id, threadId: thread.id, text });
    } else {
      await api.sendItems({ contactId: contact.id, threadId: thread.id, items });
    }
  }, [contact.id, draft, thread, attachments]);

  const handleWizz = useCallback(() => {
    void api.wizz(contact.id);
    playWizz();
  }, [contact.id]);

  const handleInterrupt = useCallback(async () => {
    if (!thread) return;
    await api.interruptTurn({ contactId: contact.id, threadId: thread.id });
  }, [contact.id, thread]);

  const handleApprovalRespond = useCallback(async (request, decision) => {
    setPendingApprovals((current) =>
      current.map((r) => r.approvalId === request.approvalId ? { ...r, sendingDecision: true } : r)
    );
    await api.respondApproval({
      requestId: request.approvalId,
      decision: permissionDecisionFromUpstream(decision)
    });
    setPendingApprovals((current) => current.filter((r) => r.approvalId !== request.approvalId));
  }, []);

  const handleInsertEmoticon = useCallback((code) => {
    setDraft((current) => `${current}${code} `);
    setEmoticonOpen(false);
    composerRef.current?.focus();
  }, []);

  const handlePickFile = useCallback(async () => {
    const result = await api.pickFile({ extensions: ["png", "jpg", "jpeg", "gif", "webp"] });
    if (!result?.ok || !result.file?.path) return;
    setAttachments((current) => [...current, {
      path: result.file.path,
      name: result.file.name,
      dataUrl: result.file.dataUrl
    }]);
  }, []);

  const handleNewThread = useCallback(async () => {
    const result = await api.loadThread({ contactId: contact.id, createNew: true });
    setThread(result.thread);
    setHistoricalMessages([]);
    void reloadThreads();
  }, [contact.id, reloadThreads]);

  const handleSwitchThread = useCallback(async (threadId) => {
    if (!threadId || threadId === thread?.id) return;
    const result = await api.loadThread({ contactId: contact.id, threadId });
    setThread(result.thread);
    setHistoricalMessages(result.messages || []);
  }, [contact.id, thread?.id]);

  const handleDeleteThread = useCallback(async (threadId) => {
    await api.deleteThread(threadId);
    if (threadId === thread?.id) {
      setThread(null);
      setHistoricalMessages([]);
      const refreshed = await api.loadThread({ contactId: contact.id });
      setThread(refreshed.thread);
      setHistoricalMessages(refreshed.messages || []);
    }
    void reloadThreads();
  }, [contact.id, reloadThreads, thread?.id]);

  const handleReorderThreads = useCallback(async (orderedIds) => {
    await api.reorderThreads({ contactId: contact.id, threadIds: orderedIds });
    void reloadThreads();
  }, [contact.id, reloadThreads]);

  const handleRunGame = useCallback(async (prompt) => {
    if (!thread || !prompt) return;
    await api.sendMessage({ contactId: contact.id, threadId: thread.id, text: prompt });
  }, [contact.id, thread]);

  const handleToggleVoice = useCallback(async () => {
    const recorder = voiceRef.current;
    if (!recorder) return;
    if (recorder.isRecording()) {
      const result = await recorder.stop();
      setRecording(false);
      setVoiceInterim("");
      const transcribed = (result.transcript || "").trim();
      if (transcribed) {
        setDraft((current) => (current ? `${current} ${transcribed}` : transcribed));
      }
      // Always offer the audio blob as an attachment in case the user
      // wants Claude to see the file alongside the transcript.
      if (result.dataUrl) {
        setAttachments((current) => [...current, {
          path: `voice-${Date.now()}.webm`,
          name: `voice-${new Date().toISOString().slice(11, 19)}.webm`,
          dataUrl: result.dataUrl,
          kind: "audio"
        }]);
      }
      composerRef.current?.focus();
    } else {
      try {
        await recorder.start({
          onTranscript: ({ final, interim }) => {
            setVoiceInterim(interim);
            if (final) setDraft(final);
          }
        });
        setRecording(true);
      } catch (error) {
        // eslint-disable-next-line no-alert
        window.alert(`Microphone indisponible : ${error?.message || error}`);
      }
    }
  }, []);

  const handleCameraCapture = useCallback((dataUrl) => {
    if (!dataUrl) return;
    setAttachments((current) => [...current, {
      path: `camera-${Date.now()}.png`,
      name: `camera-${new Date().toISOString().slice(11, 19)}.png`,
      dataUrl,
      kind: "image"
    }]);
  }, []);

  const showApprovals = pendingApprovals.length > 0;

  return (
    <main className={`msn-window chat${standalone ? " standalone" : ""}`} key={contact.id}>
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
          <ThreadTabStrip
            threads={threads}
            activeThreadId={thread?.id}
            contactName={contact.displayName}
            onSwitch={handleSwitchThread}
            onNew={handleNewThread}
            onDelete={handleDeleteThread}
            onReorder={handleReorderThreads}
          />

          {showApprovals ? (
            <ApprovalRequestsPanel
              requests={pendingApprovals}
              onRespond={handleApprovalRespond}
            />
          ) : null}

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
            {emoticonOpen ? (
              <div className="composer-popup emoticon-popup">
                {msnEmoticons.slice(0, 64).map((emoticon) => (
                  <button
                    key={emoticon.id ?? emoticon.code}
                    type="button"
                    onClick={() => handleInsertEmoticon(emoticon.code)}
                    title={emoticon.code}
                  >
                    {emoticon.url ? (
                      <img src={emoticon.url} alt={emoticon.code} draggable="false" />
                    ) : (
                      <span>{emoticon.code}</span>
                    )}
                  </button>
                ))}
              </div>
            ) : null}

            {attachments.length ? (
              <div className="composer-attachments">
                {attachments.map((attachment, index) => (
                  <button
                    type="button"
                    key={`${attachment.path}-${index}`}
                    onClick={() =>
                      setAttachments((current) => current.filter((_, i) => i !== index))
                    }
                    title="Retirer la pièce jointe"
                  >
                    {attachment.dataUrl ? (
                      <img src={attachment.dataUrl} alt="" />
                    ) : null}
                    <span>{attachment.name}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <textarea
              ref={composerRef}
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
              <button
                type="button"
                onClick={() => setEmoticonOpen((open) => !open)}
                title="Émoticônes"
              >
                😊
              </button>
              <button type="button" onClick={handlePickFile} title="Joindre un fichier">
                📎
              </button>
              <button
                type="button"
                onClick={handleToggleVoice}
                title={recording ? "Stopper l'enregistrement" : "Enregistrer un message vocal"}
                style={recording ? { background: "#d9534f", color: "white" } : undefined}
              >
                {recording ? "⏹ Voix" : "🎤"}
              </button>
              <button type="button" onClick={() => setCameraOpen(true)} title="Capture caméra">
                📷
              </button>
              <button type="button" onClick={handleWizz} title="Wizz / Nudge">
                ⚡ Wizz
              </button>
              {state.isStreaming ? (
                <button type="button" onClick={handleInterrupt} className="format-status">
                  ⏹ Stop
                </button>
              ) : null}
              <button type="submit" disabled={state.isStreaming || (!draft.trim() && attachments.length === 0)}>
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
                {state.lastUsage.cacheReadInputTokens ? (
                  <> · cache {state.lastUsage.cacheReadInputTokens}</>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="msn-service-panel">
            <strong className="msn-service-title">Jeux MSN</strong>
            <GamesPanel
              activeGame={activeGame}
              onSelectGame={setActiveGame}
              onRun={handleRunGame}
              waiting={state.isStreaming}
            />
          </div>
        </aside>
      </section>

      {cameraOpen ? (
        <CameraDialog
          onCapture={handleCameraCapture}
          onClose={() => setCameraOpen(false)}
        />
      ) : null}

      {recording && voiceInterim ? (
        <div className="voice-interim">🎤 « {voiceInterim} »</div>
      ) : null}

      <ResizeGrip />
    </main>
  );
}

/**
 * Horizontal strip of thread tabs over the transcript.
 *
 * Up to VISIBLE_TAB_LIMIT tabs are shown inline; the rest collapse into
 * a "▼" overflow menu that mirrors the upstream MSN hidden-threads UX.
 * The active thread is always pinned to the visible row regardless of
 * its position in the list.
 */
const VISIBLE_TAB_LIMIT = 6;

function ThreadTabStrip({ threads, activeThreadId, contactName, onSwitch, onNew, onDelete, onReorder }) {
  const [dragId, setDragId] = useState(null);
  const [hiddenMenuOpen, setHiddenMenuOpen] = useState(false);
  const hiddenMenuRef = useRef(null);

  useEffect(() => {
    if (!hiddenMenuOpen) return undefined;
    function close(event) {
      if (!hiddenMenuRef.current?.contains(event.target)) setHiddenMenuOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setHiddenMenuOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [hiddenMenuOpen]);

  if (threads.length <= 1) {
    return (
      <div className="thread-tab-bar">
        <span className="thread-to-label">À : {contactName}</span>
        <button type="button" onClick={onNew} title="Nouveau fil">＋ Nouveau fil</button>
      </div>
    );
  }

  // Pin the active thread inside the visible window.
  const visible = threads.slice(0, VISIBLE_TAB_LIMIT);
  const hidden = threads.slice(VISIBLE_TAB_LIMIT);
  if (activeThreadId && !visible.some((t) => t.id === activeThreadId)) {
    const activeIndex = threads.findIndex((t) => t.id === activeThreadId);
    if (activeIndex >= 0) {
      visible[VISIBLE_TAB_LIMIT - 1] = threads[activeIndex];
      hidden.splice(activeIndex - VISIBLE_TAB_LIMIT, 1);
    }
  }

  function handleDrop(targetId) {
    if (!dragId || dragId === targetId) return;
    const ids = threads.map((t) => t.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
    setDragId(null);
  }

  function handleHiddenChoice(thread) {
    setHiddenMenuOpen(false);
    onSwitch(thread.id);
  }

  return (
    <div className="thread-tab-bar">
      <span className="thread-to-label">À : {contactName}</span>
      <div className="thread-tab-strip">
        {visible.map((thread) => {
          const title = thread.title || thread.lastMessagePreview?.slice(0, 24) || "Conversation";
          return (
            <div
              key={thread.id}
              className={`thread-tab ${thread.id === activeThreadId ? "active" : ""}`}
              draggable
              onDragStart={() => setDragId(thread.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => handleDrop(thread.id)}
              onClick={() => onSwitch(thread.id)}
              title={thread.lastMessagePreview || ""}
            >
              <span>{title}</span>
              <button
                type="button"
                className="thread-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  if (window.confirm("Supprimer ce fil ?")) onDelete(thread.id);
                }}
                aria-label="Supprimer le fil"
              >
                ×
              </button>
            </div>
          );
        })}

        {hidden.length > 0 ? (
          <div className="thread-tab-hidden-wrapper" ref={hiddenMenuRef}>
            <button
              type="button"
              className={`thread-tab-hidden-toggle ${hiddenMenuOpen ? "open" : ""}`}
              onClick={() => setHiddenMenuOpen((open) => !open)}
              title={`${hidden.length} autre(s) fil(s)`}
            >
              ▼ {hidden.length}
            </button>
            {hiddenMenuOpen ? (
              <div className="thread-tab-hidden-menu">
                {hidden.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => handleHiddenChoice(thread)}
                    className="thread-tab-hidden-entry"
                  >
                    <strong>{thread.title || thread.lastMessagePreview?.slice(0, 32) || "Conversation"}</strong>
                    <small>{thread.updatedAt ? new Date(thread.updatedAt).toLocaleString("fr-FR") : ""}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <button type="button" className="thread-tab-add" onClick={onNew} title="Nouveau fil">＋</button>
      </div>
    </div>
  );
}

// ── Profile editor ────────────────────────────────────────────────────

function ProfileEditor({ settings, onClose }) {
  const [statusMessage, setStatusMessage] = useState(settings.profileStatusMessage ?? "");
  const [picturePath, setPicturePath] = useState(settings.profilePicturePath ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function pickPicture() {
    setBusy(true);
    try {
      const result = await api.chooseProfilePicture();
      if (result?.ok && result.path) setPicturePath(result.path);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearPicture() {
    setBusy(true);
    try {
      await api.clearProfilePicture();
      setPicturePath("");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const patch = { profileStatusMessage: statusMessage };
      if (picturePath) patch.profilePicturePath = picturePath;
      await api.setSettings(patch);
      onClose?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-dialog-backdrop">
      <div className="settings-dialog profile-editor">
        <h2>Mon profil</h2>
        {picturePath ? (
          <div className="profile-editor-picture">
            <img src={picturePath.startsWith("data:") ? picturePath : `file://${picturePath}`} alt="" />
          </div>
        ) : null}
        <button type="button" onClick={pickPicture} disabled={busy}>Choisir une image</button>
        <button type="button" onClick={clearPicture} disabled={busy || !picturePath}>Retirer</button>

        <label className="msn-login-field">
          <span>Message de statut</span>
          <input
            type="text"
            value={statusMessage}
            onChange={(event) => setStatusMessage(event.target.value)}
            placeholder="Ex. occupé, sur Claude…"
            maxLength={120}
          />
        </label>

        {error ? <p className="profile-editor-error">{error}</p> : null}

        <div className="profile-editor-actions">
          <button type="button" onClick={save} disabled={busy} className="msn-signin-button">Enregistrer</button>
          <button type="button" onClick={onClose} disabled={busy}>Annuler</button>
        </div>
      </div>
    </div>
  );
}

// ── Agent creator ─────────────────────────────────────────────────────

const SUBAGENT_GROUPS = ["Subagents", "Reviewers", "Designers", "Helpers"];
const ICON_OPTIONS = ["robot", "sparkles", "wrench", "lightbulb", "briefcase", "magnifier"];
const COLOR_SWATCHES = ["#4f8df3", "#7b61ff", "#2bb673", "#f0ad4e", "#d9534f", "#19457e", "#5b8c00"];

function AgentCreator({ onClose }) {
  const [displayName, setDisplayName] = useState("");
  const [group, setGroup] = useState(SUBAGENT_GROUPS[0]);
  const [iconKey, setIconKey] = useState(ICON_OPTIONS[0]);
  const [color, setColor] = useState(COLOR_SWATCHES[0]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function pickRunFolder() {
    const result = await api.chooseDirectory({ title: "Dossier de travail" });
    if (result?.ok && result.path) setWorkingDirectory(result.path);
  }

  async function submit() {
    if (!displayName.trim() || !systemPrompt.trim()) {
      setError("Nom et instructions sont requis.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.createAgent({
        displayName: displayName.trim(),
        group,
        iconKey,
        color,
        systemPrompt: systemPrompt.trim(),
        workingDirectory: workingDirectory || undefined
      });
      if (!result?.ok) throw new Error(result?.message || "Création impossible");
      onClose?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-dialog-backdrop">
      <div className="settings-dialog agent-editor">
        <header className="agent-editor-head">
          <h2>Nouveau contact</h2>
        </header>

        <div className="agent-editor-grid">
          <label className="msn-login-field">
            <span>Nom</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} />
          </label>

          <label className="msn-login-field">
            <span>Groupe</span>
            <select value={group} onChange={(event) => setGroup(event.target.value)}>
              {SUBAGENT_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>

          <label className="msn-login-field">
            <span>Icône</span>
            <select value={iconKey} onChange={(event) => setIconKey(event.target.value)}>
              {ICON_OPTIONS.map((icon) => <option key={icon} value={icon}>{icon}</option>)}
            </select>
          </label>

          <div className="agent-color-field">
            <span>Couleur</span>
            <div className="agent-swatches">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  type="button"
                  key={swatch}
                  className={swatch === color ? "active" : ""}
                  style={{ background: swatch }}
                  onClick={() => setColor(swatch)}
                  aria-label={swatch}
                />
              ))}
            </div>
          </div>

          <div className="agent-run-folder">
            <label className="msn-login-field">
              <span>Dossier de travail (optionnel)</span>
              <div className="agent-path-picker">
                <input
                  value={workingDirectory}
                  onChange={(event) => setWorkingDirectory(event.target.value)}
                  placeholder="/Users/.../mon-projet"
                />
                <button type="button" onClick={pickRunFolder}>Parcourir…</button>
              </div>
            </label>
          </div>

          <label className="msn-login-field agent-instructions">
            <span>Instructions</span>
            <textarea
              rows={6}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="Tu es un assistant spécialisé en…"
            />
          </label>
        </div>

        {error ? <p className="agent-error">{error}</p> : null}

        <div className="agent-editor-actions">
          <button type="button" onClick={submit} disabled={busy} className="msn-signin-button">Créer</button>
          <button type="button" onClick={onClose} disabled={busy}>Annuler</button>
        </div>
      </div>
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root"));
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);
