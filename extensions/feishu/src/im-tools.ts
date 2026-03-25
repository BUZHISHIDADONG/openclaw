import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { parseMessageContent } from "./bot-content.js";
import { createFeishuOfficialToolClient } from "./official-auth/tool-client.js";
import {
  parseRelativeTimeRange,
  parseTimeToTimestampSeconds,
  unixTimestampToISO8601,
} from "./official-time.js";
import {
  assertLarkOk,
  createFeishuToolLogger,
  handleFeishuAuthAwareError,
  json,
  resolveTrustedFeishuRequesterOpenId,
  StringEnum,
} from "./official-tools-helpers.js";
import { resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";

type SearchTimeParams = {
  relative_time?: string;
  start_time?: string;
  end_time?: string;
};

type ChatContext = {
  name?: string;
  chat_mode?: string;
  p2p_target_id?: string;
};

type FeishuImMessageItem = {
  message_id?: string;
  chat_id?: string;
  msg_type?: string;
  body?: { content?: string };
  sender?: {
    id?: string;
    sender_type?: string;
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
  create_time?: string;
  parent_id?: string;
  thread_id?: string;
  deleted?: boolean;
  updated?: boolean;
  mentions?: Array<{
    key?: string;
    name?: string;
    id?:
      | string
      | {
          open_id?: string;
          user_id?: string;
          union_id?: string;
        };
  }>;
};

const CommonTimeFiltersSchema = {
  relative_time: Type.Optional(
    Type.String({
      description:
        "相对时间范围：today / yesterday / day_before_yesterday / this_week / last_week / this_month / last_month / last_{N}_{minutes|hours|days}",
    }),
  ),
  start_time: Type.Optional(
    Type.String({
      description: "起始时间（ISO 8601 / RFC 3339 格式，例如 2026-03-24T00:00:00+08:00）",
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description: "结束时间（ISO 8601 / RFC 3339 格式，例如 2026-03-24T23:59:59+08:00）",
    }),
  ),
} as const;

const GetMessagesSchema = Type.Object({
  open_id: Type.Optional(
    Type.String({
      description: "用户 open_id（ou_xxx），获取与该用户的单聊历史。与 chat_id 二选一。",
    }),
  ),
  chat_id: Type.Optional(
    Type.String({
      description: "会话 chat_id（oc_xxx），支持群聊和单聊。与 open_id 二选一。",
    }),
  ),
  sort_rule: Type.Optional(
    StringEnum(["create_time_asc", "create_time_desc"], {
      description: "排序方式，默认 create_time_desc。",
    }),
  ),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  page_token: Type.Optional(Type.String()),
  ...CommonTimeFiltersSchema,
});

const GetThreadMessagesSchema = Type.Object({
  thread_id: Type.String({
    description: "话题 thread_id（omt_xxx）",
  }),
  sort_rule: Type.Optional(
    StringEnum(["create_time_asc", "create_time_desc"], {
      description: "排序方式，默认 create_time_desc。",
    }),
  ),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  page_token: Type.Optional(Type.String()),
});

const SearchMessagesSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "搜索关键词；空字符串表示不按内容过滤。",
    }),
  ),
  sender_ids: Type.Optional(
    Type.Array(Type.String({ description: "发送者 open_id" }), {
      maxItems: 20,
    }),
  ),
  chat_id: Type.Optional(Type.String({ description: "限定搜索范围的会话 chat_id" })),
  mention_ids: Type.Optional(
    Type.Array(Type.String({ description: "被 @ 用户 open_id" }), {
      maxItems: 20,
    }),
  ),
  message_type: Type.Optional(
    StringEnum(["file", "image", "media"], {
      description: "消息类型过滤。",
    }),
  ),
  sender_type: Type.Optional(
    StringEnum(["user", "bot", "all"], {
      description: "发送者类型过滤，默认 user。",
    }),
  ),
  chat_type: Type.Optional(
    StringEnum(["group", "p2p"], {
      description: "会话类型过滤。",
    }),
  ),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  page_token: Type.Optional(Type.String()),
  ...CommonTimeFiltersSchema,
});

type GetMessagesParams = {
  open_id?: string;
  chat_id?: string;
  sort_rule?: "create_time_asc" | "create_time_desc";
  page_size?: number;
  page_token?: string;
  relative_time?: string;
  start_time?: string;
  end_time?: string;
  accountId?: string;
};

type GetThreadMessagesParams = {
  thread_id: string;
  sort_rule?: "create_time_asc" | "create_time_desc";
  page_size?: number;
  page_token?: string;
  accountId?: string;
};

