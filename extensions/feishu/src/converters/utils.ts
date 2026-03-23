/**
 * 转换器辅助函数
 *
 * 基于官方实现的通用工具函数
 */

/**
 * 转义字符串用于正则表达式
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 安全地解析 JSON，失败时返回 undefined
 */
export function safeParse(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * 格式化时长（毫秒）为人类可读字符串
 *
 * 示例：1500 → "1.5s", 65000 → "65s"
 */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${ms}ms`;
  if (Number.isInteger(seconds)) return `${seconds}s`;
  return `${seconds.toFixed(1)}s`;
}

/**
 * 将毫秒时间戳转换为 "YYYY-MM-DD HH:mm" 格式（UTC+8 北京时间）
 */
export function millisToDatetime(ms: string | number): string {
  const num = Number(ms);
  if (!Number.isFinite(num)) return String(ms);

  // UTC+8 偏移量（毫秒）
  const utc8Offset = 8 * 60 * 60 * 1000;
  const d = new Date(num + utc8Offset);

  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const minute = String(d.getUTCMinutes()).padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute}`;
}
