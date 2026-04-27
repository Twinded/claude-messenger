/**
 * Electron main process entry. Sets up the app lifecycle, the main window,
 * the settings store, the Claude Agent SDK client, contact discovery, and
 * the IPC bridge that the renderer talks to.
 *
 * Renderer-visible side effects all flow through `electron/ipcHandlers.ts`;
 * stream events from the Agent SDK are forwarded over the `claude:*` and
 * `conversation:*` IPC channels declared in `shared/types.ts`.
 */

import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSettingsStore } from "./settingsStore.js";
import { createAuthBridge } from "./authBridge.js";
import { createThreadStore, resolveThreadDbPath } from "./threadStore.js";
import { createAgentsWatcher } from "./agentsWatcher.js";
import { createSkillsWatcher } from "./skillsWatcher.js";
import { createContactRegistry, type CustomAgentRecord } from "./contactRegistry.js";
import { createClaudeAgentClient } from "./claudeAgentClient.js";
import { createNotificationsService } from "./notifications.js";
import {
  createBaseWindowFactory,
  setStableWindowTitle,
  type WindowKey
} from "./windowManager.js";
import { registerIpcHandlers } from "./ipcHandlers.js";
import { STREAM_CHANNELS } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isSmokeTest = process.argv.includes("--smoke-test");
const isDev = !app.isPackaged;

const windows = new Map<WindowKey, BrowserWindow>();

function logDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!isDev && !process.env.CLAUDE_MESSENGER_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`[claude-messenger] ${event}`, details);
}

function showDockIcon(): void {
  if (process.platform === "darwin") app.dock?.show?.();
}

function appIconPath(): string | undefined {
  const iconDir = isDev
    ? path.join(__dirname, "..", "..", "public", "icons")
    : path.join(process.resourcesPath, "public", "icons");
  if (process.platform === "win32") return path.join(iconDir, "claude-messenger.ico");
  if (process.platform === "darwin") return path.join(iconDir, "claude-messenger.icns");
  return path.join(iconDir, "claude-messenger.png");
}

function rendererEntryUrl(): string {
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  const indexHtml = path.join(__dirname, "..", "..", "dist", "index.html");
  return `file://${indexHtml}`;
}

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function customAgentsFilePath(): string {
  return path.join(app.getPath("userData"), "custom-agents.json");
}

async function loadCustomAgents(): Promise<CustomAgentRecord[]> {
  const fs = await import("node:fs/promises");
  try {
    const raw = await fs.readFile(customAgentsFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CustomAgentRecord[]) : [];
  } catch {
    return [];
  }
}

