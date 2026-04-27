/**
 * Claude Agent SDK orchestrator.
 *
 * Owns one resumable streaming session per active conversation thread.
 * Each session is backed by a single `query()` call from the Anthropic
 * Claude Agent SDK; user messages are pushed into the session through an
 * AsyncIterable input queue, while SDK messages flowing back are
 * normalized into `StreamEvent`s and emitted to the renderer through IPC.
 *
 * Permission decisions and tool approvals route through `respondPermission`
 * so the renderer can show MSN-style approval dialogs instead of letting
 * the SDK's default permission mode auto-decide.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import {
  defaultClaudeOptions,
  normalizeClaudeOptions,
  type ClaudeRuntimeOptions,
  type McpServerConfig,
  type PermissionMode
} from "../shared/claudeOptions.js";
import type {
  Contact,
  Message,
  MessageContent,
  StreamEvent,
  ThreadId
} from "../shared/types.js";
import type { ThreadStore } from "./threadStore.js";

interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: string | MessageContent[] };
  parent_tool_use_id?: string | null;
  session_id?: string;
}

interface SdkPermissionRequest {
  toolName: string;
  input: unknown;
  toolUseId: string;
}

interface SdkPermissionResponse {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
}

interface QueryHandle extends AsyncIterable<unknown> {
  interrupt?: () => Promise<void>;
}

interface SdkModuleShape {
  query: (options: {
    prompt: AsyncIterable<SdkUserMessage>;
    options: Record<string, unknown>;
  }) => QueryHandle;
}

interface PendingPermission {
  resolve: (decision: SdkPermissionResponse) => void;
  reject: (error: Error) => void;
}

export interface SessionInitOptions {
  contact: Contact;
  threadId: ThreadId;
  resumeSessionId?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface SessionHandle {
  contactId: string;
  threadId: ThreadId;
  push(message: SdkUserMessage): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface ClaudeAgentClient extends EventEmitter {
  startSession(options: SessionInitOptions): Promise<SessionHandle>;
  send(threadId: ThreadId, content: MessageContent[]): Promise<void>;
  interrupt(threadId: ThreadId): Promise<void>;
  closeSession(threadId: ThreadId): Promise<void>;
  respondPermission(requestId: string, decision: "allow" | "allow-once" | "deny"): void;
  on(event: "stream", listener: (event: StreamEvent) => void): this;
  emit(event: "stream", payload: StreamEvent): boolean;
}

export interface CreateClaudeAgentClientOptions {
  threadStore: ThreadStore;
  defaults?: Partial<ClaudeRuntimeOptions>;
  loadSdk?: () => Promise<SdkModuleShape>;
}

async function defaultLoadSdk(): Promise<SdkModuleShape> {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as SdkModuleShape;
  if (typeof mod.query !== "function") {
    throw new Error("@anthropic-ai/claude-agent-sdk: query() is missing");
  }
  return mod;
}

class InputQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) throw new Error("Input queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const next = this.buffer.shift();
          if (next !== undefined) resolve({ value: next, done: false });
          else if (this.closed) resolve({ value: undefined as T, done: true });
          else this.waiters.push(resolve);
        }),
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as T, done: true });
      }
    };
  }
}

interface ActiveSession {
  contact: Contact;
  threadId: ThreadId;
  sessionId: string | null;
  inputQueue: InputQueue<SdkUserMessage>;
  handle: QueryHandle;
  currentMessageId: string | null;
  textBuffer: string;
}

export function createClaudeAgentClient(
  options: CreateClaudeAgentClientOptions
): ClaudeAgentClient {
  const emitter = new EventEmitter() as ClaudeAgentClient;
  const sessions = new Map<ThreadId, ActiveSession>();
  const pendingPermissions = new Map<string, PendingPermission>();

  const loadSdk = options.loadSdk ?? defaultLoadSdk;

  function emit(event: StreamEvent): void {
    emitter.emit("stream", event);
  }

  function buildSdkOptions(init: SessionInitOptions): Record<string, unknown> {
    const merged: ClaudeRuntimeOptions = normalizeClaudeOptions({
      ...defaultClaudeOptions,
      ...options.defaults,
      model: (init.contact.model ?? options.defaults?.model ?? defaultClaudeOptions.model) as ClaudeRuntimeOptions["model"],
      systemPrompt: init.contact.systemPrompt,
      cwd: init.cwd ?? init.contact.workingDirectory,
      permissionMode: init.permissionMode ?? defaultClaudeOptions.permissionMode,
      allowedTools: init.contact.allowedTools,
      mcpServers: init.mcpServers,
      resumeSessionId: init.resumeSessionId
    });

    const sdkOptions: Record<string, unknown> = {
      model: merged.model,
      systemPrompt: merged.systemPrompt,
      cwd: merged.cwd,
      permissionMode: merged.permissionMode,
      maxTurns: 200,
      includePartialMessages: true,
      settingSources: merged.settingSources ?? ["user", "project"]
    };
    if (merged.allowedTools) sdkOptions.allowedTools = merged.allowedTools;
    if (merged.disallowedTools) sdkOptions.disallowedTools = merged.disallowedTools;
    if (merged.mcpServers) sdkOptions.mcpServers = merged.mcpServers;
    if (merged.resumeSessionId) sdkOptions.resume = merged.resumeSessionId;
    if (typeof merged.maxThinkingTokens === "number") {
      sdkOptions.maxThinkingTokens = merged.maxThinkingTokens;
    }

    sdkOptions.canUseTool = async (
      toolName: string,
      input: unknown
    ): Promise<SdkPermissionResponse> => {
      if (merged.permissionMode === "bypassPermissions") {
        return { behavior: "allow" };
      }
      const decision = await requestPermission(init.threadId, { toolName, input, toolUseId: randomUUID() });
      if (decision === "allow" || decision === "allow-once") return { behavior: "allow" };
      return { behavior: "deny", message: "Denied by user" };
    };

    return sdkOptions;
  }

  function requestPermission(threadId: ThreadId, request: SdkPermissionRequest): Promise<"allow" | "allow-once" | "deny"> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      pendingPermissions.set(requestId, {
        resolve: (response) => resolve(response.behavior === "allow" ? "allow" : "deny"),
        reject: () => resolve("deny")
      });
      emit({
        kind: "permission-request",
        threadId,
        toolName: request.toolName,
        input: request.input,
        requestId
      });
    });
  }

  emitter.respondPermission = (requestId, decision) => {
    const pending = pendingPermissions.get(requestId);
    if (!pending) return;
    pendingPermissions.delete(requestId);
    pending.resolve({ behavior: decision === "deny" ? "deny" : "allow" });
  };

  async function consumeStream(session: ActiveSession): Promise<void> {
    try {
      for await (const raw of session.handle) {
        handleSdkMessage(session, raw);
      }
    } catch (error) {
      emit({
        kind: "error",
        threadId: session.threadId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      sessions.delete(session.threadId);
    }
  }

  function handleSdkMessage(session: ActiveSession, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const sdk = raw as Record<string, unknown>;
    const type = String(sdk.type ?? "");

    if (type === "system" && sdk.subtype === "init" && typeof sdk.session_id === "string") {
      session.sessionId = sdk.session_id;
      options.threadStore.setSessionId(session.threadId, sdk.session_id);
      return;
    }

    if (type === "stream_event" && sdk.event && typeof sdk.event === "object") {
      const evt = sdk.event as Record<string, unknown>;
      const evtType = String(evt.type ?? "");
      if (evtType === "content_block_delta" && evt.delta) {
        const delta = evt.delta as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (!session.currentMessageId) session.currentMessageId = randomUUID();
          session.textBuffer += delta.text;
          emit({
            kind: "delta",
            threadId: session.threadId,
            messageId: session.currentMessageId,
            text: delta.text
          });
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          if (!session.currentMessageId) session.currentMessageId = randomUUID();
          emit({
            kind: "thinking",
            threadId: session.threadId,
            messageId: session.currentMessageId,
            text: delta.thinking
          });
        }
      }
      return;
    }

    if (type === "assistant" && sdk.message && typeof sdk.message === "object") {
      const message = sdk.message as Record<string, unknown>;
      const content = Array.isArray(message.content) ? (message.content as MessageContent[]) : [];
      const messageId = session.currentMessageId ?? randomUUID();
      const persisted: Message = {
        id: messageId,
        threadId: session.threadId,
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
        inProgress: false
      };
      options.threadStore.appendMessage(persisted);
      emit({ kind: "message-completed", threadId: session.threadId, message: persisted });
      session.currentMessageId = null;
      session.textBuffer = "";
      return;
    }

    if (type === "result" && typeof sdk.session_id === "string") {
      const usage = sdk.usage as Message["usage"] | undefined;
      const usageNormalized: Message["usage"] = usage
        ? {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            ...(usage.cacheReadInputTokens !== undefined
              ? { cacheReadInputTokens: usage.cacheReadInputTokens }
              : {}),
            ...(usage.cacheCreationInputTokens !== undefined
              ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
              : {})
          }
        : { inputTokens: 0, outputTokens: 0 };
      session.sessionId = sdk.session_id;
      options.threadStore.setSessionId(session.threadId, sdk.session_id);
      emit({
        kind: "turn-completed",
        threadId: session.threadId,
        sessionId: sdk.session_id,
        usage: usageNormalized
      });
    }
  }

  emitter.startSession = async (init: SessionInitOptions): Promise<SessionHandle> => {
    const existing = sessions.get(init.threadId);
    if (existing) {
      return makeHandle(existing);
    }

    const sdk = await loadSdk();
    const inputQueue = new InputQueue<SdkUserMessage>();
    const sdkOptions = buildSdkOptions(init);

    const handle = sdk.query({
      prompt: inputQueue,
      options: sdkOptions
    });

    const session: ActiveSession = {
      contact: init.contact,
      threadId: init.threadId,
      sessionId: init.resumeSessionId ?? null,
      inputQueue,
      handle,
      currentMessageId: null,
      textBuffer: ""
    };
    sessions.set(init.threadId, session);

    void consumeStream(session);
    return makeHandle(session);
  };

  function makeHandle(session: ActiveSession): SessionHandle {
    return {
      contactId: session.contact.id,
      threadId: session.threadId,
      push: (message) => session.inputQueue.push(message),
      interrupt: async () => {
        if (typeof session.handle.interrupt === "function") await session.handle.interrupt();
      },
      close: async () => {
        session.inputQueue.close();
        sessions.delete(session.threadId);
      }
    };
  }

  emitter.send = async (threadId, content) => {
    const session = sessions.get(threadId);
    if (!session) throw new Error(`No active session for thread ${threadId}`);
    const userMessage: Message = {
      id: randomUUID(),
      threadId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      inProgress: false
    };
    options.threadStore.appendMessage(userMessage);
    const sdkMessage: SdkUserMessage = {
      type: "user",
      message: { role: "user", content }
    };
    if (session.sessionId) sdkMessage.session_id = session.sessionId;
    session.inputQueue.push(sdkMessage);
  };

  emitter.interrupt = async (threadId) => {
    const session = sessions.get(threadId);
    if (!session) return;
    if (typeof session.handle.interrupt === "function") await session.handle.interrupt();
  };

  emitter.closeSession = async (threadId) => {
    const session = sessions.get(threadId);
    if (!session) return;
    session.inputQueue.close();
    sessions.delete(threadId);
  };

  return emitter;
}
