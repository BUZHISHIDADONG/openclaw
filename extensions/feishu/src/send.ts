import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedMessage, buildMentionedCardContent } from "./mention.js";
import { parsePostContent } from "./post.js";
import { getFeishuRuntime } from "./runtime.js";
import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import type { FeishuSendResult } from "./types.js";

const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003]);

function shouldFallbackFromReplyTarget(response: { code?: number; msg?: string }): boolean {
  if (response.code !== undefined && WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) {
    return true;
  }
  const msg = response.msg?.toLowerCase() ?? "";
  return msg.includes("withdrawn") || msg.includes("not found");
}

/** Check whether a thrown error indicates a withdrawn/not-found reply target. */
function isWithdrawnReplyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  // SDK error shape: err.code
  const code = (err as { code?: number }).code;
  if (typeof code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(code)) {
    return true;
  }
  // AxiosError shape: err.response.data.code
  const response = (err as { response?: { data?: { code?: number; msg?: string } } }).response;
  if (
    typeof response?.data?.code === "number" &&
    WITHDRAWN_REPLY_ERROR_CODES.has(response.data.code)
  ) {
    return true;
  }
  return false;
}

type FeishuCreateMessageClient = {
  im: {
    message: {
      create: (opts: {
        params: { receive_id_type: "chat_id" | "email" | "open_id" | "union_id" | "user_id" };
        data: { receive_id: string; content: string; msg_type: string };
      }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
    };
  };
};

/** Send a direct message as a fallback when a reply target is unavailable. */
async function sendFallbackDirect(
  client: FeishuCreateMessageClient,
  params: {
    receiveId: string;
    receiveIdType: "chat_id" | "email" | "open_id" | "union_id" | "user_id";
    content: string;
    msgType: string;
  },
  errorPrefix: string,
): Promise<FeishuSendResult> {
  const response = await client.im.message.create({
    params: { receive_id_type: params.receiveIdType },
    data: {
      receive_id: params.receiveId,
      content: params.content,
      msg_type: params.msgType,
    },
  });
  assertFeishuMessageApiSuccess(response, errorPrefix);
  return toFeishuSendResult(response, params.receiveId);
}

export type FeishuMessageInfo = {
  messageId: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  senderType?: string;
  content: string;
  contentType: string;
  createTime?: number;
};

function parseInteractiveCardContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "[Interactive Card]";
  }

  const card = parsed as Record<string, unknown>;

  // Handle raw_card_content format (json_card field)
  if (typeof card.json_card === "string") {
    try {
      const jsonCard = JSON.parse(card.json_card) as Record<string, unknown>;
      return parseCardBody(jsonCard);
    } catch {
      // Fall back to parsing the current shape if json_card isn't valid JSON.
    }
  }

  // Fallback to legacy format
  return parseCardBody(card);
}

function parseCardBody(card: Record<string, unknown>): string {
  // Extract body (schema 2.0)
  let body = card.body;
  if (!body || typeof body !== "object") {
    // Fallback to top-level elements (schema 1.0)
    if (Array.isArray(card.elements)) {
      return extractElementsText(card.elements);
    }
    return "[Interactive Card]";
  }

  const bodyObj = body as Record<string, unknown>;

  // Try body.property.elements first (official structure)
  const prop = bodyObj.property;
  if (prop && typeof prop === "object") {
    const propObj = prop as Record<string, unknown>;
    if (Array.isArray(propObj.elements)) {
      return extractElementsText(propObj.elements);
    }
  }

  // Fallback to body.elements
  if (Array.isArray(bodyObj.elements)) {
    return extractElementsText(bodyObj.elements);
  }

  return "[Interactive Card]";
}

function extractElementsText(elements: unknown[]): string {
  const texts: string[] = [];

  for (const element of elements) {
    // Handle nested arrays (e.g., [[{...}]])
    const items = Array.isArray(element) ? element : [element];

    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const elem = item as Record<string, unknown>;
      const text = extractElementText(elem);

      if (text) {
        texts.push(text);
      }
    }
  }

  return texts.join("\n").trim() || "[Interactive Card]";
}