async function saveCustomAgents(agents: CustomAgentRecord[]): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(customAgentsFilePath()), { recursive: true });
  await fs.writeFile(customAgentsFilePath(), JSON.stringify(agents, null, 2), "utf8");
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Auto-grant media (microphone + camera) permissions to our own renderer
  // so MediaRecorder / getUserMedia work without an OS prompt every launch.
  // The renderer is sandboxed and only runs our own code, so this is the
  // correct trust level here.
  const { session } = await import("electron");
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // "media" covers both microphone and camera in Electron's renderer.
    if (permission === "media") {
      callback(true);
      return;
    }
    callback(false);
  });

  const settings = createSettingsStore({ filePath: settingsFilePath });
  const { settings: currentSettings } = await settings.load();

  const auth = createAuthBridge();
  await auth.applyToProcessEnv();

  const threadStore = createThreadStore({
    dbPath: resolveThreadDbPath(app.getPath("userData"))
  });

  const agentsWatcher = createAgentsWatcher();
  const skillsWatcher = createSkillsWatcher();
  await agentsWatcher.refresh();
  await skillsWatcher.refresh();

  const contactRegistry = createContactRegistry({
    agentsWatcher,
    skillsWatcher,
    threadStore,
    loadCustomAgents,
    defaultModel: currentSettings.defaultModel,
    isDemoMode: () => Boolean(settings.current()?.demoMode)
  });
  await contactRegistry.refresh();

  const claudeClient = createClaudeAgentClient({
    threadStore,
    defaults: {
      model: currentSettings.defaultModel as never,
      maxOutputTokens: currentSettings.maxOutputTokens,
      maxThinkingTokens: currentSettings.maxThinkingTokens,
      permissionMode: currentSettings.permissionMode
    }
  });

  const notifications = createNotificationsService({
    windows,
    isDev,
    onTrayQuit: () => undefined,
    onTrayShow: () => undefined,
    logDebug
  });

  let unreadByContact = new Map<string, number>();
  function recomputeUnread(): void {
    let total = 0;
    for (const value of unreadByContact.values()) total += value;
    notifications.setUnreadCount(total);
  }

  claudeClient.on("stream", (event) => {
    const channel = streamChannelFor(event.kind);
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, event);
    }

    if (event.kind === "message-completed" && event.message?.role === "assistant") {
      const previewSegments = (event.message.content || [])
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text);
      const preview = previewSegments.join(" ").slice(0, 200);
      const thread = threadStore.getThread(event.threadId);
      const contact = thread
        ? contactRegistry.list().find((c) => c.id === thread.contactId)
        : null;
      notifications.notifyAssistantMessage({
        contactName: contact?.displayName ?? "Claude",
        preview: preview || "Nouveau message"
      });
      if (contact && thread) {
        // Persist the unread bump on the thread row so the roster bubble
        // survives a restart, and broadcast a refresh to any open roster.
        threadStore.bumpUnread(event.threadId, preview.slice(0, 80) || "Nouveau message");
        unreadByContact.set(contact.id, (unreadByContact.get(contact.id) ?? 0) + 1);
        recomputeUnread();
        void contactRegistry.refresh();
        for (const win of windows.values()) {
          if (!win.isDestroyed()) win.webContents.send("conversation:notify", { kind: "contacts" });
        }
      }
    }

    if (event.kind === "permission-request") {
      const thread = threadStore.getThread(event.threadId);
      const contact = thread
        ? contactRegistry.list().find((c) => c.id === thread.contactId)
        : null;
      notifications.notifyPermissionRequest({
        contactName: contact?.displayName ?? "Claude",
        toolName: event.toolName
      });
    }
  });

  // Reset unread when a window with a contactId regains focus.
  app.on("browser-window-focus", (_event, win) => {
    const url = win.webContents.getURL();
    const match = url.match(/contactId=([^&]+)/);
    if (!match) return;
    const contactId = decodeURIComponent(match[1] ?? "");
    if (contactId) {
      unreadByContact.delete(contactId);
      threadStore.markRead(contactId);
      recomputeUnread();
      void contactRegistry.refresh();
      for (const w of windows.values()) {
        if (!w.isDestroyed()) w.webContents.send("conversation:notify", { kind: "contacts" });
      }
    }
  });

  const createBaseWindow = createBaseWindowFactory({
    preloadPath: path.join(__dirname, "..", "preload.cjs"),
    appIconPath: appIconPath(),
    windows,
    showDockIcon,
    smokeTest: isSmokeTest,
    onSmokeReady: () => {
      logDebug("smoke.ready");
      app.quit();
    },
    logDebug
  });

  registerIpcHandlers({
    settings,
    auth,
    threadStore,
    contactRegistry,
    claudeClient,
    windows,
    createBaseWindow,
    rendererEntryUrl,
    loadCustomAgents,
    saveCustomAgents,
    logDebug
  });

  await createMainWindow(createBaseWindow);
}

async function createMainWindow(
  createBaseWindow: ReturnType<typeof createBaseWindowFactory>
): Promise<BrowserWindow> {
  const win = createBaseWindow("main", {
    width: 360,
    height: 640,
    minWidth: 320,
    minHeight: 460,
    title: "Claude Messenger"
  });
  setStableWindowTitle(win, "Claude Messenger");
  await win.loadURL(rendererEntryUrl());
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
  return win;
}

function streamChannelFor(kind: string): string {
  switch (kind) {
    case "delta":
      return STREAM_CHANNELS.delta;
    case "thinking":
      return STREAM_CHANNELS.thinking;
    case "tool-use":
      return STREAM_CHANNELS.toolUse;
    case "tool-result":
      return STREAM_CHANNELS.toolResult;
    case "message-completed":
      return STREAM_CHANNELS.messageCompleted;
    case "turn-completed":
      return STREAM_CHANNELS.turnCompleted;
    case "permission-request":
      return STREAM_CHANNELS.permissionRequest;
    case "status":
      return STREAM_CHANNELS.status;
    case "error":
    default:
      return STREAM_CHANNELS.error;
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
});

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[claude-messenger] bootstrap failed", error);
  app.exit(1);
});
