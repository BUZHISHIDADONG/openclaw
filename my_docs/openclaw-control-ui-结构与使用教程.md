# OpenClaw Control 控制台结构与使用教程（WSL 本地）

## 1. 当前环境（本次实测）

- 代码目录：`/path/to/openclaw`
- 控制台地址：`http://127.0.0.1:18789/overview`
- 网关 WebSocket：`ws://127.0.0.1:18789`
- Browser Control 服务：`http://127.0.0.1:18791/`
- 控制台版本：`2026.3.3`
- 健康状态：`正常`

## 2. 快速启动与连接

1. 在 WSL 里先做脚本自检（可选，但推荐首次执行时先跑一次）：

```bash
cd "/path/to/openclaw"
./restart-gateway-proxy-feishu.sh --check
```

2. 使用统一脚本启动 / 重启网关：

```bash
cd "/path/to/openclaw"
./restart-gateway-proxy-feishu.sh
```

脚本会自动处理这几件事：

- 切到 Node 24
- 为飞书域名补齐 `NO_PROXY`
- 执行后台 hard restart
- 把日志写到 `/tmp/openclaw-gateway.log`

3. 如需确认启动过程，直接看日志：

```bash
tail -n 120 -f /tmp/openclaw-gateway.log
```

4. 打开浏览器访问：

```text
http://127.0.0.1:18789/overview
```

5. 在“概览 -> 网关访问”确认：

- WebSocket URL：`ws://127.0.0.1:18789`
- 网关令牌：与 `~/.openclaw/openclaw.json` 中 `gateway.auth.token` 一致
- 点击“连接”

6. 如出现鉴权限流报错：

- 报错：`unauthorized: too many failed authentication attempts (retry later)`
- 处理：等待约 5 分钟，或重启 gateway 后再连接。

## 3. 控制台结构总览

控制台左侧按功能分组：

1. 聊天

- 聊天（`/chat`）

2. 控制

- 概览（`/overview`）
- 频道（`/channels`）
- 实例（`/instances`）
- 会话（`/sessions`）
- 使用情况（`/usage`）
- 定时任务（`/cron`）

3. 代理

- 代理（`/agents`）
- 技能（`/skills`）
- 节点（`/nodes`）

4. 设置

- 配置（`/config`）
- 调试（`/debug`）
- 日志（`/logs`）

## 4. 每个标签页怎么用

### 4.1 聊天（`/chat`）

作用：直接和网关会话交互，做快速验证与人工干预。  
常用操作：

- 选择会话（Main Session / New session）
- 输入消息并发送
- 用于验证模型与工具链是否可用

### 4.2 概览（`/overview`）

作用：连接入口 + 网关状态快照。  
常用操作：

- 设置 WebSocket URL / Token / 默认会话 key / 语言
- 点击“连接”与“刷新”
- 观察状态、运行时间、实例数、会话数、定时任务状态

### 4.3 频道（`/channels`）

作用：管理外部通讯渠道。  
常见模块（页面实测）：

- WhatsApp
- Telegram
- 其他渠道状态块

常用操作：

- 先看 `Configured / Running / Connected`
- 按需执行 `Show QR / Relink / Logout / Refresh`
- 保存并回读配置

### 4.4 实例（`/instances`）

作用：查看已连接客户端与节点的在线信号。  
常用操作：

- 点击 Refresh 拉最新 presence
- 检查角色、作用域（scopes）、最后活动时间
- 判断“谁在线、谁断线、谁权限异常”

### 4.5 会话（`/sessions`）

作用：查看活动会话与会话级配置。  
常用操作：

- 按时间窗、数量、存储来源筛选
- 定位“哪个会话占用上下文”
- 结合 `/new` 或 sessions API 做上下文重置

### 4.6 使用情况（`/usage`）

作用：按时间查看 token 与成本趋势。  
常用操作：

- 选择 Today / 7d / 30d
- Refresh 拉取数据
- 用过滤器定位高消耗会话

### 4.7 定时任务（`/cron`）

作用：创建和管理定时唤醒/定时执行。  
常用操作：

- 新建任务（名称、代理 ID、启用状态、计划）
- 查看任务列表与运行历史
- 用筛选器定位失败任务

