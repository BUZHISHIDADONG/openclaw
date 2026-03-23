/**
 * 图片消息转换器
 */

import type { ContentConverterFn } from "./types.js";
import { safeParse } from "./utils.js";

export const convertImage: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as { image_key?: string } | undefined;
  const imageKey = parsed?.image_key;

  if (!imageKey) {
    return { content: "[image]", resources: [] };
  }

  return {
    content: `![image](${imageKey})`,
    resources: [{ type: "image", fileKey: imageKey }],
  };
};