// Extract markdown inline elements (no newlines between elements)
function extractMarkdownElements(elements: unknown[]): string {
  const parts: string[] = [];

  for (const element of elements) {
    if (!element || typeof element !== "object") {
      continue;
    }

    const text = extractElementText(element as Record<string, unknown>);
    if (text) {
      parts.push(text);
    }
  }

  return parts.join("");
}

function extractElementText(elem: Record<string, unknown>): string {
  const tag = elem.tag as string | undefined;

  // Extract property object (schema 2.0 structure)
  const prop = (
    elem.property && typeof elem.property === "object" ? elem.property : elem
  ) as Record<string, unknown>;

  // Handle different element types
  switch (tag) {
    case "div": {
      const textElem = prop.text;
      if (textElem && typeof textElem === "object") {
        return extractTextContent(textElem as Record<string, unknown>);
      }
      break;
    }
    case "markdown":
    case "markdown_v1": {
      if (typeof prop.content === "string") {
        return prop.content;
      }
      if (Array.isArray(prop.elements)) {
        return extractElementsText(prop.elements);
      }
      break;
    }
    case "plain_text":
    case "text": {
      if (typeof prop.content === "string") {
        // Apply text style if present
        const style = extractTextStyle(prop);
        return applyTextStyle(prop.content, style);
      }
      // Handle direct text field (e.g., {"tag": "text", "text": "..."})
      if (typeof prop.text === "string") {
        const style = extractTextStyle(prop);
        return applyTextStyle(prop.text, style);
      }
      break;
    }
    case "heading": {
      // Extract heading content (inline elements, no newlines)
      if (Array.isArray(prop.elements)) {
        const headingText = extractMarkdownElements(prop.elements);
        const level = (prop.level as number) || 1;
        const prefix = "#".repeat(Math.min(Math.max(level, 1), 6));
        return headingText ? `${prefix} ${headingText}` : "";
      }
      break;
    }
    case "list": {
      // Extract list items
      if (Array.isArray(prop.items)) {
        const listTexts: string[] = [];
        for (const item of prop.items) {
          if (!item || typeof item !== "object") continue;
          const itemObj = item as Record<string, unknown>;
          const itemElements = itemObj.elements;
          if (Array.isArray(itemElements)) {
            // Use extractMarkdownElements for inline content
            const itemText = extractMarkdownElements(itemElements);
            if (itemText) {
              const listType = itemObj.type as string;
              const level = (itemObj.level as number) || 0;
              const order = (itemObj.order as number) || 0;
              const indent = "  ".repeat(level);
              const prefix = listType === "ol" ? `${Math.floor(order)}.` : "-";
              listTexts.push(`${indent}${prefix} ${itemText}`);
            }
          }
        }
        return listTexts.join("\n");
      }
      break;
    }
    case "code_span": {
      // Inline code
      if (typeof prop.content === "string") {
        return `\`${prop.content}\``;
      }
      break;
    }
    case "br": {
      // Line break - return empty to avoid extra spacing
      return "";
    }
    case "hr": {
      // Horizontal rule
      return "---";
    }
    case "blockquote": {
      // Blockquote
      let content = "";
      if (typeof prop.content === "string") {
        content = prop.content;
      } else if (Array.isArray(prop.elements)) {
        content = extractMarkdownElements(prop.elements);
      }
      if (!content) return "";
      return content
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }
    case "code_block": {
      // Code block
      const language = (prop.language as string) || "plaintext";
      let code = "";
      const contents = prop.contents as unknown[] | undefined;
      if (Array.isArray(contents)) {
        for (const line of contents) {
          if (!line || typeof line !== "object") continue;
          const lineObj = line as Record<string, unknown>;
          const lineContents = lineObj.contents as unknown[] | undefined;
          if (Array.isArray(lineContents)) {
            for (const c of lineContents) {
              if (!c || typeof c !== "object") continue;
              const cObj = c as Record<string, unknown>;
              if (typeof cObj.content === "string") code += cObj.content;
            }
          }
        }
      }
      return `\`\`\`${language}\n${code}\`\`\``;
    }
    case "link": {
      // Hyperlink
      const content = (prop.content as string) || "链接";
      let url = "";
      const urlObj = prop.url as Record<string, unknown> | undefined;
      if (urlObj && typeof urlObj === "object") {
        url = (urlObj.url as string) || "";
      }
      if (url) return `[${content}](${url})`;
      return content;
    }
    case "emoji": {
      // Emoji - just return the key for now
      const key = (prop.key as string) || "";
      return key ? `:${key}:` : "";
    }
    case "at": {
      // @ mention
      const userID = (prop.userID as string) || "";
      return userID ? `@${userID}` : "";
    }
    case "at_all": {
      return "@所有人";
    }
    case "img":
    case "image": {
      // Image
      let alt = "图片";
      const altElem = prop.alt;
      if (altElem && typeof altElem === "object") {
        const altText = extractTextContent(altElem as Record<string, unknown>);
        if (altText) alt = altText;
      }
      const titleElem = prop.title;
      if (titleElem && typeof titleElem === "object") {
        const titleText = extractTextContent(titleElem as Record<string, unknown>);
        if (titleText) alt = titleText;
      }
      return `🖼️ ${alt}`;
    }
    case "column_set": {
      // Column set - extract all columns
      const columns = prop.columns as unknown[] | undefined;
      if (Array.isArray(columns)) {
        const columnTexts: string[] = [];
        for (const col of columns) {
          if (!col || typeof col !== "object") continue;
          const colText = extractElementText(col as Record<string, unknown>);
          if (colText) columnTexts.push(colText);
        }
        return columnTexts.join("\n\n");
      }
      break;
    }
    case "column": {
      // Column - extract elements
      if (Array.isArray(prop.elements)) {
        return extractElementsText(prop.elements);
      }
      break;
    }
    case "collapsible_panel": {
      // Collapsible panel
      const expanded = prop.expanded === true;
      let title = "详情";
      const header = prop.header as Record<string, unknown> | undefined;
      if (header && typeof header === "object") {
        const titleElem = header.title;
        if (titleElem) {
          const t = extractTextContent(titleElem as Record<string, unknown>);
          if (t) title = t;
        }
      }

      if (expanded) {
        let out = `▼ ${title}\n`;
        if (Array.isArray(prop.elements)) {
          const content = extractElementsText(prop.elements);
          for (const line of content.split("\n")) {
            if (line) out += `    ${line}\n`;
          }
        }
        out += "▲";
        return out;
      }

      return `▶ ${title}`;
    }
    case "note": {
      if (Array.isArray(prop.elements)) {
        const noteTexts = extractMarkdownElements(prop.elements);
        return noteTexts ? `📝 ${noteTexts}` : "";
      }
      break;
    }
    case "button": {
      // Button - extract text
      const textElem = prop.text;
      if (textElem && typeof textElem === "object") {
        const buttonText = extractTextContent(textElem);
        return buttonText ? `[${buttonText}]` : "[按钮]";
      }
      return "[按钮]";
    }
    case "actions":
    case "action": {
      // Actions container - extract all action elements
      const actions = prop.actions as unknown[] | undefined;
      if (Array.isArray(actions)) {
        const actionTexts: string[] = [];
        for (const action of actions) {
          if (!action || typeof action !== "object") continue;
          const actionText = extractElementText(action as Record<string, unknown>);
          if (actionText) actionTexts.push(actionText);
        }
        return actionTexts.join(" ");
      }
      break;
    }
    case "form": {
      // Form - extract elements
      if (Array.isArray(prop.elements)) {
        return "<form>\n" + extractElementsText(prop.elements) + "\n</form>";
      }
      return "<form>";
    }
    case "interactive_container": {
      // Interactive container - extract elements
      if (Array.isArray(prop.elements)) {
        return extractElementsText(prop.elements);
      }
      break;
    }
    case "repeat": {
      // Repeat - extract elements
      if (Array.isArray(prop.elements)) {
        return extractElementsText(prop.elements);
      }
      break;
    }
    case "table": {
      // Table - simplified representation
      const columns = prop.columns as unknown[] | undefined;
      if (Array.isArray(columns) && columns.length > 0) {
        return `📊 表格 (${columns.length}列)`;
      }
      return "📊 表格";
    }
    case "chart": {
      // Chart
      return "📈 图表";
    }
    case "audio": {
      return "🎵 音频";
    }
    case "video": {
      return "🎬 视频";
    }
    case "person":
    case "person_v1":
    case "avatar": {
      // Person mention
      const userID = (prop.userID as string) || "";
      return userID ? `@${userID}` : "@用户";
    }
    case "person_list": {
      // Person list
      const persons = prop.persons as unknown[] | undefined;
      if (Array.isArray(persons) && persons.length > 0) {
        return `@${persons.length}人`;
      }
      return "@用户列表";
    }
    case "text_tag": {
      // Text tag
      const textElem = prop.text;
      if (textElem && typeof textElem === "object") {
        const text = extractTextContent(textElem);
        return text ? `「${text}」` : "";
      }
      break;
    }
    case "number_tag": {
      // Number tag
      const textElem = prop.text;
      if (textElem && typeof textElem === "object") {
        return extractTextContent(textElem);
      }
      break;
    }
    case "local_datetime": {
      // Local datetime
      const fallbackText = prop.fallbackText as string | undefined;
      return fallbackText || "📅";
    }
    case "fallback_text": {
      // Fallback text
      const textElem = prop.text;
      if (textElem && typeof textElem === "object") {
        return extractTextContent(textElem);
      }
      if (Array.isArray(prop.elements)) {
        return extractMarkdownElements(prop.elements);
      }
      break;
    }
    case "input":
    case "select_static":
    case "multi_select_static":
    case "select_person":
    case "multi_select_person":
    case "select_img":
    case "date_picker":
    case "picker_time":
    case "picker_datetime":
    case "checker":
    case "overflow": {
      // Form inputs - extract label/placeholder
      const label = prop.label;
      if (label && typeof label === "object") {
        const labelText = extractTextContent(label);
        if (labelText) return `[${labelText}]`;
      }
      const placeholder = prop.placeholder;
      if (placeholder && typeof placeholder === "object") {
        const placeholderText = extractTextContent(placeholder);
        if (placeholderText) return `[${placeholderText}]`;
      }
      return "[输入框]";
    }
    case "card_header":
    case "custom_icon":
    case "standard_icon": {
      // Ignore these elements
      return "";
    }
  }

  // Fallback: try to extract any text content
  if (typeof prop.content === "string") {
    return prop.content;
  }
  if (typeof prop.text === "string") {
    return prop.text;
  }

  return "";
}

