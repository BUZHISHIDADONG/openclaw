/**
 * 富文本消息转换器（Post）
 *
 * 将飞书富文本消息转换为 Markdown 格式
 */

import { resolveMentions } from "./content-converter.js";
import type { ResourceDescriptor } from "./types.js";
import type { ContentConverterFn, ConvertContext, PostElement } from "./types.js";
import { safeParse } from "./utils.js";

/** 多语言优先级 */
const LOCALE_PRIORITY = ["zh_cn", "en_us", "ja_jp"] as const;

interface PostBody {
  title?: string;
  content?: PostElement[][];
}

/**
 * 解包可能的多语言结构
 *
 * 飞书 post 消息有两种格式：
 * - 扁平：{ title, content }
 * - 多语言：{ zh_cn: { title, content }, en_us: { title, content } }
 */
function unwrapLocale(parsed: Record<string, unknown>): PostBody | undefined {
  if ("title" in parsed || "content" in parsed) {
    return parsed as unknown as PostBody;
  }

  for (const locale of LOCALE_PRIORITY) {
    const localeData = parsed[locale];
    if (localeData != null && typeof localeData === "object") {
      return localeData as PostBody;
    }
  }

  const firstKey = Object.keys(parsed)[0];
  if (firstKey) {
    const firstValue = parsed[firstKey];
    if (firstValue != null && typeof firstValue === "object") {
      return firstValue as PostBody;
    }
  }

  return undefined;
}

export const convertPost: ContentConverterFn = (raw, ctx) => {
  const rawParsed = safeParse(raw);
  if (rawParsed == null || typeof rawParsed !== "object") {
    return { content: "[rich text message]", resources: [] };
  }

  const parsed = unwrapLocale(rawParsed as Record<string, unknown>);
  if (!parsed) {
    return { content: "[rich text message]", resources: [] };
  }

  const resources: ResourceDescriptor[] = [];
  const lines: string[] = [];

  // 标题
  if (parsed.title) {
    lines.push(`**${parsed.title}**`, "");
  }

  const contentBlocks = parsed.content ?? [];

  for (const paragraph of contentBlocks) {
    if (!Array.isArray(paragraph)) continue;

    let line = "";
    for (const el of paragraph) {
      line += renderElement(el, ctx, resources);
    }
    lines.push(line);
  }

  let content = lines.join("\n").trim() || "[rich text message]";
  content = resolveMentions(content, ctx);

  return { content, resources };
};

function renderElement(
  el: PostElement,
  ctx: ConvertContext,
  resources: ResourceDescriptor[],
): string {
  switch (el.tag) {
    case "text": {
      let text = el.text ?? "";
      text = applyStyle(text, el.style);
      return text;
    }
    case "a": {
      const text = el.text ?? el.href ?? "";
      return el.href ? `[${text}](${el.href})` : text;
    }
    case "at": {
      const userId = el.user_id ?? "";
      if (userId === "all") return "@all";
      const name = el.user_name ?? userId;
      // O(1) 查询
      const info = ctx.mentionsByOpenId.get(userId);
      if (info) {
        // 返回占位符，让 resolveMentions 处理
        return info.key;
      }
      return `@${name}`;
    }
    case "img": {
      if (el.image_key) {
        resources.push({ type: "image", fileKey: el.image_key });
        return `![image](${el.image_key})`;
      }
      return "";
    }
    case "media": {
      if (el.file_key) {
        resources.push({ type: "file", fileKey: el.file_key });
        return `<file key="${el.file_key}"/>`;
      }
      return "";
    }
    case "code_block": {
      const lang = el.language ?? "";
      const code = el.text ?? "";
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }
    case "hr":
      return "\n---\n";
    default:
      return el.text ?? "";
  }
}

function applyStyle(text: string, style?: string[]): string {
  if (!style || style.length === 0) return text;
  let result = text;
  if (style.includes("bold")) result = `**${result}**`;
  if (style.includes("italic")) result = `*${result}*`;
  if (style.includes("underline")) result = `<u>${result}</u>`;
  if (style.includes("lineThrough")) result = `~~${result}~~`;
  if (style.includes("codeInline")) result = `\`${result}\``;
  return result;
}
