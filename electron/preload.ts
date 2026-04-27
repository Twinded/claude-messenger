/**
 * Preload script — runs in the renderer's isolated context. Exposes a
 * narrow, fully-typed `claudeMsn` API on `window` via contextBridge.
 *
 * The preload is the only surface that talks to the main process from the
 * renderer. Every IPC channel listed here is allowlisted; unknown channels
 * are rejected by `on()`.
 *
 * Compiled to `dist-electron/preload.cjs` for Electron's CJS preload
 * loader (the main process and renderer otherwise run as ESM).
 */

import { contextBridge, ipcRenderer } from "electron";

import {
  IPC_CHANNELS,
  STREAM_CHANNELS,
  type AuthSignInPayload,
  type BootstrapPayload,
  type CreateAgentPayload,
  type InterruptPayload,
  type PermissionResponsePayload,
  type SendItemsPayload,
  type SendMessagePayload,
  type StreamChannel,
  type StreamEvent
} from "../shared/types.js";

const allowedStreamChannels: ReadonlySet<string> = new Set(Object.values(STREAM_CHANNELS));

type StreamListener = (event: StreamEvent) => void;
type ChannelListener = (payload: unknown) => void;

function on(channel: StreamChannel | string, callback: StreamListener | ChannelListener): () => void {
  if (!allowedStreamChannels.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    (callback as ChannelListener)(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const claudeMsn = {
  bootstrap: () => {
    const search = new URLSearchParams(window.location.search);
    const view = (search.get("view") ?? "main") as BootstrapPayload["view"];
    const contactId = search.get("contactId") ?? undefined;
    const payload: BootstrapPayload = contactId ? { view, contactId } : { view };
    return ipcRenderer.invoke(IPC_CHANNELS.appBootstrap, payload);
  },

  // Auth
  signIn: (payload: AuthSignInPayload) => ipcRenderer.invoke(IPC_CHANNELS.authSignIn, payload),
  authStatus: () => ipcRenderer.invoke(IPC_CHANNELS.authStatus),
  signOut: () => ipcRenderer.invoke(IPC_CHANNELS.authSignOut),

  // Settings
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  setSettings: (settings: unknown) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, settings),

  // Contacts
  listContacts: () => ipcRenderer.invoke(IPC_CHANNELS.contactsList),
  createAgent: (agent: CreateAgentPayload) => ipcRenderer.invoke(IPC_CHANNELS.contactsCreate, agent),
  renameContact: (payload: { contactId: string; displayName: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.contactsRename, payload),
  setContactStatus: (payload: { contactId: string; status: string; statusMessage?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.contactsSetStatus, payload),

  // Conversations
  openConversation: (contactId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationOpen, contactId),
  openThread: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.conversationOpenThread, threadId),
  openProject: (cwd: string) => ipcRenderer.invoke(IPC_CHANNELS.conversationOpenProject, cwd),
  switchThread: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationSwitchThread, threadId),
  loadThread: (payload: { contactId: string; threadId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationLoadThread, payload),
  loadPreviousMessages: (payload: { threadId: string; before?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationLoadPreviousMessages, payload),
  listConversations: (options?: { contactId?: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationList, options),
  reorderThreads: (payload: { contactId: string; threadIds: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationReorderThreads, payload),
  deleteThread: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationDeleteThread, threadId),
  sendMessage: (payload: SendMessagePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationSend, payload),
  sendItems: (payload: SendItemsPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationSendItems, payload),
  interruptTurn: (payload: InterruptPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationInterruptTurn, payload),
  compactThread: (payload: { threadId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationCompact, payload),
  forkThread: (payload: { threadId: string; messageId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.conversationFork, payload),
  markRead: (contactId: string) => ipcRenderer.invoke(IPC_CHANNELS.conversationRead, contactId),
  wizz: (contactId: string) => ipcRenderer.invoke(IPC_CHANNELS.conversationWizz, contactId),

  // Models
  listModels: () => ipcRenderer.invoke(IPC_CHANNELS.modelsList),

  // MCP servers
  listMcpServers: () => ipcRenderer.invoke(IPC_CHANNELS.mcpList),
  saveMcpServer: (payload: { name: string; config: unknown }) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpSave, payload),
  removeMcpServer: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.mcpRemove, name),

  // Approvals
  respondApproval: (payload: PermissionResponsePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.approvalRespond, payload),

  // Media
  pickFile: (options?: { extensions?: string[]; multi?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.mediaPickFile, options),
  saveDataUrl: (payload: { dataUrl: string; suggestedName?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.mediaSaveDataUrl, payload),

  // Profile
  chooseProfilePicture: (options?: { sourceDataUrl?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.profileChoosePicture, options),
  clearProfilePicture: () => ipcRenderer.invoke(IPC_CHANNELS.profileClearPicture),

  // Updates
  checkUpdates: (options?: { manual?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.updatesCheck, options),
  openUpdateTarget: (target: string) => ipcRenderer.invoke(IPC_CHANNELS.updatesOpen, target),
  installUpdateTarget: (target: string) => ipcRenderer.invoke(IPC_CHANNELS.updatesInstall, target),
  restartForUpdate: (target: string) => ipcRenderer.invoke(IPC_CHANNELS.updatesRestart, target),

  // Misc
  saveText: (payload: { text: string; suggestedName?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.appSaveText, payload),
  log: (event: string, details?: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.appLog, { event, details }),
  chooseDirectory: (options?: { title?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.appChooseDirectory, options),

  app: {
    openPath: (targetPath: string) => ipcRenderer.invoke(IPC_CHANNELS.appOpenPath, targetPath),
    showItem: (targetPath: string) => ipcRenderer.invoke(IPC_CHANNELS.appShowItem, targetPath),
    reload: () => ipcRenderer.invoke(IPC_CHANNELS.appReload),
    quit: () => ipcRenderer.invoke(IPC_CHANNELS.appQuit)
  },

  window: {
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
    maximize: () => ipcRenderer.invoke(IPC_CHANNELS.windowMaximize),
    getBounds: () => ipcRenderer.invoke(IPC_CHANNELS.windowGetBounds),
    resizeTo: (bounds: { width: number; height: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.windowResizeTo, bounds),
    setZoomFactor: (factor: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.windowSetZoomFactor, factor),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.windowClose)
  },

  on
} as const;

contextBridge.exposeInMainWorld("claudeMsn", claudeMsn);

declare global {
  interface Window {
    claudeMsn: typeof claudeMsn;
  }
}