function extractTextContent(textElem: unknown): string {
  if (textElem == null) return "";
  if (typeof textElem === "string") return textElem;

  if (typeof textElem !== "object") return "";

  const elem = textElem as Record<string, unknown>;

  // Handle property wrapper
  const prop = (
    elem.property && typeof elem.property === "object" ? elem.property : elem
  ) as Record<string, unknown>;

  // Try i18n content first
  const i18n = prop.i18nContent as Record<string, unknown> | undefined;
  if (i18n && typeof i18n === "object") {
    for (const lang of ["zh_cn", "en_us", "ja_jp"]) {
      const t = i18n[lang];
      if (typeof t === "string" && t) return t;
    }
  }

  // Try content field
  if (typeof prop.content === "string") {
    return prop.content;
  }

  // Try elements array (inline, no newlines)
  if (Array.isArray(prop.elements)) {
    const texts: string[] = [];
    for (const el of prop.elements) {
      if (el && typeof el === "object") {
        const t = extractTextContent(el);
        if (t) texts.push(t);
      }
    }
    return texts.join("");
  }

  // Try text field
  if (typeof prop.text === "string") {
    return prop.text;
  }

  return "";
}

interface TextStyle {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
}

function extractTextStyle(prop: Record<string, unknown>): TextStyle {
  const style: TextStyle = {
    bold: false,
    italic: false,
    strikethrough: false,
  };

  const textStyle = prop.textStyle as Record<string, unknown> | undefined;
  if (!textStyle || typeof textStyle !== "object") return style;

  const attrs = textStyle.attributes as unknown[] | undefined;
  if (Array.isArray(attrs)) {
    for (const attr of attrs) {
      if (typeof attr !== "string") continue;
      switch (attr) {
        case "bold":
          style.bold = true;
          break;
        case "italic":
          style.italic = true;
          break;
        case "strikethrough":
          style.strikethrough = true;
          break;
      }
    }
  }

  return style;
}

