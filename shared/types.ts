/**
 * Shared types between the Electron main process and the React renderer.
 *
 * The renderer never imports from electron/* — only from shared/*. The
 * preload bridge re-exports the IPC contract typed against this file so
 * both sides agree on payload shapes at compile time.
 */

export type ContactId = string;
export type ThreadId = string;
export type SessionId = string;

export type ContactKind =
  | "main-agent"
  | "subagent"
  | "skill"
  | "project"
  | "custom"
  | "thread";

export type ContactStatus =
  | "online"
  | "busy"
  | "away"
  | "offline"
  | "streaming";

export interface Contact {
  id: ContactId;
  kind: ContactKind;
  displayName: string;
  group: string;
  iconKey: string;
  color?: string;
  status: ContactStatus;
  statusMessage?: string;
  model?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  allowedTools?: string[];
  mcpServerIds?: string[];
  unread: number;
}

export interface ThreadSummary {
  id: ThreadId;
  contactId: ContactId;
  sessionId?: SessionId;
  title: string;
  lastMessagePreview: string;
  updatedAt: string;
  unread: number;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface MessageContentText {
  type: "text";
  text: string;
}

export interface MessageContentImage {
  type: "image";
  source: { type: "base64" | "url" | "file"; data: string; mediaType?: string };
}

export interface MessageContentToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface MessageContentToolResult {
  type: "tool_result";
  toolUseId: string;
  content: string | MessageContentText[];
  isError?: boolean;
}

export interface MessageContentThinking {
  type: "thinking";
  text: string;
}

export type MessageContent =
  | MessageContentText
  | MessageContentImage
  | MessageContentToolUse
  | MessageContentToolResult
  | MessageContentThinking;

export interface Message {
  id: string;
  threadId: ThreadId;
  role: MessageRole;
  content: MessageContent[];
  createdAt: string;
  inProgress?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}

export interface AppSettings {
  language: "fr" | "en" | "es" | "ja";
  theme: "xp" | "msn-luna";
  defaultModel: string;
  maxOutputTokens: number;
  maxThinkingTokens: number;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  authMode: "oauth-claude" | "api-key" | "unset";
  apiKeyStored: boolean;
  profilePicturePath?: string;
  profileStatusMessage?: string;
  demoMode: boolean;
  windowZoomFactor: number;
}

export interface BootstrapPayload {
  view: "main" | "conversation";
  contactId?: ContactId;
}

export interface BootstrapResult {
  appVersion: string;
  settings: AppSettings;
  authReady: boolean;
  contacts: Contact[];
  recentThreads: ThreadSummary[];
}

export interface SendMessagePayload {
  contactId: ContactId;
  threadId?: ThreadId;
  text: string;
}

export interface SendItemsPayload {
  contactId: ContactId;
  threadId?: ThreadId;
  items: MessageContent[];
}

export interface InterruptPayload {
  contactId: ContactId;
  threadId?: ThreadId;
}

export interface AuthSignInPayload {
  mode: "oauth-claude" | "api-key";
  apiKey?: string;
}

export interface CreateAgentPayload {
  displayName: string;
  group: string;
  iconKey: string;
  color?: string;
  systemPrompt: string;
  model?: string;
  workingDirectory?: string;
}

/**
 * Stream events pushed from main to renderer over `claude:*` channels.
 * Mirrors the SDK's SDKMessage shape but flattened to be IPC-safe.
 */
export type StreamEvent =
  | { kind: "delta"; threadId: ThreadId; messageId: string; text: string }
  | { kind: "thinking"; threadId: ThreadId; messageId: string; text: string }
  | { kind: "tool-use"; threadId: ThreadId; messageId: string; name: string; input: unknown; toolUseId: string }
  | { kind: "tool-result"; threadId: ThreadId; toolUseId: string; content: string; isError: boolean }
  | { kind: "message-completed"; threadId: ThreadId; message: Message }
  | { kind: "turn-completed"; threadId: ThreadId; sessionId: SessionId; usage: Message["usage"] }
  | { kind: "error"; threadId?: ThreadId; message: string }
  | { kind: "permission-request"; threadId: ThreadId; toolName: string; input: unknown; requestId: string }
  | { kind: "status"; text: string };

export interface PermissionResponsePayload {
  requestId: string;
  decision: "allow" | "allow-once" | "deny";
}

export const IPC_CHANNELS = {
  appBootstrap: "app:bootstrap",
  appLog: "app:log",
  appQuit: "app:quit",
  appReload: "app:reload",
  appOpenPath: "app:open-path",
  appShowItem: "app:show-item",
  appSaveText: "app:save-text",
  appChooseDirectory: "app:choose-directory",

  authSignIn: "auth:sign-in",
  authStatus: "auth:status",
  authSignOut: "auth:sign-out",

  settingsGet: "settings:get",
  settingsSet: "settings:set",

  contactsCreate: "contacts:create-agent",
  contactsRename: "contacts:rename",
  contactsSetStatus: "contacts:set-status",
  contactsList: "contacts:list",

  conversationOpen: "conversation:open",
  conversationOpenThread: "conversation:open-thread",
  conversationOpenProject: "conversation:open-project",
  conversationSwitchThread: "conversation:switch-thread",
  conversationLoadThread: "conversation:load-thread",
  conversationLoadPreviousMessages: "conversation:load-previous-messages",
  conversationList: "conversation:list",
  conversationReorderThreads: "conversation:reorder-threads",
  conversationDeleteThread: "conversation:delete-thread",
  conversationSend: "conversation:send",
  conversationSendItems: "conversation:send-items",
  conversationInterruptTurn: "conversation:interrupt-turn",
  conversationCompact: "conversation:compact",
  conversationFork: "conversation:fork",
  conversationRead: "conversation:read",
  conversationWizz: "conversation:wizz",

  modelsList: "models:list",

  approvalRespond: "approval:respond",

  mediaPickFile: "media:pick-file",
  mediaSaveDataUrl: "media:save-data-url",

  profileChoosePicture: "profile:choose-picture",
  profileClearPicture: "profile:clear-picture",

  updatesCheck: "updates:check",
  updatesOpen: "updates:open",
  updatesInstall: "updates:install",
  updatesRestart: "updates:restart",

  windowMinimize: "window:minimize",
  windowMaximize: "window:maximize",
  windowGetBounds: "window:get-bounds",
  windowResizeTo: "window:resize-to",
  windowSetZoomFactor: "window:set-zoom-factor",
  windowClose: "window:close"
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const STREAM_CHANNELS = {
  delta: "claude:delta",
  thinking: "claude:thinking",
  toolUse: "claude:tool-use",
  toolResult: "claude:tool-result",
  messageCompleted: "claude:message-completed",
  turnCompleted: "claude:turn-completed",
  error: "claude:error",
  permissionRequest: "claude:permission-request",
  status: "claude:status",
  conversationFinished: "conversation:finished",
  conversationNotify: "conversation:notify",
  conversationUnread: "conversation:unread",
  updatesProgress: "updates:progress",
  windowWizz: "window:wizz"
} as const;

export type StreamChannel = (typeof STREAM_CHANNELS)[keyof typeof STREAM_CHANNELS];