### 4.8 代理（`/agents`）

作用：管理 agent 的工作区、模型、路由、能力。  
常用操作：

- 查看代理总数与默认代理
- 检查 workspace 路径
- 调整模型、技能、渠道映射

### 4.9 技能（`/skills`）

作用：管理技能可用性与密钥注入。  
常用操作：

- 查看内置技能列表
- 按分类筛选技能
- 检查某技能是否启用、是否缺密钥

### 4.10 节点（`/nodes`）

作用：管理配对设备、执行审批与命令公开面。  
常用操作：

- 配置 Exec approvals（Defaults / main）
- 设置策略：Deny / Allowlist / Full / Ask
- 选择网关或具体节点范围

### 4.11 配置（`/config`）

作用：安全编辑 `~/.openclaw/openclaw.json`。  
常用操作：

- 使用标签过滤快速定位配置项
- 修改后保存并观察校验状态（valid）
- 常见关注项：Gateway、Models、Channels、Skills、Secrets

### 4.12 调试（`/debug`）

作用：查看网关快照、健康信息、事件与手动 RPC。  
常用操作：

- Refresh 查看 status/health
- 检查 heartbeat、channelSummary、sessions 路径
- 作为“配置改了但行为不对”时的第一排查入口

### 4.13 日志（`/logs`）

作用：实时查看网关 JSONL 日志流。  
常用操作：

- 按级别过滤（trace/debug/info/warn/error/fatal）
- Auto-follow 持续跟踪
- 导出可见日志用于问题复盘

## 5. 推荐日常使用流程

1. 启动网关，先开 `概览` 确认 `健康状况=正常`。
2. 到 `频道` 看目标渠道是否 `Configured + Running + Connected`。
3. 到 `聊天` 做一条最小请求验证端到端可用。
4. 到 `实例` 确认当前控制台客户端在线且权限正确。
5. 需要长期任务时去 `定时任务` 建任务并观察运行历史。
6. 出异常优先查 `调试`，再查 `日志`。

## 6. 常见故障处理

### 6.1 页面在线但连接不上

- 检查 Token 是否与 `~/.openclaw/openclaw.json` 一致。
- 检查 WebSocket URL 是否是 `ws://127.0.0.1:18789`。
- 观察 `日志` 页是否出现 unauthorized / rate_limited。

### 6.2 反复出现 `retry later`

- 说明短时间内鉴权失败次数过多。
- 等待限流窗口恢复，或直接重启 gateway 清除内存限流状态。

### 6.3 启动后端口不监听

- 执行：`ss -ltnp | rg "18789|18791"`
- 若未监听，回看 `/tmp/openclaw-gateway.log` 与脚本启动输出
- 建议在 WSL 原生目录运行，不要长期在 `/mnt/d/...` 上运行

### 6.4 飞书后台提示“未检测到应用连接信息”

- 现象：飞书“事件与回调”页面提示未检测到长连接。
- 常见原因：网关进程继承了系统代理（`HTTP_PROXY/HTTPS_PROXY`），导致飞书鉴权请求异常。
- 处理：直接使用 `./restart-gateway-proxy-feishu.sh` 重启；脚本会自动补齐飞书域名的 `NO_PROXY`，这是当前默认推荐方式。

## 7. 常用维护命令

```bash
# 启动前自检
cd "/path/to/openclaw"
./restart-gateway-proxy-feishu.sh --check

# 启动 / 重启（默认推荐）
cd "/path/to/openclaw"
./restart-gateway-proxy-feishu.sh

# 停止
pkill -f 'openclaw-gateway|run-node.mjs gateway run --bind loopback --port 18789' || true

# 实时日志
tail -n 120 -f /tmp/openclaw-gateway.log

# 监听检查
ss -ltnp | rg "18789|18791"

# 页面探活
curl -s -o /dev/null -w 'HTTP=%{http_code}\n' "http://127.0.0.1:18789/overview"

# 取 token
node -e 'const fs=require("fs");const p=process.env.HOME+"/.openclaw/openclaw.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));console.log(j?.gateway?.auth?.token ?? "")'
```