function applyTextStyle(content: string, style: TextStyle): string {
  if (!content) return content;
  if (style.strikethrough) content = `~~${content}~~`;
  if (style.italic) content = `*${content}*`;
  if (style.bold) content = `**${content}**`;
  return content;
}

function parseQuotedMessageContent(rawContent: string, msgType: string): string {
  if (!rawContent) {
    return "";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }

  if (msgType === "text") {
    const text = (parsed as { text?: unknown })?.text;
    return typeof text === "string" ? text : "[Text message]";
  }

  if (msgType === "post") {
    return parsePostContent(rawContent).textContent;
  }

  if (msgType === "interactive") {
    return parseInteractiveCardContent(parsed);
  }

  if (typeof parsed === "string") {
    return parsed;
  }

  const genericText = (parsed as { text?: unknown; title?: unknown } | null)?.text;
  if (typeof genericText === "string" && genericText.trim()) {
    return genericText;
  }
  const genericTitle = (parsed as { title?: unknown } | null)?.title;
  if (typeof genericTitle === "string" && genericTitle.trim()) {
    return genericTitle;
  }

  return `[${msgType || "unknown"} message]`;
}

/**
 * Get a message by its ID.
 * Useful for fetching quoted/replied message content.
 */
export async function getMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageInfo | null> {
  const { cfg, messageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  try {
    const params = {
      user_id_type: "open_id" as const,
      // Request raw card content so interactive messages include `json_card`.
      card_msg_content_type: "raw_card_content" as const,
    };
    const response = (await client.im.message.get({
      path: { message_id: messageId },
      params,
    })) as {
      code?: number;
      msg?: string;
      data?: {
        items?: Array<{
          message_id?: string;
          chat_id?: string;
          msg_type?: string;
          body?: { content?: string };
          sender?: {
            id?: string;
            id_type?: string;
            sender_type?: string;
          };
          create_time?: string;
        }>;
        message_id?: string;
        chat_id?: string;
        msg_type?: string;
        body?: { content?: string };
        sender?: {
          id?: string;
          id_type?: string;
          sender_type?: string;
        };
        create_time?: string;
      };
    };

    if (response.code !== 0) {
      return null;
    }

    // Support both list shape (data.items[0]) and single-object shape (data as message)
    const rawItem = response.data?.items?.[0] ?? response.data;
    const item =
      rawItem &&
      (rawItem.body !== undefined || (rawItem as { message_id?: string }).message_id !== undefined)
        ? rawItem
        : null;
    if (!item) {
      return null;
    }

    const msgType = item.msg_type ?? "text";
    const rawContent = item.body?.content ?? "";
    const content = parseQuotedMessageContent(rawContent, msgType);

    return {
      messageId: item.message_id ?? messageId,
      chatId: item.chat_id ?? "",
      senderId: item.sender?.id,
      senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : undefined,
      senderType: item.sender?.sender_type,
      content,
      contentType: msgType,
      createTime: item.create_time ? parseInt(String(item.create_time), 10) : undefined,
    };
  } catch {
    return null;
  }
}

export type SendFeishuMessageParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  /** Mention target users */
  mentions?: MentionTarget[];
  /** Account ID (optional, uses default if not specified) */
  accountId?: string;
};

