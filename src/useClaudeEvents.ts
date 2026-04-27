/**
 * React hook that subscribes to all `claude:*` and `conversation:*` IPC
 * stream channels and exposes a typed `ClaudeEventState` for the active
 * thread. Replaces `useCodexEvents.js`.
 *
 * Designed for one-thread-per-window: pass the `threadId` of the current
 * conversation and the hook filters out events from other threads.
 */

import { useEffect, useRef, useState } from "react";

import type {
  Message,
  StreamEvent,
  ThreadId
} from "../shared/types.js";

// Window.claudeMsn is declared by the preload script in electron/preload.ts.
type ClaudeMsnApi = {
  on(channel: string, listener: (payload: StreamEvent) => void): () => void;
};
const claudeMsn = (window as unknown as { claudeMsn: ClaudeMsnApi }).claudeMsn;

export interface PermissionPrompt {
  requestId: string;
  toolName: string;
  input: unknown;
}

export interface ClaudeEventState {
  messages: Message[];
  streamingText: string;
  thinkingText: string;
  isStreaming: boolean;
  pendingPermission: PermissionPrompt | null;
  error: string | null;
  lastUsage: Message["usage"] | null;
  sessionId: string | null;
}

const initialState: ClaudeEventState = {
  messages: [],
  streamingText: "",
  thinkingText: "",
  isStreaming: false,
  pendingPermission: null,
  error: null,
  lastUsage: null,
  sessionId: null
};

const STREAM_CHANNELS = [
  "claude:delta",
  "claude:thinking",
  "claude:tool-use",
  "claude:tool-result",
  "claude:message-completed",
  "claude:turn-completed",
  "claude:error",
  "claude:permission-request",
  "claude:status"
] as const;

export function useClaudeEvents(threadId: ThreadId | null): {
  state: ClaudeEventState;
  reset: () => void;
} {
  const [state, setState] = useState<ClaudeEventState>(initialState);
  const threadIdRef = useRef<ThreadId | null>(threadId);
  threadIdRef.current = threadId;

  useEffect(() => {
    if (!threadId) {
      setState(initialState);
      return;
    }
    setState(initialState);

    const offs: Array<() => void> = [];
    const matchesThread = (event: StreamEvent): boolean => {
      if (!("threadId" in event) || event.threadId === undefined) return true;
      return event.threadId === threadIdRef.current;
    };

    for (const channel of STREAM_CHANNELS) {
      const off = claudeMsn.on(channel, (event) => {
        if (!matchesThread(event)) return;
        setState((prev) => reduce(prev, event));
      });
      offs.push(off);
    }

    return () => {
      for (const off of offs) off();
    };
  }, [threadId]);

  return {
    state,
    reset: () => setState(initialState)
  };
}

function reduce(state: ClaudeEventState, event: StreamEvent): ClaudeEventState {
  switch (event.kind) {
    case "delta":
      return {
        ...state,
        isStreaming: true,
        streamingText: state.streamingText + event.text,
        thinkingText: ""
      };
    case "thinking":
      return {
        ...state,
        thinkingText: state.thinkingText + event.text
      };
    case "tool-use":
      return state;
    case "tool-result":
      return state;
    case "message-completed":
      return {
        ...state,
        messages: [...state.messages, event.message],
        streamingText: "",
        thinkingText: "",
        isStreaming: false
      };
    case "turn-completed":
      return {
        ...state,
        sessionId: event.sessionId,
        lastUsage: event.usage ?? state.lastUsage,
        isStreaming: false
      };
    case "permission-request":
      return {
        ...state,
        pendingPermission: {
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input
        }
      };
    case "error":
      return { ...state, error: event.message, isStreaming: false };
    case "status":
      return state;
    default:
      return state;
  }
}
