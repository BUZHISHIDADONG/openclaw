/**
 * 系统消息转换器
 */

import type { ContentConverterFn } from "./types.js";
import { safeParse } from "./utils.js";

export const convertSystem: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as
    | {
        template?: string;
        template_variable?: Record<string, string>;
      }
    | undefined;

  if (!parsed?.template) {
    return { content: "[System message]", resources: [] };
  }

  let text = parsed.template;

  // 替换模板变量
  if (parsed.template_variable) {
    for (const [key, value] of Object.entries(parsed.template_variable)) {
      text = text.replace(new RegExp(`\\{${key}\\}`, "g"), value);
    }
  }

  return { content: `[System] ${text}`, resources: [] };
};