function buildFeishuPostMessagePayload(params: { messageText: string }): {
  content: string;
  msgType: string;
} {
  const { messageText } = params;
  return {
    content: JSON.stringify({
      zh_cn: {
        content: [
          [
            {
              tag: "md",
              text: messageText,
            },
          ],
        ],
      },
    }),
    msgType: "post",
  };
}

export async function sendMessageFeishu(
  params: SendFeishuMessageParams,
): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, replyInThread, mentions, accountId } = params;
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  // Build message content (with @mention support)
  let rawText = text ?? "";
  if (mentions && mentions.length > 0) {
    rawText = buildMentionedMessage(mentions, rawText);
  }
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(rawText, tableMode);

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText });

  const directParams = { receiveId, receiveIdType, content, msgType };

  if (replyToMessageId) {
    let response: { code?: number; msg?: string; data?: { message_id?: string } };
    try {
      response = await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content,
          msg_type: msgType,
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } catch (err) {
      if (!isWithdrawnReplyError(err)) {
        throw err;
      }
      return sendFallbackDirect(client, directParams, "Feishu send failed");
    }
    if (shouldFallbackFromReplyTarget(response)) {
      return sendFallbackDirect(client, directParams, "Feishu send failed");
    }
    assertFeishuMessageApiSuccess(response, "Feishu reply failed");
    return toFeishuSendResult(response, receiveId);
  }

  return sendFallbackDirect(client, directParams, "Feishu send failed");
}

