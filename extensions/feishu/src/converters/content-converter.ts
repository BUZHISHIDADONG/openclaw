/**
 * 消息内容统一转换入口
 *
 * 基于官方实现，根据消息类型分发到对应的转换器
 */

import type {
  ApiMessageItem,
  ConvertContext,
  ConvertResult,
  ContentConverterFn,
  MentionInfo,
} from "./types.js";
import { escapeRegExp } from "./utils.js";

// 转换器注册表（将在 index.ts 中填充）
export const converters = new Map<string, ContentConverterFn>();

/**
 * 从 mention 的 id 字段提取稳定标识
 *
 * 兼容两种格式：
 * - 事件推送：id 是对象 { open_id, user_id, union_id }
 * - API 响应：id 是字符串
 */
export function extractMentionOpenId(id: unknown): string {
  if (typeof id === "string") return id;
  if (id != null && typeof id === "object" && "open_id" in id) {
    const openId = (id as Record<string, unknown>).open_id;
    if (typeof openId === "string" && openId.trim().length > 0) {
      return openId;
    }
  }
  if (id != null && typeof id === "object" && "user_id" in id) {
    const userId = (id as Record<string, unknown>).user_id;
    if (typeof userId === "string" && userId.trim().length > 0) {
      return userId;
    }
  }
  return "";
}

/**
 * 转换消息内容
 *
 * @param raw 原始消息内容（JSON 字符串）
 * @param messageType 消息类型（如 "text", "post", "interactive" 等）
 * @param ctx 转换器上下文
 * @returns 转换结果（Promise，因为某些转换器需要异步操作）
 */
export async function convertMessageContent(
  raw: string,
  messageType: string,
  ctx: ConvertContext,
): Promise<ConvertResult> {
  const fn = converters.get(messageType) ?? converters.get("unknown");
  if (!fn) {
    return { content: raw, resources: [] };
  }
  return fn(raw, ctx);
}

/**
 * 从 API 消息项构建转换器上下文
 *
 * @param item API 返回的消息项
 * @param fallbackMessageId 备用消息 ID
 * @param accountId 账号 ID（可选）
 * @param resolveUserName 用户名解析函数（可选）
 * @returns 转换器上下文
 */
export function buildConvertContextFromItem(
  item: ApiMessageItem,
  fallbackMessageId: string,
  accountId?: string,
  resolveUserName?: (openId: string) => string | undefined,
): ConvertContext {
  const mentions = new Map<string, MentionInfo>();
  const mentionsByOpenId = new Map<string, MentionInfo>();

  for (const m of item.mentions ?? []) {
    const openId: string = extractMentionOpenId(m.id);
    if (!openId) continue;

    const info: MentionInfo = {
      key: m.key,
      openId,
      name: m.name ?? "",
      isBot: false,
    };
    mentions.set(m.key, info);
    mentionsByOpenId.set(openId, info);
  }

  return {
    mentions,
    mentionsByOpenId,
    messageId: item.message_id ?? fallbackMessageId,
    accountId,
    resolveUserName,
  };
}

/**
 * 解析 mention 占位符
 *
 * - Bot mention：删除占位符和 @botName（仅在 stripBotMentions=true 时）
 * - 普通 mention：替换占位符为 <at user_id="...">name</at>
 */
export function resolveMentions(text: string, ctx: ConvertContext): string {
  if (ctx.mentions.size === 0) return text;

  let result = text;
  const botOpenId = ctx.botOpenId?.trim();
  for (const [key, info] of ctx.mentions) {
    const isBotMention = info.isBot || (Boolean(botOpenId) && info.openId === botOpenId);
    if (isBotMention && ctx.stripBotMentions) {
      // 仅在事件推送场景才删除 bot mention
      result = result.replace(new RegExp(`@${escapeRegExp(info.name)}\\s*`, "g"), "").trim();
      result = result.replace(new RegExp(escapeRegExp(key) + "\\s*", "g"), "").trim();
    } else {
      result = result.replace(new RegExp(escapeRegExp(key), "g"), renderMentionTag(info));
    }
  }
  return result;
}

function renderMentionTag(info: MentionInfo): string {
  const displayName = escapeMentionDisplayName(info.name || info.openId);
  if (!info.openId) {
    return `@${displayName}`;
  }
  return `<at user_id="${info.openId}">${displayName}</at>`;
}

function escapeMentionDisplayName(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
