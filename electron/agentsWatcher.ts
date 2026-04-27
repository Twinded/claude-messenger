/**
 * Watches ~/.claude/agents/*.md and per-project .claude/agents/*.md,
 * parses YAML frontmatter, and emits subagent definitions that the
 * contact registry surfaces as Messenger contacts.
 */

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SubagentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  source: "user" | "project";
  filePath: string;
}

interface FrontmatterParseResult {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseFrontmatter(raw: string): FrontmatterParseResult {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: raw };
  const [, header = "", body = ""] = match;
  const frontmatter: Record<string, string | string[]> = {};
  for (const line of header.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { frontmatter, body };
}

async function readAgent(file: string, source: SubagentDefinition["source"]): Promise<SubagentDefinition | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const baseName = path.basename(file, ".md");
    const name = (typeof frontmatter.name === "string" && frontmatter.name) || baseName;
    const description =
      (typeof frontmatter.description === "string" && frontmatter.description) ||
      "Custom subagent";
    const tools =
      Array.isArray(frontmatter.tools)
        ? frontmatter.tools
        : typeof frontmatter.tools === "string" && frontmatter.tools
          ? [frontmatter.tools]
          : undefined;
    return {
      id: `agent:${source}:${baseName}`,
      name,
      description,
      systemPrompt: body.trim(),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      tools,
      source,
      filePath: file
    };
  } catch {
    return null;
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

export interface AgentsWatcher extends EventEmitter {
  refresh(): Promise<void>;
  list(): SubagentDefinition[];
  close(): Promise<void>;
}

export interface CreateAgentsWatcherOptions {
  cwd?: string;
}

export function createAgentsWatcher(options: CreateAgentsWatcherOptions = {}): AgentsWatcher {
  const emitter = new EventEmitter() as AgentsWatcher;
  let agents: SubagentDefinition[] = [];

  const userDir = path.join(os.homedir(), ".claude", "agents");
  const projectDir = options.cwd ? path.join(options.cwd, ".claude", "agents") : null;

  emitter.list = () => [...agents];

  emitter.refresh = async () => {
    const userFiles = await listMarkdown(userDir);
    const projectFiles = projectDir ? await listMarkdown(projectDir) : [];
    const userAgents = (await Promise.all(userFiles.map((f) => readAgent(f, "user")))).filter(
      (a): a is SubagentDefinition => a !== null
    );
    const projectAgents = (
      await Promise.all(projectFiles.map((f) => readAgent(f, "project")))
    ).filter((a): a is SubagentDefinition => a !== null);
    agents = [...userAgents, ...projectAgents];
    emitter.emit("change", agents);
  };

  emitter.close = async () => {
    emitter.removeAllListeners();
  };

  return emitter;
}