type SearchMessagesParams = SearchTimeParams & {
  query?: string;
  sender_ids?: string[];
  chat_id?: string;
  mention_ids?: string[];
  message_type?: "file" | "image" | "media";
  sender_type?: "user" | "bot" | "all";
  chat_type?: "group" | "p2p";
  page_size?: number;
  page_token?: string;
  accountId?: string;
};

type SearchMessagePayload = {
  query: string;
  from_ids?: string[];
  chat_ids?: string[];
  message_type?: "file" | "image" | "media";
  at_chatter_ids?: string[];
  from_type?: "bot" | "user";
  chat_type?: "group_chat" | "p2p_chat";
  start_time?: string;
  end_time?: string;
};

function sortRuleToSortType(
  rule?: "create_time_asc" | "create_time_desc",
): "ByCreateTimeAsc" | "ByCreateTimeDesc" {
  return rule === "create_time_asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc";
}

function extractMentionId(
  value: string | { open_id?: string; user_id?: string; union_id?: string } | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return value.open_id || value.user_id || value.union_id || undefined;
}

function formatMessage(item: FeishuImMessageItem, chatContext?: ChatContext) {
  const content = parseMessageContent(item.body?.content ?? "", item.msg_type ?? "text");
  const senderId =
    item.sender?.id ??
    item.sender?.sender_id?.open_id ??
    item.sender?.sender_id?.user_id ??
    item.sender?.sender_id?.union_id;
  const createTime = unixTimestampToISO8601(item.create_time);

  return {
    message_id: item.message_id,
    chat_id: item.chat_id,
    msg_type: item.msg_type,
    content,
    sender: {
      id: senderId,
      sender_type: item.sender?.sender_type,
    },
    create_time: createTime,
    ...(item.thread_id ? { thread_id: item.thread_id } : {}),
    ...(item.thread_id || !item.parent_id ? {} : { reply_to: item.parent_id }),
    ...(item.mentions?.length
      ? {
          mentions: item.mentions
            .map((mention) => ({
              key: mention.key,
              id: extractMentionId(mention.id),
              name: mention.name,
            }))
            .filter((mention) => mention.id || mention.name),
        }
      : {}),
    deleted: Boolean(item.deleted),
    updated: Boolean(item.updated),
    ...(chatContext?.chat_mode ? { chat_type: chatContext.chat_mode } : {}),
    ...(chatContext?.name ? { chat_name: chatContext.name } : {}),
    ...(chatContext?.chat_mode === "p2p" && chatContext.p2p_target_id
      ? {
          chat_partner: {
            open_id: chatContext.p2p_target_id,
          },
        }
      : {}),
  };
}

function resolveTimeRange(params: SearchTimeParams): { start?: string; end?: string } {
  if (params.relative_time) {
    return parseRelativeTimeRange(params.relative_time);
  }

  const start = params.start_time ? parseTimeToTimestampSeconds(params.start_time) : null;
  const end = params.end_time ? parseTimeToTimestampSeconds(params.end_time) : null;
  if (params.start_time && !start) {
    throw new Error(`Invalid start_time: ${params.start_time}`);
  }
  if (params.end_time && !end) {
    throw new Error(`Invalid end_time: ${params.end_time}`);
  }
  return {
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  };
}

async function resolveP2PChatId(
  client: ReturnType<typeof createFeishuOfficialToolClient>,
  openId: string,
): Promise<string> {
  const response = await client.invokeByPath<{
    code?: number;
    msg?: string;
    data?: { p2p_chats?: Array<{ chat_id?: string }> };
  }>("feishu_im_user_get_messages.default", "/open-apis/im/v1/chat_p2p/batch_query", {
    method: "POST",
    body: { chatter_ids: [openId] },
    query: { user_id_type: "open_id" },
    as: "user",
  });
  assertLarkOk(response);
  const chatId = response.data?.p2p_chats?.[0]?.chat_id;
  if (!chatId) {
    throw new Error(`No p2p chat found for open_id=${openId}`);
  }
  return chatId;
}

