import type { FeishuToolsConfig } from "./types.js";

/**
 * Default tool configuration.
 * - doc, chat, wiki, drive, scopes, oauth, calendar, task, sheets, im, search:
 *   enabled by default
 * - perm: disabled by default (sensitive operation)
 */
export const DEFAULT_TOOLS_CONFIG: Required<FeishuToolsConfig> = {
  doc: true,
  chat: true,
  wiki: true,
  drive: true,
  perm: false,
  scopes: true,
  oauth: true,
  calendar: true,
  task: true,
  sheets: true,
  im: true,
  search: true,
};

/**
 * Resolve tools config with defaults.
 */
export function resolveToolsConfig(cfg?: FeishuToolsConfig): Required<FeishuToolsConfig> {
  return { ...DEFAULT_TOOLS_CONFIG, ...cfg };
}
