/**
 * 合并转发消息转换器
 *
 * 这是一个异步转换器 — 通过飞书 IM API 获取子消息并递归展开嵌套的合并转发消息。
 *
 * API 返回所有嵌套子消息的扁平 `items` 数组，其中 `upper_message_id` 指向父容器。
 * 我们从这个扁平列表构建树并递归格式化 — 无论嵌套深度如何，只需一次 API 调用。
 *
 * 本模块是纯"数据 → 格式"转换器：所有 API 能力（`fetchSubMessages`、
 * `batchResolveNames`、`resolveUserName`）通过 `ConvertContext` 中的回调注入。
 * 调用方负责创建适当的回调（UAT / TAT / 事件推送）。
 */

import { convertMessageContent, buildConvertContextFromItem } from "./content-converter.js";
import type { ApiMessageItem, ContentConverterFn } from "./types.js";

/**
 * 递归展开合并转发消息
 *
 * 输出格式与 Go 参考实现对齐：
 * ```
 * <forwarded_messages>
 * [RFC3339] sender_id:
 *     message content
 * </forwarded_messages>
 * ```
 */
export const convertMergeForward: ContentConverterFn = async (_raw, ctx) => {
  const { accountId, messageId, resolveUserName, batchResolveNames, fetchSubMessages } = ctx;

  if (!fetchSubMessages) {
    return { content: "<forwarded_messages/>", resources: [] };
  }

  const content = await expand(
    accountId,
    messageId,
    resolveUserName,
    batchResolveNames,
    fetchSubMessages,
  );
  return { content, resources: [] };
};

// ---------------------------------------------------------------------------
// 单次 API 调用展开与树构建
// ---------------------------------------------------------------------------

