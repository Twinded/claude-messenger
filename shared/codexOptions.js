/**
 * Compatibility shim for upstream codex-messenger options.
 *
 * The upstream renderer (main.jsx) imports a fixed set of named exports
 * from `shared/codexOptions.js` and uses them to build select / picker
 * widgets. To keep the renderer code identical between codex-messenger
 * and claude-messenger, this file re-exports the same names — but
 * adjusted to the Claude / Anthropic semantics:
 *
 *   - `codexModelOptions`        → the SUPPORTED_MODELS list from
 *     `claudeOptions.ts` plus the upstream "Auto" sentinel.
 *   - `codexReasoningOptions`    → mapped to Claude's thinking budget
 *     levels. The "minimal/medium/high/xhigh" labels are kept so the
 *     upstream UI strings stay unchanged; the underlying values become
 *     Claude max_thinking_tokens hints.
 *   - `codexCwdOptions`, `codexSandboxOptions`, `codexApprovalOptions`
 *     are kept verbatim — they map cleanly onto Claude's permission
 *     modes and project working-directory choices.
 *
 * Renamed exports (`claudeModelOptions`, etc.) are also provided for new
 * code that wants the Claude-named version.
 */

import { SUPPORTED_MODELS, PERMISSION_MODES } from "./claudeOptions.js";

const modelLabels = {
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5"
};

export const codexModelOptions = [
  { value: "", label: "Auto" },
  ...SUPPORTED_MODELS.map((id) => ({ value: id, label: modelLabels[id] ?? id }))
];

export const claudeModelOptions = codexModelOptions;

export const codexReasoningOptions = [
  { value: "", label: "Auto" },
  { value: "none", label: "Aucune" },
  { value: "minimal", label: "Minimale" },
  { value: "low", label: "Rapide" },
  { value: "medium", label: "Normal" },
  { value: "high", label: "Approfondi" },
  { value: "xhigh", label: "Très approfondi" }
];

export const codexCwdOptions = [
  { value: "contact", label: "Projet/conversation" },
  { value: "local", label: "Local par défaut" }
];

export const codexSandboxOptions = [
  { value: "readOnly", label: "Lecture seule" },
  { value: "workspaceWrite", label: "Écriture workspace" },
  { value: "dangerFullAccess", label: "Accès complet" },
  { value: "externalSandbox", label: "Sandbox externe" }
];

export const codexApprovalOptions = [
  { value: "never", label: "Jamais demander" },
  { value: "on-request", label: "Sur demande" },
  { value: "on-failure", label: "Si échec" },
  { value: "untrusted", label: "Non fiable" }
];

export const claudePermissionModeOptions = PERMISSION_MODES.map((mode) => {
  const labels = {
    default: "Par défaut",
    acceptEdits: "Accepter les éditions",
    plan: "Mode plan (lecture seule)",
    bypassPermissions: "Aucune permission (avancé)"
  };
  return { value: mode, label: labels[mode] ?? mode };
});

export const defaultCodexOptions = {
  model: "",
  reasoningEffort: "",
  cwdMode: "contact",
  sandbox: "workspaceWrite",
  approvalPolicy: "never"
};

function normalizeChoice(value, options, fallback) {
  const clean = String(value ?? "");
  return options.some((option) => option.value === clean) ? clean : fallback;
}

function normalizeModelChoice(value) {
  return String(value ?? "").trim();
}

function normalizeSandboxChoice(value) {
  const clean = String(value ?? "");
  const aliases = {
    readOnly: "readOnly",
    read_only: "readOnly",
    "read-only": "readOnly",
    workspaceWrite: "workspaceWrite",
    workspace_write: "workspaceWrite",
    "workspace-write": "workspaceWrite",
    dangerFullAccess: "dangerFullAccess",
    danger_full_access: "dangerFullAccess",
    "danger-full-access": "dangerFullAccess",
    externalSandbox: "externalSandbox",
    external_sandbox: "externalSandbox",
    "external-sandbox": "externalSandbox"
  };
  return normalizeChoice(aliases[clean] ?? clean, codexSandboxOptions, defaultCodexOptions.sandbox);
}

export function normalizeCodexOptions(options = {}) {
  return {
    model: normalizeModelChoice(options.model),
    reasoningEffort: normalizeChoice(options.reasoningEffort, codexReasoningOptions, defaultCodexOptions.reasoningEffort),
    cwdMode: normalizeChoice(options.cwdMode, codexCwdOptions, defaultCodexOptions.cwdMode),
    sandbox: normalizeSandboxChoice(options.sandbox),
    approvalPolicy: normalizeChoice(options.approvalPolicy, codexApprovalOptions, defaultCodexOptions.approvalPolicy)
  };
}

export function optionLabel(options, value) {
  return options.find((option) => option.value === value)?.label ?? String(value || "Auto");
}

export function sandboxPolicyForMode(mode) {
  const sandbox = normalizeSandboxChoice(mode);
  if (sandbox === "readOnly") {
    return {
      type: "readOnly",
      access: { type: "fullAccess" },
      networkAccess: false
    };
  }
  if (sandbox === "dangerFullAccess") return { type: "dangerFullAccess" };
  if (sandbox === "externalSandbox") return { type: "externalSandbox", networkAccess: "enabled" };
  return {
    type: "workspaceWrite",
    writableRoots: [],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

/**
 * Maps the legacy Codex `approvalPolicy` + `sandbox` combination onto a
 * Claude Agent SDK `permissionMode`. This lets the upstream UI keep its
 * original picker semantics while the backend speaks SDK-native modes.
 */
export function permissionModeFromCodexOptions(opts = {}) {
  const sandbox = normalizeSandboxChoice(opts.sandbox);
  const approval = normalizeChoice(opts.approvalPolicy, codexApprovalOptions, "never");
  if (sandbox === "readOnly") return "plan";
  if (sandbox === "dangerFullAccess" || approval === "never") return "bypassPermissions";
  if (approval === "on-failure" || approval === "on-request") return "default";
  return "acceptEdits";
}
