# 飞书扩展用户指南

本指南介绍飞书扩展的新功能和配置选项。

## 目录

- [消息转换器系统](#消息转换器系统)
- [流式卡片系统](#流式卡片系统)
- [配置选项](#配置选项)
- [常见问题](#常见问题)

## 消息转换器系统

### 概述

消息转换器系统负责将飞书的各种消息类型转换为 AI 友好的格式。支持 20+ 种消息类型，包括：

- **基础媒体**：文本、图片、音频、视频、文件、表情
- **分享与位置**：分享聊天、分享用户、位置
- **富文本**：Post 消息（支持 Markdown 转换）
- **交互卡片**：Interactive 卡片（支持 70+ 元素类型）
- **合并转发**：Merge Forward 消息（支持递归解析）
- **其他**：投票、待办、日历、视频会议、文件夹、红包

### 配置

在 `openclaw.json` 中配置：

```json
{
  "channels": {
    "feishu": {
      "messageConverter": {
        "useNewConverters": true, // 使用新转换器系统（默认 true）
        "enableInteractiveCard": true, // 解析 interactive 卡片（默认 true）
        "enableMergeForward": true, // 解析 merge_forward 消息（默认 true）
        "enableRichText": true // 解析 post 富文本消息（默认 true）
      }
    }
  }
}
```

### 支持的消息类型

#### 1. 文本消息（text）

- 自动解析 mention（@用户）
- 支持 bot mention 过滤（私聊场景）

#### 2. 富文本消息（post）

- 转换为 Markdown 格式
- 支持：粗体、斜体、下划线、删除线、代码
- 支持：链接、图片、mention
- 多语言支持（zh_cn, en_us, ja_jp）

#### 3. 交互卡片（interactive）

- 支持 70+ 飞书卡片元素类型
- 自动提取文本内容
- 支持新旧两种卡片格式

#### 4. 合并转发（merge_forward）

- 递归解析嵌套消息
- 树形展开层级结构
- 批量用户名解析

#### 5. 媒体消息

- 图片、音频、视频、文件
- 自动下载并生成资源描述符
- 支持 Markdown 格式输出

## 流式卡片系统

### 概述

流式卡片系统提供实时的 AI 回复体验，支持：

- 增量文本显示
- "思考中..." 占位符
- 推理过程展示
- 工具调用状态
- 图片异步上传

### 配置

```json
{
  "channels": {
    "feishu": {
      "streaming": true, // 启用流式模式（简化配置）
      "streamingCard": {
        "enabled": true, // 启用流式卡片（默认 true）
        "throttleMs": 100, // 节流间隔（CardKit: 100ms, IM: 1500ms）
        "enableReasoningDisplay": true, // 显示推理过程（默认 true）
        "enableImageResolver": true, // 启用异步图片上传（默认 true）
        "enableUnavailableGuard": true // 检查消息可用性（默认 true）
      }
    }
  }
}
```

### 功能特性

#### 1. 节流控制（FlushController）

- CardKit 模式：100ms 节流
- IM Patch 模式：1500ms 节流
- 自动批处理更新

#### 2. 推理过程展示

- 自动识别 `<thinking>` 标签
- 可折叠的推理面板
- 耗时计算

#### 3. 图片异步上传（ImageResolver）

- 三层缓存机制（resolved/pending/failed）
- 自动替换 Markdown 图片 URL
- 超时控制

#### 4. 消息不可用检测（UnavailableGuard）

- 自动检测消息是否可用
- 避免无效更新

#### 5. 连接中断检测

- 自动监控后台任务连接状态
- 连续 3 次轮询失败后，卡片自动显示"后台连接中断"
- 无需持久化，实时感知服务重启或网络断开

## 配置选项

### 完整配置示例

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": "xxx",

      // 消息转换器配置
      "messageConverter": {
        "useNewConverters": true,
        "enableInteractiveCard": true,
        "enableMergeForward": true,
        "enableRichText": true
      },

      // 流式卡片配置
      "streaming": true,
      "streamingCard": {
        "enabled": true,
        "throttleMs": 100,
        "enableReasoningDisplay": true,
        "enableImageResolver": true,
        "enableUnavailableGuard": true
      },

      // 进度卡片配置
      "progressCard": {
        "mode": "tools_summary" // off | tools | tools_summary
      }
    }
  }
}
```

### 配置项说明

| 配置项                                   | 类型    | 默认值 | 说明                    |
| ---------------------------------------- | ------- | ------ | ----------------------- |
| `messageConverter.useNewConverters`      | boolean | true   | 使用新转换器系统        |
| `messageConverter.enableInteractiveCard` | boolean | true   | 解析 interactive 卡片   |
| `messageConverter.enableMergeForward`    | boolean | true   | 解析 merge_forward 消息 |
| `messageConverter.enableRichText`        | boolean | true   | 解析 post 富文本消息    |
| `streamingCard.enabled`                  | boolean | true   | 启用流式卡片            |
| `streamingCard.throttleMs`               | number  | 100    | 节流间隔（毫秒）        |
| `streamingCard.enableReasoningDisplay`   | boolean | true   | 显示推理过程            |
| `streamingCard.enableImageResolver`      | boolean | true   | 启用异步图片上传        |
| `streamingCard.enableUnavailableGuard`   | boolean | true   | 检查消息可用性          |

## 常见问题

### Q: 如何禁用新转换器系统？

A: 在配置中设置 `messageConverter.useNewConverters: false`，系统会自动降级到旧的解析器。

### Q: 流式卡片更新太频繁怎么办？

A: 增加 `streamingCard.throttleMs` 的值，例如设置为 `500` 或 `1000`。

### Q: 如何隐藏推理过程？

A: 设置 `streamingCard.enableReasoningDisplay: false`。

### Q: 转换器支持哪些消息类型？

A: 支持 20+ 种类型，详见[支持的消息类型](#支持的消息类型)章节。

### Q: 如何调试转换器问题？

A: 查看日志输出，转换器会记录详细的转换过程和错误信息。

### Q: 进度卡片显示"后台连接中断"是什么原因？

A: 这表示后台任务监控连接失败超过 3 次，或者服务重启时检测到未完成的卡片。可能原因：

- 服务重启或崩溃
- 网络连接中断
- 后台任务超时

解决方法：

1. **实时检测**：运行中的卡片会在连续 3 次轮询失败后自动标记为"后台连接中断"
2. **启动恢复**：服务重启时会自动检测并更新所有未完成的卡片状态
3. **持久化机制**：卡片状态会持久化到 `~/.openclaw/feishu-progress-cards.json`，确保重启后能恢复

重新发送消息即可恢复正常。

### Q: 如何查看持久化的卡片状态？

A: 卡片状态保存在 `~/.openclaw/feishu-progress-cards.json`，包含：

- `messageId`：卡片消息 ID
- `chatId`：聊天 ID
- `accountId`：账号 ID
- `stage`：卡片状态（pending/thinking/tool/answering/background/waiting_final/done/aborted/error）
- `startedAt`：启动时间戳

正常情况下，完成的卡片会自动从文件中移除。如果文件中有大量未完成的卡片，说明服务可能异常退出。

## 更新日志

### v2026.3.16

- ✅ 新增进度卡片持久化机制
- ✅ 新增启动时自动恢复未完成卡片
- ✅ 优化连接中断检测（实时检测 + 启动恢复）

### v2026.3.3

- ✅ 新增消息转换器系统（20+ 种类型）
- ✅ 新增流式卡片子控制器
- ✅ 新增进度卡片连接中断检测（连续 3 次失败自动标记）
- ✅ 新增配置选项（messageConverter, streamingCard）
- ✅ 完整的单元测试覆盖

## 相关文档

- [转换器使用指南](./converters.md)
- [转换器集成总结](./converter-integration-summary.md)

## 技术支持

如有问题，请查看：

- 项目 README
- 源代码注释
- 单元测试示例
