/**
 * 文本消息转换器
 */

import { resolveMentions } from "./content-converter.js";
import type { ContentConverterFn } from "./types.js";
import { safeParse } from "./utils.js";

export const convertText: ContentConverterFn = (raw, ctx) => {
  const parsed = safeParse(raw) as { text?: string } | undefined;
  const text = parsed?.text ?? raw;
  const content = resolveMentions(text, ctx);
  return { content, resources: [] };
};
