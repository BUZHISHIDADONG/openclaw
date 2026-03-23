/**
 * 文件消息转换器
 */

import type { ContentConverterFn } from "./types.js";
import { safeParse } from "./utils.js";

export const convertFile: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as
    | {
        file_key?: string;
        file_name?: string;
      }
    | undefined;

  const fileKey = parsed?.file_key;
  if (!fileKey) {
    return { content: "[file]", resources: [] };
  }

  const fileName = parsed?.file_name ?? "";
  const nameAttr = fileName ? ` name="${fileName}"` : "";

  return {
    content: `<file key="${fileKey}"${nameAttr}/>`,
    resources: [{ type: "file", fileKey, fileName: fileName || undefined }],
  };
};
