/**
 * 位置消息转换器
 */

import type { ContentConverterFn } from "./types.js";
import { safeParse } from "./utils.js";

export const convertLocation: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as
    | {
        name?: string;
        address?: string;
        latitude?: number;
        longitude?: number;
      }
    | undefined;

  if (!parsed) {
    return { content: "[Location]", resources: [] };
  }

  const parts: string[] = [];
  if (parsed.name) parts.push(parsed.name);
  if (parsed.address) parts.push(parsed.address);
  if (parsed.latitude != null && parsed.longitude != null) {
    parts.push(`(${parsed.latitude}, ${parsed.longitude})`);
  }

  return {
    content: parts.length > 0 ? `📍 ${parts.join(" - ")}` : "[Location]",
    resources: [],
  };
};
