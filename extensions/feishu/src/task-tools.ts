import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuOfficialToolClient } from "./official-auth/tool-client.js";
import { parseTimeToTimestampMs, unixTimestampToISO8601 } from "./official-time.js";
import {
  assertLarkOk,
  createFeishuToolLogger,
  handleFeishuAuthAwareError,
  json,
  resolveTrustedFeishuRequesterOpenId,
  StringEnum,
} from "./official-tools-helpers.js";
import { resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";

const TaskMemberSchema = Type.Object({
  id: Type.String(),
  role: Type.Optional(StringEnum(["assignee", "follower"])),
});

const TasklistMemberSchema = Type.Object({
  id: Type.String(),
  role: Type.Optional(StringEnum(["editor", "viewer"])),
});

const TaskTimeSchema = Type.Object({
  timestamp: Type.String({
    description: "ISO 8601 / RFC 3339 时间，例如 2026-03-24T18:00:00+08:00",
  }),
  is_all_day: Type.Optional(Type.Boolean()),
});

const TaskTaskSchema = Type.Object({
  action: StringEnum(["create", "get", "list", "patch"]),
  task_guid: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  current_user_id: Type.Optional(
    Type.String({ description: "当前用户 open_id；不传时默认取当前 Feishu 请求人" }),
  ),
  description: Type.Optional(Type.String()),
  due: Type.Optional(TaskTimeSchema),
  start: Type.Optional(TaskTimeSchema),
  members: Type.Optional(Type.Array(TaskMemberSchema, { maxItems: 100 })),
  repeat_rule: Type.Optional(Type.String()),
  tasklists: Type.Optional(
    Type.Array(
      Type.Object({
        tasklist_guid: Type.String(),
        section_guid: Type.Optional(Type.String()),
      }),
      { maxItems: 50 },
    ),
  ),
  user_id_type: Type.Optional(StringEnum(["open_id", "union_id", "user_id"])),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  page_token: Type.Optional(Type.String()),
  completed: Type.Optional(Type.Boolean()),
  completed_at: Type.Optional(
    Type.String({
      description: "ISO 8601 / RFC 3339 时间、毫秒时间戳字符串，或 '0'（反完成）",
    }),
  ),
});

const TaskTasklistSchema = Type.Object({
  action: StringEnum(["create", "get", "list", "tasks", "patch", "add_members"]),
  tasklist_guid: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  members: Type.Optional(Type.Array(TasklistMemberSchema, { maxItems: 100 })),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  page_token: Type.Optional(Type.String()),
  completed: Type.Optional(Type.Boolean()),
});

const TaskCommentSchema = Type.Object({
  action: StringEnum(["create", "list", "get"]),
  task_guid: Type.Optional(Type.String()),
  resource_id: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  reply_to_comment_id: Type.Optional(Type.String()),
  comment_id: Type.Optional(Type.String()),
  direction: Type.Optional(StringEnum(["asc", "desc"])),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  page_token: Type.Optional(Type.String()),
});

const TaskSubtaskSchema = Type.Object({
  action: StringEnum(["create", "list"]),
  task_guid: Type.String(),
  summary: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  due: Type.Optional(TaskTimeSchema),
  start: Type.Optional(TaskTimeSchema),
  members: Type.Optional(Type.Array(TaskMemberSchema, { maxItems: 100 })),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  page_token: Type.Optional(Type.String()),
});

type TaskUserIdType = "open_id" | "union_id" | "user_id";

type TaskTaskParams = {
  action: "create" | "get" | "list" | "patch";
  task_guid?: string;
  summary?: string;
  current_user_id?: string;
  description?: string;
  due?: { timestamp: string; is_all_day?: boolean };
  start?: { timestamp: string; is_all_day?: boolean };
  members?: Array<{ id: string; role?: "assignee" | "follower" }>;
  repeat_rule?: string;
  tasklists?: Array<{ tasklist_guid: string; section_guid?: string }>;
  user_id_type?: TaskUserIdType;
  page_size?: number;
  page_token?: string;
  completed?: boolean;
  completed_at?: string;
  accountId?: string;
};

type TaskTasklistParams = {
  action: "create" | "get" | "list" | "tasks" | "patch" | "add_members";
  tasklist_guid?: string;
  name?: string;
  members?: Array<{ id: string; role?: "editor" | "viewer" }>;
  page_size?: number;
  page_token?: string;
  completed?: boolean;
  accountId?: string;
};

type TaskCommentParams = {
  action: "create" | "list" | "get";
  task_guid?: string;
  resource_id?: string;
  content?: string;
  reply_to_comment_id?: string;
  comment_id?: string;
  direction?: "asc" | "desc";
  page_size?: number;
  page_token?: string;
  accountId?: string;
};

type TaskSubtaskParams = {
  action: "create" | "list";
  task_guid: string;
  summary?: string;
  description?: string;
  due?: { timestamp: string; is_all_day?: boolean };
  start?: { timestamp: string; is_all_day?: boolean };
  members?: Array<{ id: string; role?: "assignee" | "follower" }>;
  page_size?: number;
  page_token?: string;
  accountId?: string;
};

type TaskMemberRole = "assignee" | "follower";
type TaskUserMember = {
  id: string;
  type: "user";
  role: TaskMemberRole;
};
type TasklistMemberRole = "editor" | "viewer";
type TasklistUserMember = {
  id: string;
  type: "user";
  role: TasklistMemberRole;
};

function normalizeTimeFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTimeFields(item)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith("_at") || key.endsWith("_time") || key === "timestamp") {
      result[key] = unixTimestampToISO8601(item as string | number | undefined) ?? item;
      continue;
    }
    result[key] = normalizeTimeFields(item);
  }
  return result as T;
}

