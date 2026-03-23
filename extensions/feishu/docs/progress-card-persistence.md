# 进度卡片持久化与恢复机制

## 概述

为了解决服务重启后进度卡片状态丢失的问题，我们实现了一套完整的持久化和恢复机制。

## 问题背景

**原有问题：**

1. 服务重启后，内存中的 `activeProgressCardSessions` 集合被清空
2. 未完成的进度卡片无法被找到和更新
3. 用户看到的卡片一直显示"正在运行"，但实际上后台已经中断
4. 点击"停止"按钮无效，因为 `stopRequestedCardIds` 也是内存中的 Map

## 解决方案

### 1. 持久化机制

**持久化文件位置：**

```
~/.openclaw/feishu-progress-cards.json
```

**持久化内容：**

```typescript
type PersistedCardState = {
  messageId: string; // 卡片消息 ID
  chatId: string; // 聊天 ID
  accountId: string; // 账号 ID
  stage: ProgressStage; // 卡片状态
  startedAt: number; // 启动时间戳
};
```

**持久化时机：**

- 卡片创建时（`ensureStartedInternal()`）
- 卡片更新时（`flushNowInternal()`）
- 卡片完成时自动删除（terminal 状态）

### 2. 恢复机制

**恢复时机：**
在 `monitorSingleAccount()` 启动时，调用 `recoverInterruptedProgressCards()`

**恢复逻辑：**

1. 读取持久化文件
2. 过滤出未完成的卡片（非 terminal 状态）
3. 更新这些卡片为"后台连接中断"状态
4. 清理持久化文件中的这些条目

**恢复代码：**

```typescript
export async function recoverInterruptedProgressCards(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  logger?: (message: string) => void;
}): Promise<void> {
  const { cfg, accountId, logger } = params;
  const log = logger ?? console.log;

  const states = await loadPersistedCardStates();
  const interrupted = states.filter((s) => s.accountId === accountId && !isTerminalStage(s.stage));

  if (interrupted.length === 0) {
    return;
  }

  log(
    `feishu[${accountId}]: found ${interrupted.length} interrupted progress cards, recovering...`,
  );

  const reason = "后台连接中断";
  const updates = interrupted.map(async (state) => {
    try {
      await updateCardFeishu({
        cfg,
        messageId: state.messageId,
        card: buildProgressCard({
          stage: "aborted",
          abortMessage: reason,
          mode: "tools_summary",
        }),
        accountId,
      });
      log(`feishu[${accountId}]: recovered card ${state.messageId}`);
    } catch (error) {
      log(`feishu[${accountId}]: failed to recover card ${state.messageId}: ${String(error)}`);
    }
  });

  await Promise.allSettled(updates);

  const remaining = states.filter((s) => !interrupted.some((i) => i.messageId === s.messageId));
  await savePersistedCardStates(remaining);
}
```

### 3. 双重保险机制

**实时检测（已有）：**

- 运行中的卡片会在连续 3 次轮询失败后自动标记为"后台连接中断"
- 轮询间隔：4 秒
- 失败阈值：3 次（约 12 秒）

**启动恢复（新增）：**

- 服务启动时自动检测并更新所有未完成的卡片
- 适用于服务异常退出（崩溃、强制关闭等）的场景
- 确保用户看到的卡片状态与实际情况一致

## 技术细节

### 文件操作

**读取：**

```typescript
async function loadPersistedCardStates(): Promise<PersistedCardState[]> {
  try {
    const content = await fs.readFile(PERSISTENCE_FILE_PATH, "utf-8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
```

**写入：**

```typescript
async function savePersistedCardStates(states: PersistedCardState[]): Promise<void> {
  try {
    const dir = path.dirname(PERSISTENCE_FILE_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(PERSISTENCE_FILE_PATH, JSON.stringify(states, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save persisted card states:", error);
  }
}
```

### 类方法

**持久化状态：**

```typescript
private async persistState(): Promise<void> {
  if (!this.messageId || !this.accountId) {
    return;
  }
  await persistCardState({
    messageId: this.messageId,
    chatId: this.chatId,
    accountId: this.accountId,
    stage: this.stage,
    startedAt: Date.now(),
  });
}
```

**删除持久化：**

```typescript
private async removePersistedState(): Promise<void> {
  if (!this.messageId) {
    return;
  }
  await removePersistedCardState(this.messageId);
}
```

