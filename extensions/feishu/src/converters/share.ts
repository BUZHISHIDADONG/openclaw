/**
 * 分享消息转换器（分享聊天/用户卡片）
 */

import type { ContentConverterFn } from "./types.js";
import { safeParse } from "./utils.js";

type SharePayload = {
  body?: string;
  summary?: string;
  share_chat_id?: string;
  chat_id?: string;
  user_id?: string;
};

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

export const convertShareChat: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as SharePayload | undefined;

  const summary = firstNonEmptyString(parsed?.body, parsed?.summary);
  if (summary) {
    return { content: summary, resources: [] };
  }

  const shareChatId = firstNonEmptyString(parsed?.share_chat_id, parsed?.chat_id);
  if (shareChatId) {
    return { content: `[Forwarded message: ${shareChatId}]`, resources: [] };
  }

  return { content: "[Forwarded message]", resources: [] };
};

export const convertShareUser: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as SharePayload | undefined;

  const summary = firstNonEmptyString(parsed?.body, parsed?.summary);
  if (summary) {
    return { content: summary, resources: [] };
  }

  const userId = firstNonEmptyString(parsed?.user_id);
  if (userId) {
    return { content: `[Shared user: ${userId}]`, resources: [] };
  }

  return { content: "[Shared content]", resources: [] };
};