export type SendFeishuCardParams = {
  cfg: ClawdbotConfig;
  to: string;
  card: Record<string, unknown>;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  accountId?: string;
};

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, replyInThread, accountId } = params;
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  const content = JSON.stringify(card);

  const directParams = { receiveId, receiveIdType, content, msgType: "interactive" };

  if (replyToMessageId) {
    let response: { code?: number; msg?: string; data?: { message_id?: string } };
    try {
      response = await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content,
          msg_type: "interactive",
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } catch (err) {
      if (!isWithdrawnReplyError(err)) {
        throw err;
      }
      return sendFallbackDirect(client, directParams, "Feishu card send failed");
    }
    if (shouldFallbackFromReplyTarget(response)) {
      return sendFallbackDirect(client, directParams, "Feishu card send failed");
    }
    assertFeishuMessageApiSuccess(response, "Feishu card reply failed");
    return toFeishuSendResult(response, receiveId);
  }

  return sendFallbackDirect(client, directParams, "Feishu card send failed");
}

export async function updateCardFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  card: Record<string, unknown>;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, card, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const content = JSON.stringify(card);

  const response = await client.im.message.patch({
    path: { message_id: messageId },
    data: { content },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu card update failed: ${response.msg || `code ${response.code}`}`);
  }
}

/**
 * Build a Feishu interactive card with markdown content.
 * Cards render markdown properly (code blocks, tables, links, etc.)
 * Uses schema 2.0 format for proper markdown rendering.
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    },
  };
}

/**
 * Send a message as a markdown card (interactive message).
 * This renders markdown properly in Feishu (code blocks, tables, bold/italic, etc.)
 */
export async function sendMarkdownCardFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** When true, reply creates a Feishu topic thread instead of an inline reply */
  replyInThread?: boolean;
  /** Mention target users */
  mentions?: MentionTarget[];
  accountId?: string;
}): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, replyInThread, mentions, accountId } = params;
  let cardText = text;
  if (mentions && mentions.length > 0) {
    cardText = buildMentionedCardContent(mentions, text);
  }
  const card = buildMarkdownCard(cardText);
  return sendCardFeishu({ cfg, to, card, replyToMessageId, replyInThread, accountId });
}

/**
 * Edit an existing text message.
 * Note: Feishu only allows editing messages within 24 hours.
 */
export async function editMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  text: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, text, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(text ?? "", tableMode);

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText });

  const response = await client.im.message.update({
    path: { message_id: messageId },
    data: {
      msg_type: msgType,
      content,
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
  }
}