async function fetchChatContexts(
  client: ReturnType<typeof createFeishuOfficialToolClient>,
  chatIds: string[],
): Promise<Map<string, ChatContext>> {
  const result = new Map<string, ChatContext>();
  if (chatIds.length === 0) {
    return result;
  }

  const response = await client.invokeByPath<{
    code?: number;
    msg?: string;
    data?: {
      items?: Array<{
        chat_id?: string;
        name?: string;
        chat_mode?: string;
        p2p_target_id?: string;
      }>;
    };
  }>("feishu_im_user_search_messages.default", "/open-apis/im/v1/chats/batch_query", {
    method: "POST",
    body: { chat_ids: chatIds },
    query: { user_id_type: "open_id" },
    as: "user",
  });
  assertLarkOk(response);

  for (const item of response.data?.items ?? []) {
    if (!item.chat_id) {
      continue;
    }
    result.set(item.chat_id, {
      name: item.name,
      chat_mode: item.chat_mode,
      p2p_target_id: item.p2p_target_id,
    });
  }
  return result;
}

function buildSearchPayload(
  params: SearchMessagesParams,
  time: { start?: string; end?: string },
): SearchMessagePayload {
  const payload: SearchMessagePayload = {
    query: params.query ?? "",
    start_time: time.start ?? "978307200",
    end_time: time.end ?? Math.floor(Date.now() / 1000).toString(),
  };
  if (params.sender_ids?.length) {
    payload.from_ids = params.sender_ids;
  }
  if (params.chat_id) {
    payload.chat_ids = [params.chat_id];
  }
  if (params.mention_ids?.length) {
    payload.at_chatter_ids = params.mention_ids;
  }
  if (params.message_type) {
    payload.message_type = params.message_type;
  }
  if (params.sender_type && params.sender_type !== "all") {
    payload.from_type = params.sender_type;
  }
  if (params.chat_type) {
    payload.chat_type = params.chat_type === "group" ? "group_chat" : "p2p_chat";
  }
  return payload;
}

function hasSearchFilters(params: SearchMessagesParams): boolean {
  return Boolean(
    (params.query && params.query.trim()) ||
    params.sender_ids?.length ||
    params.chat_id ||
    params.mention_ids?.length ||
    params.message_type ||
    (params.sender_type && params.sender_type !== "all") ||
    params.chat_type ||
    params.relative_time ||
    params.start_time ||
    params.end_time,
  );
}

function registerGetMessagesTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      const log = createFeishuToolLogger(api, "feishu_im_user_get_messages");
      return {
        name: "feishu_im_user_get_messages",
        label: "Feishu IM Messages",
        description: "以用户身份读取指定会话或单聊的历史消息。",
        parameters: GetMessagesSchema,
        async execute(_toolCallId, params) {
          const p = params as GetMessagesParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            if (p.open_id && p.chat_id) {
              return json({ error: "open_id and chat_id are mutually exclusive" });
            }
            if (!p.open_id && !p.chat_id) {
              return json({ error: "Either open_id or chat_id is required" });
            }
            if (p.relative_time && (p.start_time || p.end_time)) {
              return json({ error: "relative_time cannot be combined with start_time/end_time" });
            }

            const chatId = p.open_id ? await resolveP2PChatId(client, p.open_id) : p.chat_id!;
            const time = resolveTimeRange(p);
            log.info(
              `chat_id=${chatId} sort=${p.sort_rule ?? "create_time_desc"} page_size=${String(p.page_size ?? 50)}`,
            );

            const response = await client.invokeByPath<{
              code?: number;
              msg?: string;
              data?: {
                items?: FeishuImMessageItem[];
                has_more?: boolean;
                page_token?: string;
              };
            }>("feishu_im_user_get_messages.default", "/open-apis/im/v1/messages", {
              method: "GET",
              query: {
                container_id_type: "chat",
                container_id: chatId,
                start_time: time.start,
                end_time: time.end,
                sort_type: sortRuleToSortType(p.sort_rule),
                page_size: p.page_size ?? 50,
                page_token: p.page_token,
                card_msg_content_type: "raw_card_content",
              },
              as: "user",
            });
            assertLarkOk(response);

            return json({
              messages: (response.data?.items ?? []).map((item) => formatMessage(item)),
              has_more: response.data?.has_more ?? false,
              page_token: response.data?.page_token,
            });
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
    { name: "feishu_im_user_get_messages" },
  );
}

function registerGetThreadMessagesTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      const log = createFeishuToolLogger(api, "feishu_im_user_get_thread_messages");
      return {
        name: "feishu_im_user_get_thread_messages",
        label: "Feishu IM Thread Messages",
        description: "以用户身份读取指定话题线程中的消息。",
        parameters: GetThreadMessagesSchema,
        async execute(_toolCallId, params) {
          const p = params as GetThreadMessagesParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            log.info(
              `thread_id=${p.thread_id} sort=${p.sort_rule ?? "create_time_desc"} page_size=${String(p.page_size ?? 50)}`,
            );

            const response = await client.invokeByPath<{
              code?: number;
              msg?: string;
              data?: {
                items?: FeishuImMessageItem[];
                has_more?: boolean;
                page_token?: string;
              };
            }>("feishu_im_user_get_thread_messages.default", "/open-apis/im/v1/messages", {
              method: "GET",
              query: {
                container_id_type: "thread",
                container_id: p.thread_id,
                sort_type: sortRuleToSortType(p.sort_rule),
                page_size: p.page_size ?? 50,
                page_token: p.page_token,
                card_msg_content_type: "raw_card_content",
              },
              as: "user",
            });
            assertLarkOk(response);

            return json({
              messages: (response.data?.items ?? []).map((item) => formatMessage(item)),
              has_more: response.data?.has_more ?? false,
              page_token: response.data?.page_token,
            });
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
    { name: "feishu_im_user_get_thread_messages" },
  );
}

function registerSearchMessagesTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      const log = createFeishuToolLogger(api, "feishu_im_user_search_messages");
      return {
        name: "feishu_im_user_search_messages",
        label: "Feishu IM Search Messages",
        description: "以用户身份跨会话搜索 IM 历史消息。",
        parameters: SearchMessagesSchema,
        async execute(_toolCallId, params) {
          const p = params as SearchMessagesParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            if (p.relative_time && (p.start_time || p.end_time)) {
              return json({ error: "relative_time cannot be combined with start_time/end_time" });
            }
            if (!hasSearchFilters(p)) {
              return json({ error: "At least one search filter is required" });
            }

            const time = resolveTimeRange(p);
            const searchPayload = buildSearchPayload(p, time);
            log.info(
              `query=${JSON.stringify(p.query ?? "")} page_size=${String(p.page_size ?? 50)}`,
            );

            const searchResponse = await client.invoke<{
              code?: number;
              msg?: string;
              data?: {
                items?: string[];
                has_more?: boolean;
                page_token?: string;
              };
            }>(
              "feishu_im_user_search_messages.default",
              (sdk, opts) =>
                sdk.search.message.create(
                  {
                    data: searchPayload,
                    params: {
                      user_id_type: "open_id",
                      page_size: p.page_size ?? 50,
                      page_token: p.page_token,
                    },
                  },
                  opts,
                ),
              { as: "user" },
            );
            assertLarkOk(searchResponse);

            const messageIds = searchResponse.data?.items ?? [];
            if (messageIds.length === 0) {
              return json({
                messages: [],
                has_more: searchResponse.data?.has_more ?? false,
                page_token: searchResponse.data?.page_token,
              });
            }

            const messageIdQuery = messageIds
              .map((messageId) => `message_ids=${encodeURIComponent(messageId)}`)
              .join("&");
            const mgetResponse = await client.invokeByPath<{
              code?: number;
              msg?: string;
              data?: {
                items?: FeishuImMessageItem[];
              };
            }>(
              "feishu_im_user_search_messages.default",
              `/open-apis/im/v1/messages/mget?${messageIdQuery}`,
              {
                method: "GET",
                query: {
                  user_id_type: "open_id",
                  card_msg_content_type: "raw_card_content",
                },
                as: "user",
              },
            );
            assertLarkOk(mgetResponse);

            const items = mgetResponse.data?.items ?? [];
            const chatIds = Array.from(
              new Set(
                items
                  .map((item) => item.chat_id)
                  .filter((value): value is string => Boolean(value)),
              ),
            );
            const chatContexts = await fetchChatContexts(client, chatIds);

            return json({
              messages: items.map((item) =>
                formatMessage(item, chatContexts.get(item.chat_id ?? "")),
              ),
              has_more: searchResponse.data?.has_more ?? false,
              page_token: searchResponse.data?.page_token,
            });
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
    { name: "feishu_im_user_search_messages" },
  );
}

export function registerFeishuOfficialImTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_im_tools: No Feishu accounts configured, skipping");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.im) {
    api.logger.debug?.("feishu_im_tools: IM tools disabled in config");
    return;
  }

  registerGetMessagesTool(api);
  registerGetThreadMessagesTool(api);
  registerSearchMessagesTool(api);
  api.logger.info?.(
    "feishu_im_tools: Registered feishu_im_user_get_messages, feishu_im_user_get_thread_messages, feishu_im_user_search_messages",
  );
}
