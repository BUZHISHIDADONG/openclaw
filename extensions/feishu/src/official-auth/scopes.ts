import type { FeishuUatConfig } from "../types.js";
import { FeishuUatScopePolicyError } from "./errors.js";

export const FEISHU_USER_TOOL_SCOPES = {
  "feishu_calendar_calendar.list": ["calendar:calendar:read"],
  "feishu_calendar_calendar.get": ["calendar:calendar:read"],
  "feishu_calendar_calendar.primary": ["calendar:calendar:read"],
  "feishu_calendar_event.create": [
    "calendar:calendar.event:create",
    "calendar:calendar.event:update",
  ],
  "feishu_calendar_event.list": ["calendar:calendar.event:read"],
  "feishu_calendar_event.get": ["calendar:calendar.event:read"],
  "feishu_calendar_event.patch": ["calendar:calendar.event:update"],
  "feishu_calendar_event.delete": ["calendar:calendar.event:delete"],
  "feishu_calendar_event.search": ["calendar:calendar.event:read"],
  "feishu_calendar_event.reply": ["calendar:calendar.event:reply"],
  "feishu_calendar_event.instances": ["calendar:calendar.event:read"],
  "feishu_calendar_event.instance_view": ["calendar:calendar.event:read"],
  "feishu_calendar_freebusy.list": ["calendar:calendar.free_busy:read"],
  "feishu_task_task.create": ["task:task:write", "task:task:writeonly"],
  "feishu_task_task.get": ["task:task:read", "task:task:write"],
  "feishu_task_task.list": ["task:task:read", "task:task:write"],
  "feishu_task_task.patch": ["task:task:write", "task:task:writeonly"],
  "feishu_task_tasklist.create": ["task:tasklist:write"],
  "feishu_task_tasklist.get": ["task:tasklist:read", "task:tasklist:write"],
  "feishu_task_tasklist.list": ["task:tasklist:read", "task:tasklist:write"],
  "feishu_task_tasklist.tasks": ["task:tasklist:read", "task:tasklist:write"],
  "feishu_task_tasklist.patch": ["task:tasklist:write"],
  "feishu_task_tasklist.add_members": ["task:tasklist:write"],
  "feishu_task_comment.create": ["task:comment:write"],
  "feishu_task_comment.get": ["task:comment:read", "task:comment:write"],
  "feishu_task_comment.list": ["task:comment:read", "task:comment:write"],
  "feishu_task_subtask.create": ["task:task:write"],
  "feishu_task_subtask.list": ["task:task:read", "task:task:write"],
  "feishu_im_user_get_messages.default": [
    "im:chat:read",
    "im:message:readonly",
    "im:message.group_msg:get_as_user",
    "im:message.p2p_msg:get_as_user",
    "contact:contact.base:readonly",
    "contact:user.base:readonly",
  ],
  "feishu_im_user_get_thread_messages.default": [
    "im:chat:read",
    "im:message:readonly",
    "im:message.group_msg:get_as_user",
    "im:message.p2p_msg:get_as_user",
    "contact:contact.base:readonly",
    "contact:user.base:readonly",
  ],
  "feishu_im_user_search_messages.default": [
    "im:chat:read",
    "im:message:readonly",
    "im:message.group_msg:get_as_user",
    "im:message.p2p_msg:get_as_user",
    "contact:contact.base:readonly",
    "contact:user.base:readonly",
    "search:message",
  ],
  "feishu_search_doc_wiki.search": ["search:docs:read"],
  "feishu_sheet.info": ["sheets:spreadsheet.meta:read", "sheets:spreadsheet:read"],
  "feishu_sheet.read": ["sheets:spreadsheet.meta:read", "sheets:spreadsheet:read"],
  "feishu_sheet.write": [
    "sheets:spreadsheet.meta:read",
    "sheets:spreadsheet:read",
    "sheets:spreadsheet:create",
    "sheets:spreadsheet:write_only",
  ],
  "feishu_sheet.append": [
    "sheets:spreadsheet.meta:read",
    "sheets:spreadsheet:read",
    "sheets:spreadsheet:create",
    "sheets:spreadsheet:write_only",
  ],
  "feishu_sheet.find": ["sheets:spreadsheet.meta:read", "sheets:spreadsheet:read"],
  "feishu_sheet.create": [
    "sheets:spreadsheet.meta:read",
    "sheets:spreadsheet:read",
    "sheets:spreadsheet:create",
    "sheets:spreadsheet:write_only",
  ],
  "feishu_sheet.export": ["docs:document:export"],
} as const;

export type FeishuUserToolAction = keyof typeof FEISHU_USER_TOOL_SCOPES;

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

export function parseScopeInput(scope?: string | string[]): string[] {
  if (Array.isArray(scope)) {
    return uniqueSorted(scope.map((item) => item.trim()).filter(Boolean));
  }
  if (typeof scope !== "string") {
    return [];
  }
  return uniqueSorted(
    scope
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function getFeishuRequiredScopes(toolAction: string): string[] {
  const scopes = FEISHU_USER_TOOL_SCOPES[toolAction as FeishuUserToolAction];
  return scopes ? [...scopes] : [];
}

export function applyFeishuUatScopePolicy(
  requestedScopes: string[],
  cfg?: FeishuUatConfig,
): string[] {
  const normalizedRequested = uniqueSorted(
    requestedScopes.map((item) => item.trim()).filter(Boolean),
  );
  if (normalizedRequested.length === 0) {
    return [];
  }

  const allowed = new Set((cfg?.allowedScopes ?? []).map((item) => item.trim()).filter(Boolean));
  const blocked = new Set((cfg?.blockedScopes ?? []).map((item) => item.trim()).filter(Boolean));

  const filtered = normalizedRequested.filter((scope) => {
    if (blocked.has(scope)) {
      return false;
    }
    if (allowed.size > 0 && !allowed.has(scope)) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    throw new FeishuUatScopePolicyError(normalizedRequested);
  }

  return filtered;
}

export function getAllKnownFeishuBusinessScopes(cfg?: FeishuUatConfig): string[] {
  const allScopes = uniqueSorted(Object.values(FEISHU_USER_TOOL_SCOPES).flat());
  return applyFeishuUatScopePolicy(allScopes, cfg);
}
