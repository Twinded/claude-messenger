/**
 * Central registry for all `ipcMain.handle` channels exposed to the
 * renderer. Each handler is wrapped so unexpected errors are turned into
 * structured failure responses instead of crashing the renderer.
 *
 * The handlers below dispatch to the Claude Agent SDK client, the contact
 * registry, the thread store, and the auth bridge wired up in main.ts.
 */

import { app, BrowserWindow, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";

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
import type { ContactRegistry } from "./contactRegistry.js";
import type { SettingsStore } from "./settingsStore.js";
import type { ThreadStore } from "./threadStore.js";
import { SUPPORTED_MODELS } from "../shared/claudeOptions.js";

interface RegisterIpcHandlersOptions {
  settings: SettingsStore;
  auth: AuthBridge;
  threadStore: ThreadStore;
  contactRegistry: ContactRegistry;
  claudeClient: ClaudeAgentClient;
  windows: Map<string, BrowserWindow>;
  createBaseWindow: (key: string, opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  rendererEntryUrl: () => string;
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
      return settings.patch(partial);
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

  safeHandle<CreateAgentPayload, NotImplementedResult>(
    IPC_CHANNELS.contactsCreate,
    async () => notImplemented(IPC_CHANNELS.contactsCreate),
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

  safeHandle<{ contactId: string; threadId?: string }, { thread: ThreadSummary; messages: Message[] }>(
    IPC_CHANNELS.conversationLoadThread,
    async (_event, payload) => {
      const contact = contactRegistry.list().find((c) => c.id === payload.contactId);
      if (!contact) throw new Error(`Unknown contact: ${payload.contactId}`);
      const threadId = payload.threadId ?? `thread:${randomUUID()}`;
      const existing = threadStore.getThread(threadId);
      const now = new Date().toISOString();
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

  // ── Channels still pending real implementation ────────────────────────
  const stubbedChannels: readonly string[] = [
    IPC_CHANNELS.conversationOpenThread,
    IPC_CHANNELS.conversationOpenProject,
    IPC_CHANNELS.conversationSwitchThread,
    IPC_CHANNELS.conversationLoadPreviousMessages,
    IPC_CHANNELS.conversationReorderThreads,
    IPC_CHANNELS.conversationCompact,
    IPC_CHANNELS.conversationFork,
    IPC_CHANNELS.mediaPickFile,
    IPC_CHANNELS.mediaSaveDataUrl,
    IPC_CHANNELS.profileChoosePicture,
    IPC_CHANNELS.profileClearPicture,
    IPC_CHANNELS.updatesCheck,
    IPC_CHANNELS.updatesOpen,
    IPC_CHANNELS.updatesInstall,
    IPC_CHANNELS.updatesRestart,
    IPC_CHANNELS.appSaveText,
    IPC_CHANNELS.appChooseDirectory
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
