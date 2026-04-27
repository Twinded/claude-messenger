/**
 * Central registry for all `ipcMain.handle` channels exposed to the
 * renderer. Each handler is wrapped so unexpected errors are turned into
 * structured failure responses instead of crashing the renderer.
 *
 * The handlers below dispatch to the Claude Agent SDK client, the contact
 * registry, the thread store, and the auth bridge wired up in main.ts.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  IPC_CHANNELS,
  type AppSettings,
  type AuthSignInPayload,
  type BootstrapPayload,
  type BootstrapResult,
  type Contact,
  type CreateAgentPayload,
  type InterruptPayload,
  type Message,
  type PermissionResponsePayload,
  type SendItemsPayload,
  type SendMessagePayload,
  type ThreadSummary
} from "../shared/types.js";
import { isSafeExternalUrl } from "./security.js";
import type { AuthBridge } from "./authBridge.js";
import type { ClaudeAgentClient } from "./claudeAgentClient.js";
import type { ContactRegistry, CustomAgentRecord } from "./contactRegistry.js";
import type { SettingsStore } from "./settingsStore.js";
import type { ThreadStore } from "./threadStore.js";
import { SUPPORTED_MODELS, type McpServerConfig } from "../shared/claudeOptions.js";
import { listUserMcpServers, removeUserMcpServer, saveUserMcpServer } from "./mcpConfigWriter.js";

interface RegisterIpcHandlersOptions {
  settings: SettingsStore;
  auth: AuthBridge;
  threadStore: ThreadStore;
  contactRegistry: ContactRegistry;
  claudeClient: ClaudeAgentClient;
  windows: Map<string, BrowserWindow>;
  createBaseWindow: (key: string, opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  rendererEntryUrl: () => string;
  loadCustomAgents: () => Promise<CustomAgentRecord[]>;
  saveCustomAgents: (agents: CustomAgentRecord[]) => Promise<void>;
  logDebug: (event: string, details?: Record<string, unknown>) => void;
}

interface NotImplementedResult {
  ok: false;
  reason: "not-implemented";
  channel: string;
}

const notImplemented = (channel: string): NotImplementedResult => ({
  ok: false,
  reason: "not-implemented",
  channel
});

function safeHandle<P, R>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, payload: P) => Promise<R> | R,
  logDebug: RegisterIpcHandlersOptions["logDebug"]
): void {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return await handler(event, payload as P);
    } catch (error) {
      logDebug(`ipc.error`, {
        channel,
        message: error instanceof Error ? error.message : String(error)
      });
      return {
        ok: false,
        reason: "exception",
        channel,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
  const {
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
  } = options;

  // ── App lifecycle ─────────────────────────────────────────────────────
  safeHandle<BootstrapPayload, BootstrapResult>(
    IPC_CHANNELS.appBootstrap,
    async () => {
      const { settings: current } = await settings.load();
      const authStatus = await auth.status();
      return {
        appVersion: app.getVersion(),
        settings: current,
        authReady: authStatus.ready,
        contacts: contactRegistry.list(),
        recentThreads: contactRegistry.recentThreads(30)
      } satisfies BootstrapResult;
    },
    logDebug
  );

  safeHandle<{ event: string; details?: unknown }, { ok: true }>(
    IPC_CHANNELS.appLog,
    async (_event, payload) => {
      logDebug(`renderer.${payload.event}`, { details: payload.details });
      return { ok: true };
    },
    logDebug
  );

  safeHandle<void, { ok: true }>(
    IPC_CHANNELS.appQuit,
    async () => {
      app.quit();
      return { ok: true };
    },
    logDebug
  );

  safeHandle<void, { ok: true }>(
    IPC_CHANNELS.appReload,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      win?.reload();
      return { ok: true };
    },
    logDebug
  );

  safeHandle<string, { ok: boolean; reason?: string }>(
    IPC_CHANNELS.appOpenPath,
    async (_event, targetPath) => {
      if (typeof targetPath !== "string" || !targetPath) {
        return { ok: false, reason: "invalid-path" };
      }
      const result = await shell.openPath(targetPath);
      return result === "" ? { ok: true } : { ok: false, reason: result };
    },
    logDebug
  );

  safeHandle<string, { ok: boolean }>(
    IPC_CHANNELS.appShowItem,
    async (_event, targetPath) => {
      if (typeof targetPath !== "string" || !targetPath) return { ok: false };
      shell.showItemInFolder(targetPath);
      return { ok: true };
    },
    logDebug
  );

  // ── Settings ──────────────────────────────────────────────────────────
  safeHandle<void, AppSettings>(
    IPC_CHANNELS.settingsGet,
    async () => (await settings.load()).settings,
    logDebug
  );

  safeHandle<Partial<AppSettings>, AppSettings>(
    IPC_CHANNELS.settingsSet,
    async (_event, partial) => {
      if (!partial || typeof partial !== "object") {
        throw new Error("settings payload must be an object");
      }
      const updated = await settings.patch(partial);
      // demoMode toggle should refresh the contact roster live.
      if ("demoMode" in partial) {
        await contactRegistry.refresh();
        for (const win of windows.values()) {
          if (!win.isDestroyed()) win.webContents.send("conversation:notify", { kind: "contacts" });
        }
      }
      return updated;
    },
    logDebug
  );

  // ── Auth ──────────────────────────────────────────────────────────────
  safeHandle<AuthSignInPayload, { ok: boolean; mode: string }>(
    IPC_CHANNELS.authSignIn,
    async (_event, payload) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("auth payload must be an object");
      }
      if (payload.mode === "api-key" && payload.apiKey) {
        await auth.storeApiKey(payload.apiKey);
        await settings.patch({ authMode: "api-key", apiKeyStored: true });
      } else if (payload.mode === "oauth-claude") {
        await settings.patch({ authMode: "oauth-claude" });
      }
      const status = await auth.applyToProcessEnv();
      return { ok: true, mode: status };
    },
    logDebug
  );

  safeHandle<void, Awaited<ReturnType<AuthBridge["status"]>>>(
    IPC_CHANNELS.authStatus,
    async () => auth.status(),
    logDebug
  );

  safeHandle<void, { ok: true }>(
    IPC_CHANNELS.authSignOut,
    async () => {
      await auth.clearApiKey();
      await settings.patch({ authMode: "unset", apiKeyStored: false });
      return { ok: true };
    },
    logDebug
  );

  // ── Contacts ──────────────────────────────────────────────────────────
  safeHandle<void, Contact[]>(IPC_CHANNELS.contactsList, async () => contactRegistry.list(), logDebug);

  safeHandle<CreateAgentPayload, { ok: boolean; id?: string; message?: string }>(
    IPC_CHANNELS.contactsCreate,
    async (_event, payload) => {
      if (!payload?.displayName || !payload?.systemPrompt) {
        return { ok: false, message: "Nom et instructions requis." };
      }
      const id = `agent:custom:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const record: CustomAgentRecord = {
        id,
        displayName: payload.displayName,
        group: payload.group || "Subagents",
        iconKey: payload.iconKey || "robot",
        ...(payload.color ? { color: payload.color } : {}),
        systemPrompt: payload.systemPrompt,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.workingDirectory ? { workingDirectory: payload.workingDirectory } : {})
      };
      const existing = await loadCustomAgents();
      await saveCustomAgents([...existing, record]);
      await contactRegistry.refresh();
      for (const win of windows.values()) {
        if (!win.isDestroyed()) win.webContents.send("conversation:notify", { kind: "contacts" });
      }
      return { ok: true, id };
    },
    logDebug
  );
  safeHandle<{ contactId: string; displayName: string }, NotImplementedResult>(
    IPC_CHANNELS.contactsRename,
    async () => notImplemented(IPC_CHANNELS.contactsRename),
    logDebug
  );
  safeHandle<{ contactId: string; status: "online" | "busy" | "away" | "offline" | "streaming"; statusMessage?: string }, { ok: true }>(
    IPC_CHANNELS.contactsSetStatus,
    async (_event, payload) => {
      contactRegistry.setContactStatus(payload.contactId, payload.status, payload.statusMessage);
      return { ok: true };
    },
    logDebug
  );

  // ── Models ────────────────────────────────────────────────────────────
  safeHandle<void, { id: string }[]>(
    IPC_CHANNELS.modelsList,
    async () => SUPPORTED_MODELS.map((id) => ({ id })),
    logDebug
  );

  // ── MCP servers ──────────────────────────────────────────────────────
  safeHandle<void, Record<string, McpServerConfig>>(
    IPC_CHANNELS.mcpList,
    async () => listUserMcpServers(),
    logDebug
  );

  safeHandle<{ name: string; config: McpServerConfig }, { ok: true }>(
    IPC_CHANNELS.mcpSave,
    async (_event, payload) => {
      if (!payload?.name) throw new Error("name is required");
      if (!payload.config?.type) throw new Error("config.type is required");
      await saveUserMcpServer(payload.name, payload.config);
      return { ok: true };
    },
    logDebug
  );

  safeHandle<string, { ok: true }>(
    IPC_CHANNELS.mcpRemove,
    async (_event, name) => {
      if (typeof name !== "string" || !name) throw new Error("name is required");
      await removeUserMcpServer(name);
      return { ok: true };
    },
    logDebug
  );

  // ── Conversations ─────────────────────────────────────────────────────
  safeHandle<string, { ok: true; windowKey: string }>(
    IPC_CHANNELS.conversationOpen,
    async (_event, contactId) => {
      const key = `conversation:${contactId}`;
      const existing = windows.get(key);
      if (existing && !existing.isDestroyed()) {
        existing.focus();
        return { ok: true, windowKey: key };
      }
      const win = createBaseWindow(key, {
        width: 520,
        height: 600,
        minWidth: 360,
        minHeight: 420
      });
      const url = `${rendererEntryUrl()}?view=conversation&contactId=${encodeURIComponent(contactId)}`;
      await win.loadURL(url);
      return { ok: true, windowKey: key };
    },
    logDebug
  );

  safeHandle<{ contactId: string; threadId?: string; createNew?: boolean }, { thread: ThreadSummary; messages: Message[] }>(
    IPC_CHANNELS.conversationLoadThread,
    async (_event, payload) => {
      const contact = contactRegistry.list().find((c) => c.id === payload.contactId);
      if (!contact) throw new Error(`Unknown contact: ${payload.contactId}`);
      const now = new Date().toISOString();
      let threadId: string;

      if (payload.threadId) {
        threadId = payload.threadId;
      } else if (payload.createNew) {
        threadId = `thread:${randomUUID()}`;
      } else {
        const existing = threadStore.listThreadsForContact(contact.id, 1);
        threadId = existing[0]?.id ?? `thread:${randomUUID()}`;
      }

      const existing = threadStore.getThread(threadId);
      if (!existing) {
        threadStore.upsertThread({
          id: threadId,
          contactId: contact.id,
          sessionId: null,
          title: contact.displayName,
          createdAt: now,
          updatedAt: now,
          lastMessagePreview: "",
          unread: 0
        });
      }
      const persisted = threadStore.getThread(threadId);
      const messages = threadStore.listMessages(threadId, { limit: 200 });
      const summary: ThreadSummary = {
        id: threadId,
        contactId: contact.id,
        title: persisted?.title ?? contact.displayName,
        lastMessagePreview: persisted?.lastMessagePreview ?? "",
        updatedAt: persisted?.updatedAt ?? now,
        unread: persisted?.unread ?? 0
      };
      if (persisted?.sessionId) summary.sessionId = persisted.sessionId;

      await claudeClient.startSession({
        contact,
        threadId,
        ...(persisted?.sessionId ? { resumeSessionId: persisted.sessionId } : {}),
        ...(contact.workingDirectory ? { cwd: contact.workingDirectory } : {})
      });

      return { thread: summary, messages };
    },
    logDebug
  );

  safeHandle<{ contactId?: string; limit?: number }, ThreadSummary[]>(
    IPC_CHANNELS.conversationList,
    async (_event, payload) => {
      if (payload?.contactId) {
        return threadStore.listThreadsForContact(payload.contactId, payload.limit ?? 50);
      }
      return threadStore.listAllThreads(payload?.limit ?? 50);
    },
    logDebug
  );

  safeHandle<string, { ok: true }>(
    IPC_CHANNELS.conversationDeleteThread,
    async (_event, threadId) => {
      threadStore.deleteThread(threadId);
      await claudeClient.closeSession(threadId);
      return { ok: true };
    },
    logDebug
  );

  safeHandle<SendMessagePayload, { ok: true }>(
    IPC_CHANNELS.conversationSend,
    async (_event, payload) => {
      if (!payload?.threadId) throw new Error("threadId is required");
      await claudeClient.send(payload.threadId, [{ type: "text", text: payload.text }]);
      return { ok: true };
    },
    logDebug
  );

  safeHandle<SendItemsPayload, { ok: true }>(
    IPC_CHANNELS.conversationSendItems,
    async (_event, payload) => {
      if (!payload?.threadId) throw new Error("threadId is required");
      await claudeClient.send(payload.threadId, payload.items);
      return { ok: true };
    },
    logDebug
  );

  safeHandle<InterruptPayload, { ok: true }>(
    IPC_CHANNELS.conversationInterruptTurn,
    async (_event, payload) => {
      if (!payload?.threadId) throw new Error("threadId is required");
      await claudeClient.interrupt(payload.threadId);
      return { ok: true };
    },
    logDebug
  );

  safeHandle<string, { ok: true }>(
    IPC_CHANNELS.conversationRead,
    async (_event, contactId) => {
      threadStore.markRead(contactId);
      return { ok: true };
    },
    logDebug
  );

  safeHandle<string, { ok: true }>(
    IPC_CHANNELS.conversationWizz,
    async (_event, contactId) => {
      for (const win of windows.values()) {
        if (!win.isDestroyed()) win.webContents.send("window:wizz", { contactId });
      }
      return { ok: true };
    },
    logDebug
  );

  safeHandle<PermissionResponsePayload, { ok: true }>(
    IPC_CHANNELS.approvalRespond,
    async (_event, payload) => {
      claudeClient.respondPermission(payload.requestId, payload.decision);
      return { ok: true };
    },
    logDebug
  );

  // ── Media + profile + directory pickers ──────────────────────────────
  safeHandle<{ extensions?: string[]; multi?: boolean } | undefined, { ok: boolean; file?: { path: string; name: string; dataUrl?: string } }>(
    IPC_CHANNELS.mediaPickFile,
    async (event, opts) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const filters = opts?.extensions
        ? [{ name: "Files", extensions: opts.extensions }]
        : [];
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ["openFile"], filters })
        : await dialog.showOpenDialog({ properties: ["openFile"], filters });
      if (result.canceled || !result.filePaths[0]) return { ok: false };
      const filePath = result.filePaths[0];
      const name = path.basename(filePath);
      let dataUrl: string | undefined;
      try {
        const buffer = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase().slice(1);
        const mime =
          ext === "jpg" || ext === "jpeg" ? "image/jpeg"
            : ext === "gif" ? "image/gif"
            : ext === "webp" ? "image/webp"
            : "image/png";
        dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      } catch {
        dataUrl = undefined;
      }
      return { ok: true, file: dataUrl ? { path: filePath, name, dataUrl } : { path: filePath, name } };
    },
    logDebug
  );

  safeHandle<{ dataUrl: string; suggestedName?: string }, { ok: boolean; path?: string }>(
    IPC_CHANNELS.mediaSaveDataUrl,
    async (event, payload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: payload?.suggestedName ?? "image.png" })
        : await dialog.showSaveDialog({ defaultPath: payload?.suggestedName ?? "image.png" });
      if (result.canceled || !result.filePath) return { ok: false };
      const match = (payload?.dataUrl ?? "").match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return { ok: false };
      await fs.writeFile(result.filePath, Buffer.from(match[2] ?? "", "base64"));
      return { ok: true, path: result.filePath };
    },
    logDebug
  );

  safeHandle<{ sourceDataUrl?: string } | undefined, { ok: boolean; path?: string }>(
    IPC_CHANNELS.profileChoosePicture,
    async (event, payload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (payload?.sourceDataUrl) {
        const userData = app.getPath("userData");
        const profileDir = path.join(userData, "profile");
        await fs.mkdir(profileDir, { recursive: true });
        const match = payload.sourceDataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return { ok: false };
        const ext = (match[1] ?? "image/png").split("/")[1] ?? "png";
        const target = path.join(profileDir, `picture.${ext}`);
        await fs.writeFile(target, Buffer.from(match[2] ?? "", "base64"));
        await settings.patch({ profilePicturePath: target });
        return { ok: true, path: target };
      }
      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: ["openFile"],
            filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]
          })
        : await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]
          });
      if (result.canceled || !result.filePaths[0]) return { ok: false };
      await settings.patch({ profilePicturePath: result.filePaths[0] });
      return { ok: true, path: result.filePaths[0] };
    },
    logDebug
  );

  safeHandle<void, { ok: true }>(
    IPC_CHANNELS.profileClearPicture,
    async () => {
      await settings.patch({ profilePicturePath: undefined });
      return { ok: true };
    },
    logDebug
  );

  safeHandle<{ title?: string } | undefined, { ok: boolean; path?: string }>(
    IPC_CHANNELS.appChooseDirectory,
    async (event, opts) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const dialogOpts = {
        properties: ["openDirectory" as const],
        ...(opts?.title ? { title: opts.title } : {})
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);
      if (result.canceled || !result.filePaths[0]) return { ok: false };
      return { ok: true, path: result.filePaths[0] };
    },
    logDebug
  );

  safeHandle<{ text: string; suggestedName?: string }, { ok: boolean; path?: string }>(
    IPC_CHANNELS.appSaveText,
    async (event, payload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: payload?.suggestedName ?? "transcript.txt" })
        : await dialog.showSaveDialog({ defaultPath: payload?.suggestedName ?? "transcript.txt" });
      if (result.canceled || !result.filePath) return { ok: false };
      await fs.writeFile(result.filePath, payload?.text ?? "", "utf8");
      return { ok: true, path: result.filePath };
    },
    logDebug
  );

  // ── Updates ──────────────────────────────────────────────────────────
  const releasesEndpoint = "https://api.github.com/repos/Twinded/claude-messenger/releases/latest";

  function compareSemver(a: string, b: string): number {
    const parse = (v: string) =>
      v.replace(/^v/i, "").split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0);
    const aa = parse(a);
    const bb = parse(b);
    const len = Math.max(aa.length, bb.length);
    for (let i = 0; i < len; i += 1) {
      if ((aa[i] ?? 0) > (bb[i] ?? 0)) return 1;
      if ((aa[i] ?? 0) < (bb[i] ?? 0)) return -1;
    }
    return 0;
  }

  safeHandle<{ force?: boolean } | undefined, {
    checkedAt: string;
    front: { currentVersion: string; latestVersion: string; updateAvailable: boolean; error?: string };
    app: { currentVersion: string; latestVersion: string; updateAvailable: boolean; error?: string };
  }>(
    IPC_CHANNELS.updatesCheck,
    async () => {
      const checkedAt = new Date().toISOString();
      const currentVersion = app.getVersion();
      try {
        const res = await fetch(releasesEndpoint, {
          headers: { "User-Agent": `claude-messenger/${currentVersion}` }
        });
        if (!res.ok) {
          return {
            checkedAt,
            front: { currentVersion, latestVersion: "", updateAvailable: false, error: `HTTP ${res.status}` },
            app: { currentVersion: "claude-agent-sdk", latestVersion: "", updateAvailable: false }
          };
        }
        const data = (await res.json()) as { tag_name?: string };
        const latestVersion = (data.tag_name ?? "").replace(/^v/i, "");
        return {
          checkedAt,
          front: {
            currentVersion,
            latestVersion,
            updateAvailable: latestVersion ? compareSemver(latestVersion, currentVersion) > 0 : false
          },
          app: { currentVersion: "claude-agent-sdk", latestVersion: "", updateAvailable: false }
        };
      } catch (error) {
        return {
          checkedAt,
          front: {
            currentVersion,
            latestVersion: "",
            updateAvailable: false,
            error: error instanceof Error ? error.message : String(error)
          },
          app: { currentVersion: "claude-agent-sdk", latestVersion: "", updateAvailable: false }
        };
      }
    },
    logDebug
  );

  safeHandle<string, { ok: boolean }>(
    IPC_CHANNELS.updatesOpen,
    async (_event, target) => {
      const url = target === "front"
        ? "https://github.com/Twinded/claude-messenger/releases/latest"
        : "https://docs.anthropic.com/claude/docs/agents-and-tools/agent-sdk";
      if (!isSafeExternalUrl(url)) return { ok: false };
      await shell.openExternal(url);
      return { ok: true };
    },
    logDebug
  );

  // Update install / restart are intentionally not auto-applied. We open
  // the release page so the user installs from the official artifact.
  safeHandle<string, { ok: true; needsRestart: boolean; quitStarted: boolean; message: string }>(
    IPC_CHANNELS.updatesInstall,
    async (_event, target) => {
      const url = target === "front"
        ? "https://github.com/Twinded/claude-messenger/releases/latest"
        : "https://docs.anthropic.com/claude/docs/agents-and-tools/agent-sdk";
      if (isSafeExternalUrl(url)) await shell.openExternal(url);
      return {
        ok: true,
        needsRestart: false,
        quitStarted: false,
        message: "Téléchargement ouvert dans le navigateur."
      };
    },
    logDebug
  );

  safeHandle<string, { ok: true }>(
    IPC_CHANNELS.updatesRestart,
    async () => {
      app.relaunch();
      app.exit(0);
      return { ok: true };
    },
    logDebug
  );

  // Reorder threads — approximates a custom order by bumping updated_at
  // incrementally so the default DESC sort matches the requested order.
  safeHandle<{ contactId: string; threadIds: string[] }, { ok: true }>(
    IPC_CHANNELS.conversationReorderThreads,
    async (_event, payload) => {
      const ts = Date.now();
      payload.threadIds.forEach((id, index) => {
        const existing = threadStore.getThread(id);
        if (!existing) return;
        threadStore.upsertThread({
          id,
          contactId: existing.contactId,
          sessionId: existing.sessionId,
          title: existing.title,
          createdAt: existing.createdAt,
          updatedAt: new Date(ts - index).toISOString(),
          lastMessagePreview: existing.lastMessagePreview,
          unread: existing.unread
        });
      });
      return { ok: true };
    },
    logDebug
  );

  // ── Channels still pending real implementation ────────────────────────
  const stubbedChannels: readonly string[] = [
    IPC_CHANNELS.conversationOpenThread,
    IPC_CHANNELS.conversationOpenProject,
    IPC_CHANNELS.conversationSwitchThread,
    IPC_CHANNELS.conversationLoadPreviousMessages,
    IPC_CHANNELS.conversationCompact,
    IPC_CHANNELS.conversationFork
  ];
  for (const channel of stubbedChannels) {
    safeHandle<unknown, NotImplementedResult>(
      channel,
      async () => notImplemented(channel),
      logDebug
    );
  }

  // ── Window controls ───────────────────────────────────────────────────
  safeHandle<void, { ok: true }>(
    IPC_CHANNELS.windowMinimize,
    async (event) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize();
      return { ok: true };
    },
    logDebug
  );
  safeHandle<void, { ok: true }>(
    IPC_CHANNELS.windowMaximize,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win?.isMaximized()) win.unmaximize();
      else win?.maximize();
      return { ok: true };
    },
    logDebug
  );
  safeHandle<void, { width: number; height: number; x: number; y: number } | null>(
    IPC_CHANNELS.windowGetBounds,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return win?.getBounds() ?? null;
    },
    logDebug
  );
  safeHandle<{ width: number; height: number }, { ok: true }>(
    IPC_CHANNELS.windowResizeTo,
    async (event, payload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !payload || typeof payload.width !== "number" || typeof payload.height !== "number") {
        return { ok: true };
      }
      win.setSize(Math.round(payload.width), Math.round(payload.height));
      return { ok: true };
    },
    logDebug
  );
  safeHandle<number, { ok: true }>(
    IPC_CHANNELS.windowSetZoomFactor,
    async (event, factor) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const numeric = typeof factor === "number" && factor > 0 ? Math.min(factor, 3) : 1;
      win?.webContents.setZoomFactor(numeric);
      return { ok: true };
    },
    logDebug
  );
  safeHandle<void, { ok: true }>(
    IPC_CHANNELS.windowClose,
    async (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
      return { ok: true };
    },
    logDebug
  );

  void isSafeExternalUrl;
}