function resolveTaskTimestamp(
  value: { timestamp: string; is_all_day?: boolean } | undefined,
  fieldName: string,
) {
  if (!value) {
    return undefined;
  }
  const timestamp = parseTimeToTimestampMs(value.timestamp);
  if (!timestamp) {
    throw new Error(`Invalid ${fieldName}.timestamp: ${value.timestamp}`);
  }
  return {
    timestamp,
    is_all_day: value.is_all_day ?? false,
  };
}

function resolveCompletedAt(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "0" || /^\d+$/.test(value)) {
    return value;
  }

  const timestamp = parseTimeToTimestampMs(value);
  if (!timestamp) {
    throw new Error(`Invalid completed_at: ${value}`);
  }
  return timestamp;
}

function withCurrentUserAsFollower(
  members: Array<{ id: string; role?: "assignee" | "follower" }> | undefined,
  currentUserOpenId: string | undefined,
): TaskUserMember[] | undefined {
  const next = (members ?? []).map((member) => ({
    id: member.id,
    type: "user" as const,
    role: member.role ?? "assignee",
  }));
  if (currentUserOpenId && !next.some((member) => member.id === currentUserOpenId)) {
    next.push({ id: currentUserOpenId, type: "user", role: "follower" });
  }
  return next.length > 0 ? next : undefined;
}

function normalizeTasklistMembers(
  members: Array<{ id: string; role?: "editor" | "viewer" }> | undefined,
): TasklistUserMember[] | undefined {
  if (!members?.length) {
    return undefined;
  }
  return members.map((member) => ({
    id: member.id,
    type: "user",
    role: member.role ?? "editor",
  }));
}

function registerTaskTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      const log = createFeishuToolLogger(api, "feishu_task_task");
      return {
        name: "feishu_task_task",
        label: "Feishu Task",
        description: "以用户身份创建、查询、列出和更新飞书任务。",
        parameters: TaskTaskSchema,
        async execute(_toolCallId, params) {
          const p = params as TaskTaskParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          const userIdType = p.user_id_type ?? "open_id";
          try {
            switch (p.action) {
              case "create": {
                if (!p.summary) {
                  return json({ error: "summary is required for action=create" });
                }
                const summary = p.summary;
                const currentUserOpenId = p.current_user_id?.trim() || requesterOpenId;
                const members = withCurrentUserAsFollower(p.members, currentUserOpenId);
                const due = resolveTaskTimestamp(p.due, "due");
                const start = resolveTaskTimestamp(p.start, "start");
                const taskData = {
                  summary,
                  ...(p.description !== undefined ? { description: p.description } : {}),
                  ...(due ? { due } : {}),
                  ...(start ? { start } : {}),
                  ...(members?.length ? { members } : {}),
                  ...(p.repeat_rule ? { repeat_rule: p.repeat_rule } : {}),
                  ...(p.tasklists?.length ? { tasklists: p.tasklists } : {}),
                };
                log.info(`action=create summary=${summary}`);
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: { task?: unknown };
                }>(
                  "feishu_task_task.create",
                  (sdk, opts) =>
                    sdk.task.v2.task.create(
                      {
                        params: { user_id_type: userIdType },
                        data: taskData,
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  task: normalizeTimeFields(response.data?.task ?? {}),
                });
              }
              case "get": {
                if (!p.task_guid) {
                  return json({ error: "task_guid is required for action=get" });
                }
                const response = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: { task?: unknown };
                }>(
                  "feishu_task_task.get",
                  `/open-apis/task/v2/tasks/${encodeURIComponent(p.task_guid)}`,
                  {
                    method: "GET",
                    query: { user_id_type: userIdType },
                    as: "user",
                  },
                );
                assertLarkOk(response);
                return json({
                  task: normalizeTimeFields(response.data?.task ?? {}),
                });
              }
              case "list": {
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    items?: unknown[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }>(
                  "feishu_task_task.list",
                  (sdk, opts) =>
                    sdk.task.v2.task.list(
                      {
                        params: {
                          page_size: p.page_size,
                          page_token: p.page_token,
                          completed: p.completed,
                          user_id_type: userIdType,
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  tasks: normalizeTimeFields(response.data?.items ?? []),
                  has_more: response.data?.has_more ?? false,
                  page_token: response.data?.page_token,
                });
              }
              case "patch": {
                if (!p.task_guid) {
                  return json({ error: "task_guid is required for action=patch" });
                }
                const patchData = {
                  ...(p.summary ? { summary: p.summary } : {}),
                  ...(p.description !== undefined ? { description: p.description } : {}),
                  ...(resolveTaskTimestamp(p.due, "due")
                    ? { due: resolveTaskTimestamp(p.due, "due") }
                    : {}),
                  ...(resolveTaskTimestamp(p.start, "start")
                    ? { start: resolveTaskTimestamp(p.start, "start") }
                    : {}),
                  ...(resolveCompletedAt(p.completed_at) !== undefined
                    ? { completed_at: resolveCompletedAt(p.completed_at) }
                    : {}),
                  ...(p.members?.length ? { members: p.members } : {}),
                  ...(p.repeat_rule ? { repeat_rule: p.repeat_rule } : {}),
                };
                const updateFields = Object.keys(patchData);
                if (updateFields.length === 0) {
                  return json({ error: "No fields provided for action=patch" });
                }
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: { task?: unknown };
                }>(
                  "feishu_task_task.patch",
                  (sdk, opts) =>
                    sdk.task.v2.task.patch(
                      {
                        path: { task_guid: p.task_guid! },
                        params: { user_id_type: userIdType },
                        data: {
                          task: patchData,
                          update_fields: updateFields,
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  task: normalizeTimeFields(response.data?.task ?? {}),
                });
              }
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
          } catch (error) {
            log.warn(error instanceof Error ? error.message : String(error));
            return await handleFeishuAuthAwareError({
              error,
              api,
              account: client.account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_task_task" },
  );
}

function registerTasklistTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      return {
        name: "feishu_task_tasklist",
        label: "Feishu Tasklist",
        description: "以用户身份创建、查询、列出和维护飞书任务清单。",
        parameters: TaskTasklistSchema,
        async execute(_toolCallId, params) {
          const p = params as TaskTasklistParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            switch (p.action) {
              case "create": {
                if (!p.name) {
                  return json({ error: "name is required for action=create" });
                }
                const name = p.name;
                const members = normalizeTasklistMembers(p.members);
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: { tasklist?: unknown };
                }>(
                  "feishu_task_tasklist.create",
                  (sdk, opts) =>
                    sdk.task.v2.tasklist.create(
                      {
                        params: { user_id_type: "open_id" },
                        data: {
                          name,
                          ...(members?.length ? { members } : {}),
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  tasklist: normalizeTimeFields(response.data?.tasklist ?? {}),
                });
              }
              case "get": {
                if (!p.tasklist_guid) {
                  return json({ error: "tasklist_guid is required for action=get" });
                }
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: { tasklist?: unknown };
                }>(
                  "feishu_task_tasklist.get",
                  (sdk, opts) =>
                    sdk.task.v2.tasklist.get(
                      {
                        path: { tasklist_guid: p.tasklist_guid! },
                        params: { user_id_type: "open_id" },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  tasklist: normalizeTimeFields(response.data?.tasklist ?? {}),
                });
              }
              case "list": {
                const response = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: {
                    items?: unknown[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }>("feishu_task_tasklist.list", "/open-apis/task/v2/tasklists", {
                  method: "GET",
                  query: {
                    page_size: p.page_size,
                    page_token: p.page_token,
                    user_id_type: "open_id",
                  },
                  as: "user",
                });
                assertLarkOk(response);
                return json({
                  tasklists: normalizeTimeFields(response.data?.items ?? []),
                  has_more: response.data?.has_more ?? false,
                  page_token: response.data?.page_token,
                });
              }
              case "tasks": {
                if (!p.tasklist_guid) {
                  return json({ error: "tasklist_guid is required for action=tasks" });
                }
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    items?: unknown[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }>(
                  "feishu_task_tasklist.tasks",
                  (sdk, opts) =>
                    sdk.task.v2.tasklist.tasks(
                      {
                        path: { tasklist_guid: p.tasklist_guid! },
                        params: {
                          completed: p.completed,
                          page_size: p.page_size,
                          page_token: p.page_token,
                          user_id_type: "open_id",
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  tasks: normalizeTimeFields(response.data?.items ?? []),
                  has_more: response.data?.has_more ?? false,
                  page_token: response.data?.page_token,
                });
              }
              case "patch": {
                if (!p.tasklist_guid) {
                  return json({ error: "tasklist_guid is required for action=patch" });
                }
                if (p.name === undefined) {
                  return json({ error: "name is required for action=patch" });
                }
                const name = p.name;
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: { tasklist?: unknown };
                }>(
                  "feishu_task_tasklist.patch",
                  (sdk, opts) =>
                    sdk.task.v2.tasklist.patch(
                      {
                        path: { tasklist_guid: p.tasklist_guid! },
                        params: { user_id_type: "open_id" },
                        data: {
                          tasklist: { name },
                          update_fields: ["name"],
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  tasklist: normalizeTimeFields(response.data?.tasklist ?? {}),
                });
              }
              case "add_members": {
                if (!p.tasklist_guid || !p.members?.length) {
                  return json({
                    error:
                      "tasklist_guid and non-empty members are required for action=add_members",
                  });
                }
                const members = normalizeTasklistMembers(p.members);
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: { tasklist?: unknown };
                }>(
                  "feishu_task_tasklist.add_members",
                  (sdk, opts) =>
                    sdk.task.v2.tasklist.addMembers(
                      {
                        path: { tasklist_guid: p.tasklist_guid! },
                        params: { user_id_type: "open_id" },
                        data: {
                          members: members ?? [],
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  tasklist: normalizeTimeFields(response.data?.tasklist ?? {}),
                });
              }
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
          } catch (error) {
            return await handleFeishuAuthAwareError({
              error,
              api,
              account: client.account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_task_tasklist" },
  );
}

function registerTaskCommentTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      return {
        name: "feishu_task_comment",
        label: "Feishu Task Comment",
        description: "以用户身份创建、列出和查看飞书任务评论。",
        parameters: TaskCommentSchema,
        async execute(_toolCallId, params) {
          const p = params as TaskCommentParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            switch (p.action) {
              case "create": {
                if (!p.task_guid || !p.content) {
                  return json({
                    error: "task_guid and content are required for action=create",
                  });
                }
                const taskGuid = p.task_guid;
                const content = p.content;
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: { comment?: unknown };
                }>(
                  "feishu_task_comment.create",
                  (sdk, opts) =>
                    sdk.task.v2.comment.create(
                      {
                        params: { user_id_type: "open_id" },
                        data: {
                          content,
                          resource_type: "task",
                          resource_id: taskGuid,
                          ...(p.reply_to_comment_id
                            ? { reply_to_comment_id: p.reply_to_comment_id }
                            : {}),
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  comment: normalizeTimeFields(response.data?.comment ?? {}),
                });
              }
              case "list": {
                if (!p.resource_id) {
                  return json({ error: "resource_id is required for action=list" });
                }
                const response = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: {
                    items?: unknown[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }>("feishu_task_comment.list", "/open-apis/task/v2/comments", {
                  method: "GET",
                  query: {
                    resource_type: "task",
                    resource_id: p.resource_id,
                    direction: p.direction,
                    page_size: p.page_size,
                    page_token: p.page_token,
                    user_id_type: "open_id",
                  },
                  as: "user",
                });
                assertLarkOk(response);
                return json({
                  comments: normalizeTimeFields(response.data?.items ?? []),
                  has_more: response.data?.has_more ?? false,
                  page_token: response.data?.page_token,
                });
              }
              case "get": {
                if (!p.comment_id) {
                  return json({ error: "comment_id is required for action=get" });
                }
                const response = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: { comment?: unknown };
                }>(
                  "feishu_task_comment.get",
                  `/open-apis/task/v2/comments/${encodeURIComponent(p.comment_id)}`,
                  {
                    method: "GET",
                    query: { user_id_type: "open_id" },
                    as: "user",
                  },
                );
                assertLarkOk(response);
                return json({
                  comment: normalizeTimeFields(response.data?.comment ?? {}),
                });
              }
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
          } catch (error) {
            return await handleFeishuAuthAwareError({
              error,
              api,
              account: client.account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_task_comment" },
  );
}

function registerTaskSubtaskTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      return {
        name: "feishu_task_subtask",
        label: "Feishu Task Subtask",
        description: "以用户身份创建和查询飞书任务子任务。",
        parameters: TaskSubtaskSchema,
        async execute(_toolCallId, params) {
          const p = params as TaskSubtaskParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            switch (p.action) {
              case "create": {
                if (!p.summary) {
                  return json({ error: "summary is required for action=create" });
                }
                const summary = p.summary;
                const due = resolveTaskTimestamp(p.due, "due");
                const start = resolveTaskTimestamp(p.start, "start");
                const members = withCurrentUserAsFollower(p.members, undefined);
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: { subtask?: unknown };
                }>(
                  "feishu_task_subtask.create",
                  (sdk, opts) =>
                    sdk.task.v2.taskSubtask.create(
                      {
                        path: { task_guid: p.task_guid },
                        params: { user_id_type: "open_id" },
                        data: {
                          summary,
                          ...(p.description !== undefined ? { description: p.description } : {}),
                          ...(due ? { due } : {}),
                          ...(start ? { start } : {}),
                          ...(members?.length ? { members } : {}),
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  subtask: normalizeTimeFields(response.data?.subtask ?? {}),
                });
              }
              case "list": {
                const response = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: {
                    items?: unknown[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }>(
                  "feishu_task_subtask.list",
                  `/open-apis/task/v2/tasks/${encodeURIComponent(p.task_guid)}/subtasks`,
                  {
                    method: "GET",
                    query: {
                      page_size: p.page_size,
                      page_token: p.page_token,
                      user_id_type: "open_id",
                    },
                    as: "user",
                  },
                );
                assertLarkOk(response);
                return json({
                  subtasks: normalizeTimeFields(response.data?.items ?? []),
                  has_more: response.data?.has_more ?? false,
                  page_token: response.data?.page_token,
                });
              }
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
          } catch (error) {
            return await handleFeishuAuthAwareError({
              error,
              api,
              account: client.account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_task_subtask" },
  );
}

export function registerFeishuOfficialTaskTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_task_tools: No Feishu accounts configured, skipping");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.task) {
    api.logger.debug?.("feishu_task_tools: Task tools disabled in config");
    return;
  }

  registerTaskTool(api);
  registerTasklistTool(api);
  registerTaskCommentTool(api);
  registerTaskSubtaskTool(api);
  api.logger.info?.(
    "feishu_task_tools: Registered feishu_task_task, feishu_task_tasklist, feishu_task_comment, feishu_task_subtask",
  );
}
