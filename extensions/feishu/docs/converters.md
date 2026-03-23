# 飞书消息转换器系统

## 概述

飞书扩展现在支持新的消息转换器系统，用于将飞书各种消息类型转换为 AI 友好的文本格式。

## 配置

在 `openclaw.json` 中配置：

```json
{
  "channels": {
    "feishu": {
      "useNewConverters": true // 默认为 true
    }
  }
}
```

## 功能特性

### 支持的消息类型

- **text** - 纯文本消息
- **post** - 富文本消息（支持 mention、链接、图片等）
- **image** - 图片消息
- **file** - 文件消息
- **audio** - 音频消息
- **video** - 视频消息
- **sticker** - 表情包
- **share_chat** - 分享聊天
- **share_user** - 分享用户
- **location** - 位置消息
- **system** - 系统消息
- **merge_forward** - 合并转发（TODO）
- **interactive** - 交互式卡片（TODO）

### Mention 处理

新转换器系统会自动处理 mention：

1. **事件推送**：在 DM 中自动删除机器人 mention（`stripBotMentions=true`）
2. **历史消息**：保留所有 mention（`stripBotMentions=false`）
3. **格式化**：将 mention 转换为 `<at user_id="...">name</at>` 格式

### 资源描述符

新转换器会返回资源描述符列表，包含：

- `type` - 资源类型（image/file/audio/video/sticker）
- `fileKey` - 文件键（用于下载）
- `fileName` - 原始文件名（可选）
- `duration` - 时长（音频/视频，毫秒）
- `coverImageKey` - 视频封面（可选）

## 降级策略

如果新转换器失败，系统会自动降级到旧的解析逻辑：

```typescript
try {
  ctx = await parseFeishuMessageEventWithConverters({...});
} catch (error) {
  log(`feishu: new converter failed, using legacy parser: ${error}`);
  ctx = parseFeishuMessageEvent(event, botOpenId, botName);
}
```

## 日志输出

启用新转换器后，会输出以下日志：

```
feishu[account]: using new converter system
feishu[account]: new converter parsed content: ...
feishu[account]: new converter found N resources
```

如果转换失败：

```
feishu: new converter failed, falling back to legacy parser: <error>
```

## 开发指南

### 添加新转换器

1. 在 `src/converters/` 目录下创建新文件（如 `interactive.ts`）
2. 实现 `ContentConverterFn` 接口
3. 在 `src/converters/index.ts` 中注册转换器

示例：

```typescript
import type { ContentConverterFn } from "./types.js";

export const convertInteractive: ContentConverterFn = (raw, ctx) => {
  // 解析 raw JSON
  // 返回 { content, resources }
  return {
    content: "[Interactive Card]",
    resources: [],
  };
};
```

### 测试

运行测试：

```bash
pnpm test extensions/feishu/src/converters/
```

## 已知限制

1. **merge_forward** - 当前仅支持基本格式化，完整实现待完成
2. **interactive** - 交互式卡片转换器待实现
3. **异步资源解析** - 当前不支持异步获取子消息

## 迁移指南

### 从旧解析器迁移

旧代码：

```typescript
const rawContent = parseMessageContent(event.message.content, event.message.message_type);
const content = normalizeMentions(rawContent, event.message.mentions);
```

新代码：

```typescript
const ctx = await parseFeishuMessageEventWithConverters({
  event,
  botOpenId,
  botName,
  accountId,
  log,
});
// ctx.content 已经包含格式化后的内容
// ctx.resources 包含资源描述符列表
```

### 配置迁移

无需配置迁移，新转换器默认启用。如需禁用：

```json
{
  "channels": {
    "feishu": {
      "useNewConverters": false
    }
  }
}
```