## 测试覆盖

**单元测试：**

```typescript
it("should recover interrupted cards on startup", async () => {
  const cfg = {} as never;
  const session = new FeishuProgressCardSession({
    cfg,
    chatId: "test-chat",
    accountId: "main",
    mode: "tools_summary",
  });

  await session.noteToolStart({ name: "read", phase: "start" });
  // Wait for persistence to complete
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Clear in-memory state to simulate restart
  resetFeishuProgressCardStateForTests();

  // Simulate restart by calling recovery function
  const { recoverInterruptedProgressCards } = await import("./progress-card.js");
  await recoverInterruptedProgressCards({
    cfg,
    accountId: "main",
    logger: vi.fn(),
  });

  // Verify that the card was updated to aborted state
  const updateCalls = updateCardFeishuMock.mock.calls;
  const recoveryUpdate = updateCalls.find((call) => {
    const card = call[0].card;
    return card.header.template === "red";
  });
  expect(recoveryUpdate).toBeDefined();
});
```

**测试结果：**

- 所有测试通过（21/21）
- 完整飞书扩展测试通过（381/381）

## 使用场景

### 场景 1：正常运行中断

**情况：**
用户发送消息，卡片显示"正在调用工具"，此时服务崩溃。

**处理：**

1. 卡片状态已持久化到文件
2. 服务重启时，`recoverInterruptedProgressCards()` 被调用
3. 检测到未完成的卡片，更新为"后台连接中断"
4. 用户看到卡片状态更新，知道需要重新发送消息

### 场景 2：后台任务监控失败

**情况：**
用户发送消息，卡片显示"后台任务进行中"，此时网络中断。

**处理：**

1. 实时检测机制：连续 3 次轮询失败（约 12 秒）
2. 卡片自动标记为"后台连接中断"
3. 用户看到状态更新，知道需要重新发送消息

### 场景 3：服务异常退出

**情况：**
服务被强制关闭（kill -9），未执行正常的清理流程。

**处理：**

1. 卡片状态已持久化到文件
2. 服务重启时，`recoverInterruptedProgressCards()` 被调用
3. 检测到所有未完成的卡片，批量更新为"后台连接中断"
4. 用户看到所有卡片状态更新

## 性能考虑

**文件 I/O：**

- 使用异步文件操作（`fs/promises`）
- 仅在卡片创建/更新时写入，频率较低
- 文件大小通常很小（每个卡片约 100 字节）

**启动时间：**

- 恢复操作在后台异步执行
- 不阻塞服务启动
- 使用 `Promise.allSettled()` 并行更新多个卡片

**内存占用：**

- 持久化文件仅包含必要字段
- 完成的卡片自动清理
- 正常情况下文件为空或很小

## 故障排查

### 问题 1：卡片一直显示"正在运行"

**可能原因：**

1. 持久化文件写入失败
2. 恢复函数未被调用
3. 卡片更新 API 调用失败

**排查步骤：**

1. 检查持久化文件是否存在：`ls -lh ~/.openclaw/feishu-progress-cards.json`
2. 查看启动日志：`grep "recover" /tmp/openclaw-gateway.log`
3. 检查飞书 API 调用日志

### 问题 2：持久化文件过大

**可能原因：**

1. 大量卡片未正常完成
2. 清理逻辑未执行

**解决方法：**

1. 手动删除文件：`rm ~/.openclaw/feishu-progress-cards.json`
2. 重启服务
3. 检查代码中的清理逻辑

### 问题 3：恢复失败

**可能原因：**

1. 飞书 API 权限不足
2. 消息 ID 已失效
3. 网络连接问题

**解决方法：**

1. 查看错误日志
2. 检查飞书 API 权限
3. 手动清理持久化文件

## 未来优化

1. **过期清理**：自动清理超过 24 小时的持久化条目
2. **批量更新**：优化多个卡片的批量更新性能
3. **重试机制**：恢复失败时自动重试
4. **监控告警**：持久化文件过大时发送告警

## 相关文件

- `extensions/feishu/src/progress-card.ts`：核心实现
- `extensions/feishu/src/progress-card.test.ts`：单元测试
- `extensions/feishu/src/monitor.account.ts`：启动时调用恢复函数
- `extensions/feishu/docs/user-guide.md`：用户文档