async function expand(
  accountId: string | undefined,
  messageId: string,
  resolveUserName?: (openId: string) => string | undefined,
  batchResolveNames?: (openIds: string[]) => Promise<void>,
  fetchSubMessages?: (messageId: string) => Promise<ApiMessageItem[]>,
): Promise<string> {
  // --- 阶段 1: 获取（通过回调进行单次 API 调用）---
  let items: ApiMessageItem[];
  try {
    items = await fetchSubMessages!(messageId);
  } catch (error) {
    console.error("[merge-forward] fetch sub-messages failed", {
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "<forwarded_messages/>";
  }

  if (items.length === 0) {
    return "<forwarded_messages/>";
  }

  // --- 阶段 2: 构建子节点映射 ---
  const childrenMap = buildChildrenMap(items, messageId);

  // --- 阶段 2.5: 批量解析发送者名称（通过回调）---
  const senderIds = collectSenderIds(items, messageId);
  if (senderIds.length > 0 && batchResolveNames) {
    try {
      await batchResolveNames(senderIds);
    } catch (err) {
      console.error("[merge-forward] batchResolveNames failed (best-effort)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- 阶段 3: 递归格式化树 ---
  return formatSubTree(messageId, childrenMap, accountId, resolveUserName);
}

// ---------------------------------------------------------------------------
// 树构建
// ---------------------------------------------------------------------------

/**
 * 构建从父消息 ID → 有序子项的映射
 *
 * API 返回扁平的 `items` 数组，其中每个项可能携带指向其父容器的 `upper_message_id`。
 * 没有 `upper_message_id` 的项是根容器的直接子项。
 *
 * 根容器消息本身（匹配 `rootMessageId`）会被跳过。
 */
function buildChildrenMap(
  items: ApiMessageItem[],
  rootMessageId: string,
): Map<string, ApiMessageItem[]> {
  const map = new Map<string, ApiMessageItem[]>();

  for (const item of items) {
    // 跳过根容器消息本身
    if (item.message_id === rootMessageId && !item.upper_message_id) {
      continue;
    }

    const parentId: string = item.upper_message_id ?? rootMessageId;
    let children = map.get(parentId);
    if (!children) {
      children = [];
      map.set(parentId, children);
    }
    children.push(item);
  }

  // 按 create_time 升序排序每组
  for (const children of map.values()) {
    children.sort((a, b) => {
      const ta = parseInt(String(a.create_time ?? "0"), 10);
      const tb = parseInt(String(b.create_time ?? "0"), 10);
      return ta - tb;
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// 发送者 ID 收集
// ---------------------------------------------------------------------------

/**
 * 从非根项收集所有唯一的发送者 ID，用于批量名称解析
 */
function collectSenderIds(items: ApiMessageItem[], rootMessageId: string): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    // 跳过根容器
    if (item.message_id === rootMessageId && !item.upper_message_id) {
      continue;
    }
    if (item.sender?.sender_type === "user") {
      const senderId: string | undefined = item.sender.id;
      if (senderId) {
        ids.add(senderId);
      }
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// 递归树格式化
// ---------------------------------------------------------------------------

/**
 * 递归格式化以 `parentId` 为根的消息子树
 *
 * 对于 `merge_forward` 子项，直接递归到 `formatSubTree`（无需额外 API 调用）。
 * 对于其他消息类型，委托给 `convertMessageContent`。
 */
async function formatSubTree(
  parentId: string,
  childrenMap: Map<string, ApiMessageItem[]>,
  accountId: string | undefined,
  resolveUserName?: (openId: string) => string | undefined,
): Promise<string> {
  const children = childrenMap.get(parentId);
  if (!children || children.length === 0) {
    return "<forwarded_messages/>";
  }

  const parts: string[] = [];

  for (const item of children) {
    try {
      const msgType: string = item.msg_type ?? "text";
      const senderId: string = item.sender?.id ?? "unknown";
      const createTime: number | undefined = item.create_time
        ? parseInt(String(item.create_time), 10)
        : undefined;
      const timestamp = createTime ? formatTimestamp(createTime) : "unknown";
      const rawContent: string = item.body?.content ?? "{}";

      let content: string;

      if (msgType === "merge_forward") {
        // 通过树递归到嵌套的 merge_forward — 无需 API 调用
        const nestedId: string | undefined = item.message_id;
        if (nestedId) {
          content = await formatSubTree(nestedId, childrenMap, accountId, resolveUserName);
        } else {
          content = "<forwarded_messages/>";
        }
      } else {
        // 委托给统一转换器系统
        // 不要在这里传递 cfg/account — 非 merge_forward 类型的子转换器不需要它，
        // 传递它会导致嵌套的 merge_forward 通过 convertMessageContent 重新进入 expand()
        const subCtx = {
          ...buildConvertContextFromItem(item, parentId, accountId),
          accountId,
          resolveUserName,
        };
        content = (await convertMessageContent(rawContent, msgType, subCtx)).content;
      }

      const displayName = resolveUserName?.(senderId) ?? senderId;
      const indented = indentLines(content, "    ");
      parts.push(`[${timestamp}] ${displayName}:\n${indented}`);
    } catch (err) {
      console.error("[merge-forward] failed to convert sub-message", {
        messageId: item.message_id,
        msgType: item.msg_type ?? "unknown",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (parts.length === 0) {
    return "<forwarded_messages/>";
  }

  return `<forwarded_messages>\n${parts.join("\n")}\n</forwarded_messages>`;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 将毫秒时间戳转换为 RFC 3339 格式，带 +08:00 偏移（北京时间）
 */
function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60_000;
  const bjDate = new Date(utcMs + 8 * 3600_000);

  const y = bjDate.getFullYear();
  const mo = String(bjDate.getMonth() + 1).padStart(2, "0");
  const d = String(bjDate.getDate()).padStart(2, "0");
  const h = String(bjDate.getHours()).padStart(2, "0");
  const mi = String(bjDate.getMinutes()).padStart(2, "0");
  const s = String(bjDate.getSeconds()).padStart(2, "0");

  return `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`;
}

/** 为文本的每一行添加前缀缩进 */
function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}
