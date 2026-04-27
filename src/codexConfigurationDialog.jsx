/**
 * Compatibility re-export so vendored upstream renderer code that imports
 * `./codexConfigurationDialog.jsx` keeps working. The actual implementation
 * lives in `claudeConfigurationDialog.jsx`.
 */

export { ClaudeConfigurationDialog as default } from "./claudeConfigurationDialog.jsx";
export { ClaudeConfigurationDialog } from "./claudeConfigurationDialog.jsx";
