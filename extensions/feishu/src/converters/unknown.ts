/**
 * 未知消息类型转换器（降级处理）
 */

import type { ContentConverterFn } from "./types.js";

export const convertUnknown: ContentConverterFn = (raw, ctx) => {
  return {
    content: `[Unknown message type: ${ctx.messageId}]`,
    resources: [],
  };
};
