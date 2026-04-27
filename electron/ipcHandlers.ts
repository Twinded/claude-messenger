/**
 * Central registry for all `ipcMain.handle` channels exposed to the
 * renderer. Each handler is wrapped so unexpected errors are turned into
 * structured failure responses instead of crashing the renderer.
 *
 * Most handlers below are intentionally stubs: they return a typed
 * "not-implemented" response and will be wired to the Claude Agent SDK
 * client, contact registry, thread store, and auth bridge in Phase 3.
 */

import { app, BrowserWindow, ipcMain, shell } from "electron";

import {
  IPC_CHANNELS,
  type AppSettings,
  type AuthSignInPayload,
  type BootstrapPayload,
  type BootstrapResult,
  type Contact,
  type CreateAgentPayload,
  type InterruptPayload,
  type PermissionResponsePayload,
  type SendItemsPayload,
  type SendMessagePayload
} from "../shared/types.js";
import { isSafeExternalUrl } from "./security.js";
import type { SettingsStore } from "./settingsStore.js";

interface RegisterIpcHandlersOptions {
  settings: SettingsStore;
  windows: Map<string, BrowserWindow>;
  createBaseWindow: (key: string, opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
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

export function registerIpcHandlers({
  settings,
  windows,
  logDebug
}: RegisterIpcHandlersOptions): void {
  // ── App lifecycle ─────────────────────────────────────────────────────
  safeHandle<BootstrapPayload, BootstrapResult>(
    IPC_CHANNELS.appBootstrap,
    async () => {
      const { settings: current } = await settings.load();
      return {
        appVersion: app.getVersion(),
        settings: current,
        authReady: current.authMode !== "unset",
        contacts: [],
        recentThreads: []
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

  // ── Auth (stubbed — Phase 3 wires Claude Agent SDK + keytar) ──────────
  safeHandle<AuthSignInPayload, NotImplementedResult>(
    IPC_CHANNELS.authSignIn,
    async () => notImplemented(IPC_CHANNELS.authSignIn),
    logDebug
  );
  safeHandle<void, NotImplementedResult>(
    IPC_CHANNELS.authStatus,
    async () => notImplemented(IPC_CHANNELS.authStatus),
    logDebug
  );
  safeHandle<void, NotImplementedResult>(
    IPC_CHANNELS.authSignOut,
    async () => notImplemented(IPC_CHANNELS.authSignOut),
    logDebug
  );

  // ── Contacts (stubbed — Phase 3 reads ~/.claude/agents and skills) ───
  safeHandle<void, Contact[]>(IPC_CHANNELS.contactsList, async () => [], logDebug);
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
  safeHandle<{ contactId: string; status: string }, NotImplementedResult>(
    IPC_CHANNELS.contactsSetStatus,
    async () => notImplemented(IPC_CHANNELS.contactsSetStatus),
    logDebug
  );

  // ── Conversation channels (stubbed — Phase 3 wires SDK sessions) ─────
  const conversationChannels: readonly string[] = [
    IPC_CHANNELS.conversationOpen,
    IPC_CHANNELS.conversationOpenThread,
    IPC_CHANNELS.conversationOpenProject,
    IPC_CHANNELS.conversationSwitchThread,
    IPC_CHANNELS.conversationLoadThread,
    IPC_CHANNELS.conversationLoadPreviousMessages,
    IPC_CHANNELS.conversationList,
    IPC_CHANNELS.conversationReorderThreads,
    IPC_CHANNELS.conversationDeleteThread,
    IPC_CHANNELS.conversationCompact,
    IPC_CHANNELS.conversationFork,
    IPC_CHANNELS.conversationRead,
    IPC_CHANNELS.conversationWizz,
    IPC_CHANNELS.modelsList,
    IPC_CHANNELS.approvalRespond,
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

  for (const channel of conversationChannels) {
    safeHandle<unknown, NotImplementedResult>(
      channel,
      async () => notImplemented(channel),
      logDebug
    );
  }

  safeHandle<SendMessagePayload, NotImplementedResult>(
    IPC_CHANNELS.conversationSend,
    async () => notImplemented(IPC_CHANNELS.conversationSend),
    logDebug
  );
  safeHandle<SendItemsPayload, NotImplementedResult>(
    IPC_CHANNELS.conversationSendItems,
    async () => notImplemented(IPC_CHANNELS.conversationSendItems),
    logDebug
  );
  safeHandle<InterruptPayload, NotImplementedResult>(
    IPC_CHANNELS.conversationInterruptTurn,
    async () => notImplemented(IPC_CHANNELS.conversationInterruptTurn),
    logDebug
  );
  safeHandle<PermissionResponsePayload, NotImplementedResult>(
    IPC_CHANNELS.approvalRespond,
    async () => notImplemented(IPC_CHANNELS.approvalRespond),
    logDebug
  );

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

  void windows;
  void isSafeExternalUrl;
}
