/**
 * Discovers user-installed Claude skills under ~/.claude/skills/<name>/SKILL.md
 * and project-level .claude/skills/. Each skill becomes a contact in the
 * Skills group with a "When to use" description pulled from the skill's
 * frontmatter.
 */

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  source: "user" | "project";
  filePath: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

function extractField(header: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const match = header.match(re);
  return match ? match[1]!.trim().replace(/^["']|["']$/g, "") : null;
}

async function readSkill(skillRoot: string, source: SkillDefinition["source"]): Promise<SkillDefinition | null> {
  const skillFile = path.join(skillRoot, "SKILL.md");
  try {
    const raw = await fs.readFile(skillFile, "utf8");
    const fmMatch = raw.match(FRONTMATTER_RE);
    if (!fmMatch) return null;
    const header = fmMatch[1] ?? "";
    const name = extractField(header, "name") ?? path.basename(skillRoot);
    const description = extractField(header, "description") ?? "";
    return {
      id: `skill:${source}:${name}`,
      name,
      description,
      source,
      filePath: skillFile
    };
  } catch {
    return null;
  }
}

async function listSkillRoots(skillsDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(skillsDir, entry.name));
  } catch {
    return [];
  }
}

export interface SkillsWatcher extends EventEmitter {
  refresh(): Promise<void>;
  list(): SkillDefinition[];
  close(): Promise<void>;
}

export interface CreateSkillsWatcherOptions {
  cwd?: string;
}

export function createSkillsWatcher(options: CreateSkillsWatcherOptions = {}): SkillsWatcher {
  const emitter = new EventEmitter() as SkillsWatcher;
  let skills: SkillDefinition[] = [];

  const userDir = path.join(os.homedir(), ".claude", "skills");
  const projectDir = options.cwd ? path.join(options.cwd, ".claude", "skills") : null;

  emitter.list = () => [...skills];

  emitter.refresh = async () => {
    const userRoots = await listSkillRoots(userDir);
    const projectRoots = projectDir ? await listSkillRoots(projectDir) : [];
    const userSkills = (await Promise.all(userRoots.map((r) => readSkill(r, "user")))).filter(
      (s): s is SkillDefinition => s !== null
    );
    const projectSkills = (
      await Promise.all(projectRoots.map((r) => readSkill(r, "project")))
    ).filter((s): s is SkillDefinition => s !== null);
    skills = [...userSkills, ...projectSkills];
    emitter.emit("change", skills);
  };

  emitter.close = async () => {
    emitter.removeAllListeners();
  };

  return emitter;
}
