/**
 * SQLite-backed persistence for threads, messages, and per-contact
 * unread counts. All operations are synchronous (better-sqlite3) and run
 * on the main process; the renderer only sees data through IPC.
 *
 * Schema is created on first open and migrated forward through small
 * append-only PRAGMA user_version steps.
 */

import path from "node:path";
import Database from "better-sqlite3";

import type {
  ContactId,
  Message,
  MessageContent,
  MessageRole,
  SessionId,
  ThreadId,
  ThreadSummary
} from "../shared/types.js";

export interface ThreadStoreOptions {
  dbPath: string;
}

export interface PersistedThread {
  id: ThreadId;
  contactId: ContactId;
  sessionId: SessionId | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string;
  unread: number;
}

interface ThreadRow {
  id: string;
  contact_id: string;
  session_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_preview: string;
  unread: number;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: MessageRole;
  content_json: string;
  created_at: string;
  in_progress: number;
  usage_json: string | null;
}

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_preview TEXT NOT NULL DEFAULT '',
  unread INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_threads_contact ON threads (contact_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  in_progress INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, created_at);
`;

export interface ThreadStore {
  upsertThread(thread: PersistedThread): void;
  setSessionId(threadId: ThreadId, sessionId: SessionId | null): void;
  listThreadsForContact(contactId: ContactId, limit?: number): ThreadSummary[];
  listAllThreads(limit?: number): ThreadSummary[];
  getThread(threadId: ThreadId): PersistedThread | null;
  deleteThread(threadId: ThreadId): void;
  appendMessage(message: Message): void;
  updateMessage(message: Message): void;
  listMessages(threadId: ThreadId, opts?: { before?: string; limit?: number }): Message[];
  markRead(contactId: ContactId): void;
  bumpUnread(contactId: ContactId, threadId: ThreadId, preview: string): void;
  close(): void;
}

export function createThreadStore({ dbPath }: ThreadStoreOptions): ThreadStore {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  const currentVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (currentVersion < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  const upsertThreadStmt = db.prepare(
    `INSERT INTO threads (id, contact_id, session_id, title, created_at, updated_at, last_message_preview, unread)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       contact_id = excluded.contact_id,
       session_id = excluded.session_id,
       title = excluded.title,
       updated_at = excluded.updated_at,
       last_message_preview = excluded.last_message_preview,
       unread = excluded.unread`
  );

  const setSessionStmt = db.prepare(
    `UPDATE threads SET session_id = ?, updated_at = ? WHERE id = ?`
  );

  const listForContactStmt = db.prepare(
    `SELECT id, contact_id, session_id, title, created_at, updated_at, last_message_preview, unread
     FROM threads WHERE contact_id = ? ORDER BY updated_at DESC LIMIT ?`
  );

  const listAllStmt = db.prepare(
    `SELECT id, contact_id, session_id, title, created_at, updated_at, last_message_preview, unread
     FROM threads ORDER BY updated_at DESC LIMIT ?`
  );

  const getThreadStmt = db.prepare(
    `SELECT id, contact_id, session_id, title, created_at, updated_at, last_message_preview, unread
     FROM threads WHERE id = ?`
  );

  const deleteThreadStmt = db.prepare(`DELETE FROM threads WHERE id = ?`);

  const appendMessageStmt = db.prepare(
    `INSERT INTO messages (id, thread_id, role, content_json, created_at, in_progress, usage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const updateMessageStmt = db.prepare(
    `UPDATE messages
     SET role = ?, content_json = ?, created_at = ?, in_progress = ?, usage_json = ?
     WHERE id = ?`
  );

  const listMessagesStmt = db.prepare(
    `SELECT id, thread_id, role, content_json, created_at, in_progress, usage_json
     FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?`
  );

  const listMessagesBeforeStmt = db.prepare(
    `SELECT id, thread_id, role, content_json, created_at, in_progress, usage_json
     FROM messages WHERE thread_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`
  );

  const markReadStmt = db.prepare(`UPDATE threads SET unread = 0 WHERE contact_id = ?`);

  const bumpUnreadStmt = db.prepare(
    `UPDATE threads SET unread = unread + 1, last_message_preview = ?, updated_at = ? WHERE id = ?`
  );

  function rowToSummary(row: ThreadRow): ThreadSummary {
    const summary: ThreadSummary = {
      id: row.id,
      contactId: row.contact_id,
      title: row.title,
      lastMessagePreview: row.last_message_preview,
      updatedAt: row.updated_at,
      unread: row.unread
    };
    if (row.session_id) summary.sessionId = row.session_id;
    return summary;
  }

  function rowToThread(row: ThreadRow): PersistedThread {
    return {
      id: row.id,
      contactId: row.contact_id,
      sessionId: row.session_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessagePreview: row.last_message_preview,
      unread: row.unread
    };
  }

  function rowToMessage(row: MessageRow): Message {
    const message: Message = {
      id: row.id,
      threadId: row.thread_id,
      role: row.role,
      content: JSON.parse(row.content_json) as MessageContent[],
      createdAt: row.created_at,
      inProgress: row.in_progress === 1
    };
    if (row.usage_json) message.usage = JSON.parse(row.usage_json) as Message["usage"];
    return message;
  }

  return {
    upsertThread(thread) {
      upsertThreadStmt.run(
        thread.id,
        thread.contactId,
        thread.sessionId,
        thread.title,
        thread.createdAt,
        thread.updatedAt,
        thread.lastMessagePreview,
        thread.unread
      );
    },

    setSessionId(threadId, sessionId) {
      setSessionStmt.run(sessionId, new Date().toISOString(), threadId);
    },

    listThreadsForContact(contactId, limit = 50) {
      const rows = listForContactStmt.all(contactId, limit) as ThreadRow[];
      return rows.map(rowToSummary);
    },

    listAllThreads(limit = 50) {
      const rows = listAllStmt.all(limit) as ThreadRow[];
      return rows.map(rowToSummary);
    },

    getThread(threadId) {
      const row = getThreadStmt.get(threadId) as ThreadRow | undefined;
      return row ? rowToThread(row) : null;
    },

    deleteThread(threadId) {
      deleteThreadStmt.run(threadId);
    },

    appendMessage(message) {
      appendMessageStmt.run(
        message.id,
        message.threadId,
        message.role,
        JSON.stringify(message.content),
        message.createdAt,
        message.inProgress ? 1 : 0,
        message.usage ? JSON.stringify(message.usage) : null
      );
    },

    updateMessage(message) {
      updateMessageStmt.run(
        message.role,
        JSON.stringify(message.content),
        message.createdAt,
        message.inProgress ? 1 : 0,
        message.usage ? JSON.stringify(message.usage) : null,
        message.id
      );
    },

    listMessages(threadId, opts = {}) {
      const limit = opts.limit ?? 200;
      if (opts.before) {
        const rows = listMessagesBeforeStmt.all(threadId, opts.before, limit) as MessageRow[];
        return rows.map(rowToMessage).reverse();
      }
      const rows = listMessagesStmt.all(threadId, limit) as MessageRow[];
      return rows.map(rowToMessage);
    },

    markRead(contactId) {
      markReadStmt.run(contactId);
    },

    bumpUnread(contactId, threadId, preview) {
      bumpUnreadStmt.run(preview, new Date().toISOString(), threadId);
    },

    close() {
      db.close();
    }
  };
}

export function resolveThreadDbPath(userDataDir: string): string {
  return path.join(userDataDir, "threads.db");
}
