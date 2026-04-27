/**
 * Builds the contact list shown in the Messenger roster from:
 *
 *   - the built-in "main agent" contact (Claude Sonnet 4.6 by default)
 *   - subagents discovered by the agentsWatcher
 *   - skills discovered by the skillsWatcher
 *   - user-created custom agents (persisted in settings)
 *   - recent threads (one virtual contact per thread for quick access)
 *
 * Each source is reactive: when a watcher emits "change", the registry
 * recomputes and emits "change" so the renderer can refresh.
 */

import { EventEmitter } from "node:events";

import type {
  Contact,
  ContactStatus,
  ThreadSummary
} from "../shared/types.js";
import type { AgentsWatcher, SubagentDefinition } from "./agentsWatcher.js";
import type { SkillsWatcher, SkillDefinition } from "./skillsWatcher.js";
import type { ThreadStore } from "./threadStore.js";

export interface CustomAgentRecord {
  id: string;
  displayName: string;
  group: string;
  iconKey: string;
  color?: string;
  systemPrompt: string;
  model?: string;
  workingDirectory?: string;
}

export interface ContactRegistryOptions {
  agentsWatcher: AgentsWatcher;
  skillsWatcher: SkillsWatcher;
  threadStore: ThreadStore;
  loadCustomAgents: () => Promise<CustomAgentRecord[]>;
  defaultModel: string;
}

export interface ContactRegistry extends EventEmitter {
  refresh(): Promise<void>;
  list(): Contact[];
  setContactStatus(contactId: string, status: ContactStatus, statusMessage?: string): void;
  recentThreads(limit?: number): ThreadSummary[];
  close(): Promise<void>;
}

const MAIN_AGENT_ID = "main-agent:default";

function subagentToContact(agent: SubagentDefinition): Contact {
  return {
    id: agent.id,
    kind: "subagent",
    displayName: agent.name,
    group: agent.source === "user" ? "Subagents" : "Subagents (project)",
    iconKey: "subagent",
    status: "online",
    statusMessage: agent.description,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    allowedTools: agent.tools,
    unread: 0
  };
}

function skillToContact(skill: SkillDefinition): Contact {
  return {
    id: skill.id,
    kind: "skill",
    displayName: skill.name,
    group: skill.source === "user" ? "Skills" : "Skills (project)",
    iconKey: "skill",
    status: "online",
    statusMessage: skill.description,
    unread: 0
  };
}

function customToContact(record: CustomAgentRecord): Contact {
  return {
    id: record.id,
    kind: "custom",
    displayName: record.displayName,
    group: record.group || "Custom agents",
    iconKey: record.iconKey || "custom",
    color: record.color,
    status: "online",
    systemPrompt: record.systemPrompt,
    model: record.model,
    workingDirectory: record.workingDirectory,
    unread: 0
  };
}

export function createContactRegistry(options: ContactRegistryOptions): ContactRegistry {
  const emitter = new EventEmitter() as ContactRegistry;
  let contacts: Contact[] = [];
  const statusOverrides = new Map<string, { status: ContactStatus; statusMessage?: string }>();

  function applyOverrides(list: Contact[]): Contact[] {
    return list.map((contact) => {
      const override = statusOverrides.get(contact.id);
      if (!override) return contact;
      return { ...contact, status: override.status, statusMessage: override.statusMessage };
    });
  }

  emitter.list = () => [...contacts];

  emitter.refresh = async () => {
    const [customAgents] = await Promise.all([options.loadCustomAgents()]);

    const main: Contact = {
      id: MAIN_AGENT_ID,
      kind: "main-agent",
      displayName: "Claude",
      group: "Claude",
      iconKey: "main-agent",
      status: "online",
      statusMessage: "Ready to help",
      model: options.defaultModel,
      unread: 0
    };

    const subagents = options.agentsWatcher.list().map(subagentToContact);
    const skills = options.skillsWatcher.list().map(skillToContact);
    const customs = customAgents.map(customToContact);

    contacts = applyOverrides([main, ...subagents, ...customs, ...skills]);
    emitter.emit("change", contacts);
  };

  emitter.setContactStatus = (contactId, status, statusMessage) => {
    if (statusMessage !== undefined) {
      statusOverrides.set(contactId, { status, statusMessage });
    } else {
      statusOverrides.set(contactId, { status });
    }
    contacts = applyOverrides(contacts);
    emitter.emit("change", contacts);
  };

  emitter.recentThreads = (limit = 30) => options.threadStore.listAllThreads(limit);

  emitter.close = async () => {
    emitter.removeAllListeners();
  };

  options.agentsWatcher.on("change", () => {
    void emitter.refresh();
  });
  options.skillsWatcher.on("change", () => {
    void emitter.refresh();
  });

  return emitter;
}
