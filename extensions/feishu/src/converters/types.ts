/**
 * 消息内容转换器类型定义
 *
 * 基于官方实现，用于将飞书各种消息类型转换为统一的文本格式
 */

/**
 * 飞书 IM API 返回的消息项结构
 */
export interface ApiMessageItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  upper_message_id?: string; // 用于 merge_forward 树形结构
  body?: { content?: string };
  sender?: {
    id?: string;
    sender_type?: string;
  };
  mentions?: Array<{
    key: string;
    id: unknown; // 可能是字符串或对象 { open_id, user_id, union_id }
    name?: string;
  }>;
  parent_id?: string;
  thread_id?: string;
  deleted?: boolean;
  updated?: boolean;
}

/**
 * Mention 信息
 */
export interface MentionInfo {
  key: string; // 占位符键（如 "@_user_1"）
  openId: string; // 飞书 Open ID
  name: string; // 显示名称
  isBot: boolean; // 是否为机器人
}

/**
 * 资源描述符（图片、文件、音频、视频等）
 */
export interface ResourceDescriptor {
  type: "image" | "file" | "audio" | "video" | "sticker";
  fileKey: string; // image_key 或 file_key
  fileName?: string; // 原始文件名
  duration?: number; // 时长（毫秒）
  coverImageKey?: string; // 视频封面
}

/**
 * 转换器上下文
 */
export interface ConvertContext {
  /** 占位符键 → Mention 信息映射 */
  mentions: Map<string, MentionInfo>;
  /** Open ID → Mention 信息映射（用于 O(1) 查询） */
  mentionsByOpenId: Map<string, MentionInfo>;
  /** 消息 ID */
  messageId: string;
  /** 机器人 Open ID */
  botOpenId?: string;
  /** 账号 ID（多账号场景） */
  accountId?: string;
  /** 同步查询用户名（从缓存） */
  resolveUserName?: (openId: string) => string | undefined;
  /** 异步批量解析用户名 */
  batchResolveNames?: (openIds: string[]) => Promise<void>;
  /** 异步获取合并转发的子消息 */
  fetchSubMessages?: (messageId: string) => Promise<ApiMessageItem[]>;
  /** 是否删除机器人 mention（事件推送=true，历史消息=false） */
  stripBotMentions?: boolean;
}

/**
 * 转换结果
 */
export interface ConvertResult {
  /** AI 友好的格式化文本 */
  content: string;
  /** 资源描述符列表 */
  resources: ResourceDescriptor[];
}

/**
 * 转换器函数类型
 *
 * 可以返回同步结果或 Promise（用于需要异步操作的类型，如 merge_forward）
 */
export type ContentConverterFn = (
  raw: string,
  ctx: ConvertContext,
) => ConvertResult | Promise<ConvertResult>;

/**
 * Post 消息元素（富文本）
 *
 * 用于 post 和 todo 转换器
 */
export interface PostElement {
  tag: string;
  text?: string;
  href?: string;
  image_key?: string;
  file_key?: string;
  user_id?: string;
  user_name?: string;
  style?: string[];
  language?: string;
  un_escape?: boolean;
}
