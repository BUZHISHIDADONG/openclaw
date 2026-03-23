/**
 * 贴纸消息转换器
 */

import type { ContentConverterFn } from "./types.js";
import { safeParse } from "./utils.js";

export const convertSticker: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as { file_key?: string } | undefined;
  const fileKey = parsed?.file_key;

  if (!fileKey) {
    return { content: "[sticker]", resources: [] };
  }

  return {
    content: `<sticker key="${fileKey}"/>`,
    resources: [{ type: "sticker", fileKey }],
  };
};
