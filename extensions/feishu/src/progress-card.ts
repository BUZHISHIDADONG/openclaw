import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { isSilentReplyText } from "openclaw/plugin-sdk";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { SILENT_REPLY_TOKEN, stripSilentToken } from "../../../src/auto-reply/tokens.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { sendCardFeishu, updateCardFeishu } from "./send.js";
import { mergeStreamingText } from "./streaming-card.js";

export type FeishuProgressCardMode = "off" | "tools" | "tools_summary";

type ProgressStage =
  | "pending"
  | "thinking"
  | "tool"
  | "answering"
  | "background"
  | "waiting_final"
  | "done"
  | "aborted"
  | "error";
type ToolStatus = "running" | "done" | "error";

type ToolEntry = {
  id: string;
  name: string;
  toolCallId?: string;
  status: ToolStatus;
  detail?: string;
};

type NoteAnswerPreviewOptions = {
  mode?: "snapshot" | "delta";
};

type ToolLifecycleEvent = {
  phase?: string;
  name?: string;
  toolCallId?: string;
  meta?: string;
  isError?: boolean;
};

type BackgroundRunEntry = {
  label: string;
  elapsedMs?: number;
  timeoutSeconds?: number;
  latestActivity?: string;
};

type BackgroundCompletedEntry = {
  label: string;
  status: "ok" | "timeout" | "error" | "unknown";
  summary?: string;
};

type BackgroundActivitySnapshot = {
  totalActiveRuns: number;
  activeRuns: BackgroundRunEntry[];
  totalTrackedRuns?: number;
  completedSuccessfulRuns?: number;
  completedFailedRuns?: number;
  latestCompletedRun?: BackgroundCompletedEntry;
  latestRequesterReply?: string;
  baselineRequesterReply?: string;
};

type BackgroundMonitor = {
  getSnapshot: () => Promise<BackgroundActivitySnapshot | undefined>;
  intervalMs?: number;
};

type BackgroundChangeSubscribe = (listener: () => void) => () => void;

type CreateFeishuProgressCardSessionParams = {
  cfg: ClawdbotConfig;
  chatId: string;
  chatType?: "group" | "p2p";
  targetSessionKey?: string;
  accountId?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
  threadId?: string;
  mentionTargets?: MentionTarget[];
  mode: Exclude<FeishuProgressCardMode, "off">;
  onFailure?: (error: unknown) => void;
  backgroundMonitor?: BackgroundMonitor;
  backgroundChangeSubscribe?: BackgroundChangeSubscribe;
};

const TOOL_LIMIT = 5;
const SUMMARY_LIMIT = 140;
const PREVIEW_LIMIT = 1200;
const UPDATE_THROTTLE_MS = 500;
const BACKGROUND_MONITOR_MAX_FAILURES = 3;
const STOP_BUTTON_TEXT = "停止";
const STOP_BUTTON_COMMAND = "/stop";
const BACKGROUND_MONITOR_INTERVAL_MS = 4000;
const BACKGROUND_RUN_DISPLAY_LIMIT = 3;
const BACKGROUND_ACTIVITY_LIMIT = 120;
const NO_FINAL_TEXT_NOTICE = "本轮无最终文本，仅执行工具/发送附件。";
const STOP_REQUESTED_TTL_MS = 60 * 60_000;
const WAITING_FINAL_TIMEOUT_MS = 10 * 60_000;
const PERSISTENCE_FILE_PATH = path.join(os.homedir(), ".openclaw", "feishu-progress-cards.json");

const stopRequestedCardIds = new Map<string, number>();
const activeProgressCardSessions = new Set<FeishuProgressCardSession>();
let persistenceMutationQueue: Promise<void> = Promise.resolve();

type PersistedCardState = {
  messageId: string;
  chatId: string;
  accountId: string;
  stage: ProgressStage;
  startedAt: number;
};

function isTerminalStage(stage: ProgressStage): boolean {
  return stage === "done" || stage === "aborted" || stage === "error";
}

function pruneStopRequestedCardIds(now: number) {
  for (const [messageId, markedAt] of stopRequestedCardIds.entries()) {
    if (!messageId || now - markedAt > STOP_REQUESTED_TTL_MS) {
      stopRequestedCardIds.delete(messageId);
    }
  }
}

export function markFeishuProgressCardStopRequested(messageId: string): void {
  const normalized = messageId.trim();
  if (!normalized) {
    return;
  }
  const now = Date.now();
  stopRequestedCardIds.set(normalized, now);
  pruneStopRequestedCardIds(now);
}

export async function abortActiveFeishuProgressCards(params?: {
  accountId?: string;
  reason?: string;
}): Promise<void> {
  const reason =
    truncateText(sanitizeInlineText(params?.reason), PREVIEW_LIMIT) ??
    "网关或飞书通道已停止，本轮任务被中途打断，请重试。";
  const sessions = [...activeProgressCardSessions].filter((session) =>
    session.matchesAccountId(params?.accountId),
  );
  await Promise.allSettled(sessions.map((session) => session.abort({ reason })));
}

async function loadPersistedCardStates(): Promise<PersistedCardState[]> {
  try {
    const content = await fs.readFile(PERSISTENCE_FILE_PATH, "utf-8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function savePersistedCardStates(states: PersistedCardState[]): Promise<void> {
  try {
    const dir = path.dirname(PERSISTENCE_FILE_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(PERSISTENCE_FILE_PATH, JSON.stringify(states, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save persisted card states:", error);
  }
}

function runPersistedStateMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = persistenceMutationQueue.then(operation, operation);
  persistenceMutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function persistCardState(state: PersistedCardState): Promise<void> {
  await runPersistedStateMutation(async () => {
    const states = await loadPersistedCardStates();
    const index = states.findIndex((s) => s.messageId === state.messageId);
    if (index >= 0) {
      states[index] = state;
    } else {
      states.push(state);
    }
    await savePersistedCardStates(states);
  });
}

async function removePersistedCardState(messageId: string): Promise<void> {
  await runPersistedStateMutation(async () => {
    const states = await loadPersistedCardStates();
    const filtered = states.filter((s) => s.messageId !== messageId);
    await savePersistedCardStates(filtered);
  });
}

export async function persistFeishuProgressCardStateForTests(
  state: PersistedCardState,
): Promise<void> {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error(
      "persistFeishuProgressCardStateForTests() is only available in test environments",
    );
  }
  await persistCardState(state);
}

export async function recoverInterruptedProgressCards(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  logger?: (message: string) => void;
}): Promise<void> {
  const { cfg, accountId, logger } = params;
  const log = logger ?? console.log;

  const states = await runPersistedStateMutation(() => loadPersistedCardStates());
  const interrupted = states.filter((s) => s.accountId === accountId && !isTerminalStage(s.stage));

  if (interrupted.length === 0) {
    return;
  }

  log(
    `feishu[${accountId}]: found ${interrupted.length} interrupted progress cards, recovering...`,
  );

  const reason = "后台连接中断";
  const recoveredMessageIds = new Set<string>();
  const updates = interrupted.map(async (state) => {
    try {
      await updateCardFeishu({
        cfg,
        messageId: state.messageId,
        card: buildProgressCard({
          stage: "aborted",
          abortMessage: reason,
          mode: "tools_summary",
          tools: [],
          externalFinalNotice: false,
          controlsEnabled: false,
          backgroundRuns: [],
          totalActiveRuns: 0,
          totalTrackedRuns: 0,
          completedSuccessfulRuns: 0,
          completedFailedRuns: 0,
          canStop: false,
        }),
        accountId,
      });
      recoveredMessageIds.add(state.messageId);
      log(`feishu[${accountId}]: recovered card ${state.messageId}`);
    } catch (error) {
      log(`feishu[${accountId}]: failed to recover card ${state.messageId}: ${String(error)}`);
    }
  });

  await Promise.allSettled(updates);

  if (recoveredMessageIds.size === 0) {
    return;
  }

  await runPersistedStateMutation(async () => {
    const latestStates = await loadPersistedCardStates();
    const remaining = latestStates.filter((s) => !recoveredMessageIds.has(s.messageId));
    await savePersistedCardStates(remaining);
  });
}

export function resetFeishuProgressCardStateForTests(): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error(
      "resetFeishuProgressCardStateForTests() is only available in test environments",
    );
  }
  stopRequestedCardIds.clear();
  activeProgressCardSessions.clear();
  persistenceMutationQueue = Promise.resolve();
}

function isFeishuProgressCardStopRequested(messageId: string | undefined): boolean {
  const normalized = messageId?.trim();
  if (!normalized) {
    return false;
  }
  const now = Date.now();
  pruneStopRequestedCardIds(now);
  const markedAt = stopRequestedCardIds.get(normalized);
  if (markedAt === undefined) {
    return false;
  }
  if (now - markedAt > STOP_REQUESTED_TTL_MS) {
    stopRequestedCardIds.delete(normalized);
    return false;
  }
  return true;
}

export function resolveFeishuProgressCardMode(config: {
  progressCard?: { mode?: FeishuProgressCardMode };
}): FeishuProgressCardMode {
  const mode = config.progressCard?.mode;
  return mode === "tools" || mode === "tools_summary" ? mode : "off";
}

function sanitizeInlineText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .replace(/```[\s\S]*?```/g, "[代码块]")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function summarizeReasoningText(text: string | undefined): string | undefined {
  const normalized = sanitizeInlineText(text)?.replace(/^(Reasoning|Thinking)\s*:\s*/i, "");
  return truncateText(normalized, SUMMARY_LIMIT);
}

function summarizeToolEntry(entry: ToolEntry): string {
  const icon = entry.status === "error" ? "❌" : entry.status === "done" ? "✅" : "⏳";
  const detail = sanitizeInlineText(entry.detail);
  return detail ? `- ${icon} \`${entry.name}\`: ${detail}` : `- ${icon} \`${entry.name}\``;
}

function formatDurationLabel(valueMs: number | undefined): string | undefined {
  if (!Number.isFinite(valueMs) || valueMs === undefined || valueMs <= 0) {
    return undefined;
  }
  const totalSeconds = Math.max(1, Math.floor(valueMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${totalMinutes} 分 ${seconds} 秒` : `${totalMinutes} 分钟`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function formatTimeoutLabel(timeoutSeconds: number | undefined): string | undefined {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds === undefined || timeoutSeconds <= 0) {
    return undefined;
  }
  return formatDurationLabel(timeoutSeconds * 1000);
}

function summarizeBackgroundRun(entry: BackgroundRunEntry): string {
  const label = sanitizeInlineText(entry.label) ?? "未命名子任务";
  const elapsed = formatDurationLabel(entry.elapsedMs);
  const timeout = formatTimeoutLabel(entry.timeoutSeconds);
  const latest = truncateText(sanitizeInlineText(entry.latestActivity), BACKGROUND_ACTIVITY_LIMIT);
  const timing =
    elapsed && timeout
      ? `已运行 ${elapsed} / 上限 ${timeout}`
      : elapsed
        ? `已运行 ${elapsed}`
        : timeout
          ? `上限 ${timeout}`
          : undefined;
  const segments = [`- ⏳ \`${label}\``];
  if (timing) {
    segments.push(`· ${timing}`);
  }
  if (latest) {
    segments.push(`· 最近动态：${latest}`);
  }
  return segments.join(" ");
}

function summarizeCompletedRun(entry: BackgroundCompletedEntry): string {
  const label = sanitizeInlineText(entry.label) ?? "未命名子任务";
  const icon =
    entry.status === "ok"
      ? "✅"
      : entry.status === "timeout"
        ? "⏱️"
        : entry.status === "error"
          ? "❌"
          : "ℹ️";
  const statusLabel =
    entry.status === "ok"
      ? "已完成"
      : entry.status === "timeout"
        ? "已超时"
        : entry.status === "error"
          ? "已失败"
          : "已结束";
  const summary = truncateText(sanitizeInlineText(entry.summary), BACKGROUND_ACTIVITY_LIMIT);
  return summary
    ? `${icon} 最近完成：\`${label}\` · ${statusLabel} · ${summary}`
    : `${icon} 最近完成：\`${label}\` · ${statusLabel}`;
}

function buildSubagentProgressLine(params: {
  totalTrackedRuns: number;
  completedSuccessfulRuns: number;
  completedFailedRuns: number;
  totalActiveRuns: number;
}): string {
  const totalTrackedRuns = Math.max(0, params.totalTrackedRuns);
  if (totalTrackedRuns <= 0) {
    return "";
  }
  const completedSuccessfulRuns = Math.max(0, params.completedSuccessfulRuns);
  const completedFailedRuns = Math.max(0, params.completedFailedRuns);
  const totalActiveRuns = Math.max(0, params.totalActiveRuns);
  if (completedFailedRuns > 0) {
    const segments = [
      `成功 ${completedSuccessfulRuns}/${totalTrackedRuns}`,
      `失败 ${completedFailedRuns} 个`,
    ];
    if (totalActiveRuns > 0) {
      segments.push(`仍有 ${totalActiveRuns} 个执行中`);
    }
    return segments.join(" · ");
  }
  if (totalActiveRuns > 0) {
    return `已完成 ${completedSuccessfulRuns}/${totalTrackedRuns} 个子任务 · 仍有 ${totalActiveRuns} 个执行中`;
  }
  return `已完成 ${completedSuccessfulRuns}/${totalTrackedRuns} 个子任务`;
}

function normalizeObservedReplyText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed || isSilentReplyText(trimmed)) {
    return undefined;
  }
  if (trimmed.includes(SILENT_REPLY_TOKEN)) {
    const stripped = stripSilentToken(trimmed, SILENT_REPLY_TOKEN);
    if (stripped !== trimmed) {
      // Mixed-content NO_REPLY marks a suppressed/internal turn. Do not adopt it
      // as the requester's stable final reply for the progress card.
      return undefined;
    }
  }
  return trimmed;
}

function buildProgressTitle(stage: ProgressStage): string {
  if (stage === "done") {
    return "🦞 OpenClaw 已完成";
  }
  if (stage === "aborted") {
    return "🦞 OpenClaw 已中断";
  }
  if (stage === "error") {
    return "🦞 OpenClaw 处理失败";
  }
  if (stage === "waiting_final") {
    return "🦞 OpenClaw 等待最终汇总";
  }
  return "🦞 OpenClaw 正在处理中";
}

function buildStatusLine(params: {
  stage: ProgressStage;
  toolCount: number;
  summaryText?: string;
  abortMessage?: string;
  externalFinalNotice: boolean;
  totalActiveRuns: number;
  totalTrackedRuns: number;
  completedSuccessfulRuns: number;
  completedFailedRuns: number;
}): string {
  const trackedProgressLabel = buildSubagentProgressLine({
    totalTrackedRuns: params.totalTrackedRuns,
    completedSuccessfulRuns: params.completedSuccessfulRuns,
    completedFailedRuns: params.completedFailedRuns,
    totalActiveRuns: params.totalActiveRuns,
  });
  const trackedProgressSuffix = trackedProgressLabel ? ` · ${trackedProgressLabel}` : "";
  if (params.stage === "done") {
    if (params.externalFinalNotice) {
      return trackedProgressLabel
        ? `✅ 已完成 · ${trackedProgressLabel} · 完整回复已作为后续消息发送`
        : `✅ 已完成 · 共 ${params.toolCount} 个工具步骤 · 完整回复已作为后续消息发送`;
    }
    return trackedProgressLabel
      ? `✅ 已完成 · ${trackedProgressLabel}`
      : `✅ 已完成 · 共 ${params.toolCount} 个工具步骤`;
  }
  if (params.stage === "aborted") {
    return params.abortMessage ? `🛑 任务已中断 · ${params.abortMessage}` : "🛑 任务已中断";
  }
  if (params.stage === "error") {
    return "❌ 处理过程中遇到错误";
  }
  if (params.stage === "waiting_final") {
    return trackedProgressLabel
      ? `⏳ 后台任务已结束 · ${trackedProgressLabel} · 等待最终汇总`
      : "⏳ 后台任务已结束，等待最终汇总";
  }
  if (params.stage === "background") {
    if (trackedProgressLabel) {
      return `⏳ 子任务进度已推进 · ${trackedProgressLabel}`;
    }
    const activeLabel =
      params.totalActiveRuns === 1 ? "1 个子任务" : `${params.totalActiveRuns} 个子任务`;
    return `⏳ 已完成本轮汇报 · 后台仍有 ${activeLabel} 执行中`;
  }
  if (params.stage === "answering") {
    return `⏳ 正在整理回复${trackedProgressSuffix}`;
  }
  if (params.stage === "tool") {
    return `⏳ 正在调用工具${trackedProgressSuffix}`;
  }
  if (params.stage === "thinking") {
    return params.summaryText
      ? `⏳ 正在分析问题 · ${params.summaryText}${trackedProgressSuffix}`
      : `⏳ 正在分析问题${trackedProgressSuffix}`;
  }
  return `⏳ 已收到请求，正在开始处理${trackedProgressSuffix}`;
}

function buildProgressCardContent(state: {
  stage: ProgressStage;
  tools: ToolEntry[];
  summaryText?: string;
  abortMessage?: string;
  previewText?: string;
  finalText?: string;
  externalFinalNotice: boolean;
  mentionTargets?: MentionTarget[];
  mode: Exclude<FeishuProgressCardMode, "off">;
  backgroundRuns: BackgroundRunEntry[];
  totalActiveRuns: number;
  totalTrackedRuns: number;
  completedSuccessfulRuns: number;
  completedFailedRuns: number;
  latestCompletedRun?: BackgroundCompletedEntry;
}): string {
  const sections: string[] = [];
  const toolCount = state.tools.length;
  sections.push(
    buildStatusLine({
      stage: state.stage,
      toolCount,
      summaryText: state.summaryText,
      abortMessage: state.abortMessage,
      externalFinalNotice: state.externalFinalNotice,
      totalActiveRuns: state.totalActiveRuns,
      totalTrackedRuns: state.totalTrackedRuns,
      completedSuccessfulRuns: state.completedSuccessfulRuns,
      completedFailedRuns: state.completedFailedRuns,
    }),
  );

  if (state.totalTrackedRuns > 0) {
    const lines = [
      "### 子任务进度",
      buildSubagentProgressLine({
        totalTrackedRuns: state.totalTrackedRuns,
        completedSuccessfulRuns: state.completedSuccessfulRuns,
        completedFailedRuns: state.completedFailedRuns,
        totalActiveRuns: state.totalActiveRuns,
      }),
    ];
    if (state.latestCompletedRun) {
      lines.push(summarizeCompletedRun(state.latestCompletedRun));
    }
    sections.push(lines.filter(Boolean).join("\n"));
  }

  if (state.totalActiveRuns > 0) {
    const backgroundLines = state.backgroundRuns
      .slice(0, BACKGROUND_RUN_DISPLAY_LIMIT)
      .map(summarizeBackgroundRun);
    if (state.totalActiveRuns > backgroundLines.length) {
      backgroundLines.push(
        `- … 另有 ${state.totalActiveRuns - backgroundLines.length} 个子任务未展开`,
      );
    }
    sections.push(["### 后台任务监控", ...backgroundLines].join("\n"));
  }

  const showDetailedTools =
    (state.stage === "pending" ||
      state.stage === "thinking" ||
      state.stage === "tool" ||
      state.stage === "answering") &&
    state.totalActiveRuns === 0;
  if (showDetailedTools && toolCount > 0) {
    sections.push(["### 执行进度", ...state.tools.map(summarizeToolEntry)].join("\n"));
  } else if (toolCount > 0) {
    sections.push(`### 执行进度\n已收起详细步骤，共 ${toolCount} 个工具步骤。`);
  }

  if (state.stage === "aborted" && state.abortMessage) {
    sections.push(`### 中断原因\n${state.abortMessage}`);
  }

  if (state.mode === "tools_summary" && !isTerminalStage(state.stage) && state.summaryText) {
    sections.push(`### 当前思路摘要\n${state.summaryText}`);
  }

  const previewText = truncateText(state.previewText, PREVIEW_LIMIT);
  const resolvedFinalText = state.finalText?.trim()
    ? state.mentionTargets?.length
      ? buildMentionedCardContent(state.mentionTargets, state.finalText)
      : state.finalText
    : undefined;

  if (resolvedFinalText) {
    const heading = state.stage === "done" ? "### 最终回复" : "### 阶段更新";
    const lines = [`${heading}\n${resolvedFinalText}`];
    if (state.externalFinalNotice) {
      lines.push(
        state.stage === "done"
          ? "完整回复已作为后续消息发送。"
          : "本轮回复较长，已作为后续消息发送。",
      );
    }
    sections.push(lines.join("\n\n"));
  } else if (state.externalFinalNotice) {
    const heading = state.stage === "done" ? "### 最终回复" : "### 阶段更新";
    const body =
      state.stage === "done"
        ? "完整回复较长，已作为后续消息发送。\n"
        : "本轮回复较长，已作为后续消息发送。\n";
    sections.push(`${heading}\n${body}`);
  } else if (
    previewText &&
    !(
      state.totalTrackedRuns > 0 &&
      (state.stage === "waiting_final" || Boolean(state.latestCompletedRun))
    )
  ) {
    const heading =
      state.stage === "background" || state.stage === "waiting_final"
        ? "### 阶段更新"
        : "### 当前回复";
    sections.push(`${heading}\n${previewText}`);
  }

  return sections.filter(Boolean).join("\n\n");
}

const CONTROL_COMPATIBILITY_ERROR_MARKERS = [
  "unsupported tag",
  "no longer support this capability",
  "failed to create card content",
] as const;

function buildProgressCardActionElement(params: {
  controlsEnabled: boolean;
  canStop: boolean;
  targetSessionKey?: string;
  targetChatId?: string;
  targetChatType?: "group" | "p2p";
  targetRootId?: string;
  targetThreadId?: string;
  targetCardMessageId?: string;
}): Record<string, unknown> | null {
  if (!params.controlsEnabled || !params.canStop) {
    return null;
  }
  return {
    tag: "button",
    type: "danger",
    text: {
      tag: "plain_text",
      content: STOP_BUTTON_TEXT,
    },
    value: {
      text: STOP_BUTTON_COMMAND,
      command: STOP_BUTTON_COMMAND,
      ...(params.targetSessionKey ? { targetSessionKey: params.targetSessionKey } : {}),
      ...(params.targetChatId ? { targetChatId: params.targetChatId } : {}),
      ...(params.targetChatType ? { targetChatType: params.targetChatType } : {}),
      ...(params.targetRootId ? { targetRootId: params.targetRootId } : {}),
      ...(params.targetThreadId ? { targetThreadId: params.targetThreadId } : {}),
      ...(params.targetCardMessageId ? { targetCardMessageId: params.targetCardMessageId } : {}),
    },
  };
}

function isUnsupportedProgressCardControlError(error: unknown): boolean {
  const messages = new Set<string>();
  if (typeof error === "string") {
    messages.add(error);
  }
  if (error instanceof Error && error.message) {
    messages.add(error.message);
  }
  if (typeof error === "object" && error !== null) {
    const response = (
      error as {
        response?: {
          data?: {
            msg?: string;
            message?: string;
            error?: string;
          };
        };
      }
    ).response;
    if (typeof response?.data?.msg === "string") {
      messages.add(response.data.msg);
    }
    if (typeof response?.data?.message === "string") {
      messages.add(response.data.message);
    }
    if (typeof response?.data?.error === "string") {
      messages.add(response.data.error);
    }
  }
  messages.add(String(error));
  const details = [...messages].join("\n").toLowerCase();
  return CONTROL_COMPATIBILITY_ERROR_MARKERS.some((marker) => details.includes(marker));
}

function buildProgressCard(params: {
  stage: ProgressStage;
  tools: ToolEntry[];
  summaryText?: string;
  abortMessage?: string;
  previewText?: string;
  finalText?: string;
  externalFinalNotice: boolean;
  mentionTargets?: MentionTarget[];
  mode: Exclude<FeishuProgressCardMode, "off">;
  controlsEnabled: boolean;
  backgroundRuns: BackgroundRunEntry[];
  totalActiveRuns: number;
  totalTrackedRuns: number;
  completedSuccessfulRuns: number;
  completedFailedRuns: number;
  latestCompletedRun?: BackgroundCompletedEntry;
  canStop: boolean;
  targetSessionKey?: string;
  targetChatId?: string;
  targetChatType?: "group" | "p2p";
  targetRootId?: string;
  targetThreadId?: string;
  targetCardMessageId?: string;
}): Record<string, unknown> {
  const actionElement = buildProgressCardActionElement({
    controlsEnabled: params.controlsEnabled,
    canStop: params.canStop,
    targetSessionKey: params.targetSessionKey,
    targetChatId: params.targetChatId,
    targetChatType: params.targetChatType,
    targetRootId: params.targetRootId,
    targetThreadId: params.targetThreadId,
    targetCardMessageId: params.targetCardMessageId,
  });
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: buildProgressTitle(params.stage),
      },
      template:
        params.stage === "done"
          ? "green"
          : params.stage === "error" || params.stage === "aborted"
            ? "red"
            : "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: buildProgressCardContent(params),
        },
        ...(actionElement ? [actionElement] : []),
      ],
    },
  };
}

export class FeishuProgressCardSession {
  private readonly cfg: ClawdbotConfig;
  private readonly chatId: string;
  private readonly chatType?: "group" | "p2p";
  private readonly targetSessionKey?: string;
  private readonly accountId?: string;
  private readonly replyToMessageId?: string;
  private readonly replyInThread?: boolean;
  private readonly rootId?: string;
  private readonly threadId?: string;
  private readonly mentionTargets?: MentionTarget[];
  private readonly mode: Exclude<FeishuProgressCardMode, "off">;
  private readonly onFailure?: (error: unknown) => void;
  private readonly backgroundMonitor?: BackgroundMonitor;
  private readonly backgroundChangeSubscribe?: BackgroundChangeSubscribe;

  private started = false;
  private failed = false;
  private messageId: string | undefined;
  private stage: ProgressStage = "pending";
  private previewText = "";
  private finalText: string | undefined;
  private summaryText: string | undefined;
  private abortMessage: string | undefined;
  private externalFinalNotice = false;
  private controlsEnabled = true;
  private readonly tools = new Map<string, ToolEntry>();
  private toolOrder: string[] = [];
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private backgroundRuns: BackgroundRunEntry[] = [];
  private totalActiveRuns = 0;
  private totalTrackedRuns = 0;
  private completedSuccessfulRuns = 0;
  private completedFailedRuns = 0;
  private latestCompletedRun: BackgroundCompletedEntry | undefined;
  private latestRequesterReply: string | undefined;
  private baselineRequesterReply: string | undefined;
  private backgroundPhaseSeen = false;
  private parentTurnCompleted = false;
  private parentFinalDelivery: "none" | "inline" | "external" | "silent" = "none";
  private backgroundMonitorFailureCount = 0;
  private waitingFinalStartedAt: number | undefined;
  private stopRequested = false;
  private backgroundChangeUnsub: (() => void) | null = null;

  constructor(params: CreateFeishuProgressCardSessionParams) {
    this.cfg = params.cfg;
    this.chatId = params.chatId;
    this.chatType = params.chatType;
    this.targetSessionKey = params.targetSessionKey;
    this.accountId = params.accountId;
    this.replyToMessageId = params.replyToMessageId;
    this.replyInThread = params.replyInThread;
    this.rootId = params.rootId;
    this.threadId = params.threadId;
    this.mentionTargets = params.mentionTargets;
    this.mode = params.mode;
    this.onFailure = params.onFailure;
    this.backgroundMonitor = params.backgroundMonitor;
    this.backgroundChangeSubscribe = params.backgroundChangeSubscribe;
  }

  isStarted(): boolean {
    return this.started && !this.failed && typeof this.messageId === "string";
  }

  matchesAccountId(accountId: string | undefined): boolean {
    const normalized = accountId?.trim();
    if (!normalized) {
      return true;
    }
    return (this.accountId?.trim() || "") === normalized;
  }

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

  private async removePersistedState(): Promise<void> {
    if (!this.messageId) {
      return;
    }
    await removePersistedCardState(this.messageId);
  }

  private getVisibleTools(): ToolEntry[] {
    return this.toolOrder
      .slice(-TOOL_LIMIT)
      .map((toolId) => this.tools.get(toolId))
      .filter((tool): tool is ToolEntry => Boolean(tool));
  }

  private stopBackgroundMonitor(): void {
    if (!this.backgroundTimer) {
      return;
    }
    clearTimeout(this.backgroundTimer);
    this.backgroundTimer = null;
  }

  private stopBackgroundChangeSubscription(): void {
    if (!this.backgroundChangeUnsub) {
      return;
    }
    this.backgroundChangeUnsub();
    this.backgroundChangeUnsub = null;
  }

  private updateLifecycleRegistration(): void {
    if (this.started && !this.failed && !this.stopRequested && !isTerminalStage(this.stage)) {
      activeProgressCardSessions.add(this);
      return;
    }
    activeProgressCardSessions.delete(this);
  }

  private ensureBackgroundChangeSubscription(): void {
    if (
      !this.backgroundMonitor ||
      !this.backgroundChangeSubscribe ||
      this.backgroundChangeUnsub ||
      !this.started ||
      this.failed ||
      this.stopRequested ||
      isTerminalStage(this.stage)
    ) {
      return;
    }
    this.backgroundChangeUnsub = this.backgroundChangeSubscribe(() => {
      if (
        !this.started ||
        this.failed ||
        this.stopRequested ||
        isTerminalStage(this.stage) ||
        !this.backgroundMonitor
      ) {
        return;
      }
      this.scheduleBackgroundMonitor(50);
    });
  }

  private syncStopRequested(): void {
    if (this.stopRequested) {
      return;
    }
    if (!isFeishuProgressCardStopRequested(this.messageId)) {
      return;
    }
    this.stopRequested = true;
    this.clearFlushTimer();
    this.stopBackgroundMonitor();
    this.stopBackgroundChangeSubscription();
    this.updateLifecycleRegistration();
  }

  private fail(error: unknown): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.clearFlushTimer();
    this.stopBackgroundMonitor();
    this.stopBackgroundChangeSubscription();
    this.updateLifecycleRegistration();
    this.onFailure?.(error);
  }

  private canStop(): boolean {
    if (isTerminalStage(this.stage)) {
      return false;
    }
    return true;
  }

  private buildCard(): Record<string, unknown> {
    const shouldEmbedThreadContext = this.replyInThread === true;
    const targetRootId =
      shouldEmbedThreadContext && (this.rootId?.trim() || this.replyToMessageId?.trim())
        ? this.rootId?.trim() || this.replyToMessageId?.trim()
        : undefined;
    const targetThreadId =
      shouldEmbedThreadContext && this.threadId?.trim() ? this.threadId.trim() : undefined;
    return buildProgressCard({
      stage: this.stage,
      tools: this.getVisibleTools(),
      summaryText: this.summaryText,
      abortMessage: this.abortMessage,
      previewText: this.previewText,
      finalText: this.finalText,
      externalFinalNotice: this.externalFinalNotice,
      mentionTargets: this.mentionTargets,
      mode: this.mode,
      controlsEnabled: this.controlsEnabled,
      backgroundRuns: this.backgroundRuns,
      totalActiveRuns: this.totalActiveRuns,
      totalTrackedRuns: this.totalTrackedRuns,
      completedSuccessfulRuns: this.completedSuccessfulRuns,
      completedFailedRuns: this.completedFailedRuns,
      latestCompletedRun: this.latestCompletedRun,
      canStop: this.canStop(),
      targetSessionKey: this.targetSessionKey,
      targetChatId: this.chatId,
      targetChatType: this.chatType,
      targetRootId,
      targetThreadId,
      targetCardMessageId: this.messageId,
    });
  }

  private async withCompatibleCard<T>(
    send: (card: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    try {
      return await send(this.buildCard());
    } catch (error) {
      if (!this.controlsEnabled || !isUnsupportedProgressCardControlError(error)) {
        throw error;
      }
      this.controlsEnabled = false;
      return await send(this.buildCard());
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      this.syncStopRequested();
      if (this.stopRequested) {
        return;
      }
      if (this.failed) {
        return;
      }
      await task();
    });
    this.queue = run.catch((error) => {
      this.fail(error);
    });
    return run;
  }

  private async ensureStartedInternal(): Promise<void> {
    if (this.started) {
      return;
    }
    const result = await this.withCompatibleCard((card) =>
      sendCardFeishu({
        cfg: this.cfg,
        to: this.chatId,
        card,
        replyToMessageId: this.replyToMessageId,
        replyInThread: this.replyInThread,
        accountId: this.accountId,
      }),
    );
    this.messageId = result.messageId;
    this.started = true;
    this.dirty = false;
    this.lastFlushAt = Date.now();
    this.updateLifecycleRegistration();
    this.ensureBackgroundChangeSubscription();
    this.scheduleBackgroundMonitor();
    // Persist card state
    await this.persistState();
    // Ensure the stop button callback can locate the originating card message id.
    // Best-effort: the card still functions without this patch.
    try {
      this.dirty = true;
      await this.flushNowInternal();
    } catch {
      this.dirty = false;
    }
  }

  private async flushNowInternal(): Promise<void> {
    if (!this.started || !this.messageId || !this.dirty) {
      return;
    }
    const messageId = this.messageId;
    await this.withCompatibleCard((card) =>
      updateCardFeishu({
        cfg: this.cfg,
        messageId,
        card,
        accountId: this.accountId,
      }),
    );
    this.dirty = false;
    this.lastFlushAt = Date.now();
    // Persist state after update
    await this.persistState();
    // Remove persistence if terminal
    if (isTerminalStage(this.stage)) {
      await this.removePersistedState();
    }
  }

  private scheduleFlush(): void {
    if (this.stopRequested) {
      return;
    }
    if (!this.started || this.failed) {
      return;
    }
    this.dirty = true;
    if (this.flushTimer) {
      return;
    }
    const elapsed = Date.now() - this.lastFlushAt;
    const delay = Math.max(0, UPDATE_THROTTLE_MS - elapsed);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.enqueue(async () => {
        await this.flushNowInternal();
      });
    }, delay);
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) {
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async refreshBackgroundSnapshot(): Promise<boolean> {
    if (!this.backgroundMonitor) {
      this.backgroundRuns = [];
      this.totalActiveRuns = 0;
      this.totalTrackedRuns = 0;
      this.completedSuccessfulRuns = 0;
      this.completedFailedRuns = 0;
      this.latestCompletedRun = undefined;
      this.latestRequesterReply = undefined;
      this.baselineRequesterReply = undefined;
      return true;
    }
    try {
      const snapshot = await this.backgroundMonitor.getSnapshot();
      this.backgroundMonitorFailureCount = 0; // 重置失败计数
      this.backgroundRuns = snapshot?.activeRuns ?? [];
      this.totalActiveRuns = snapshot?.totalActiveRuns ?? this.backgroundRuns.length;
      this.totalTrackedRuns = Math.max(0, snapshot?.totalTrackedRuns ?? this.totalActiveRuns);
      this.completedSuccessfulRuns = Math.max(0, snapshot?.completedSuccessfulRuns ?? 0);
      this.completedFailedRuns = Math.max(0, snapshot?.completedFailedRuns ?? 0);
      this.latestCompletedRun = snapshot?.latestCompletedRun;
      this.latestRequesterReply = normalizeObservedReplyText(snapshot?.latestRequesterReply);
      this.baselineRequesterReply =
        normalizeObservedReplyText(snapshot?.baselineRequesterReply) ?? this.baselineRequesterReply;
      return true;
    } catch (error) {
      // 累计失败次数
      this.backgroundMonitorFailureCount++;

      // 连续失败超过阈值，标记为异常中断
      if (this.backgroundMonitorFailureCount >= BACKGROUND_MONITOR_MAX_FAILURES) {
        this.stopBackgroundMonitor();
        this.stopBackgroundChangeSubscription();
        this.stage = "aborted";
        this.abortMessage = "后台连接中断";
        this.updateLifecycleRegistration();
        await this.ensureStartedInternal();
        this.dirty = true;
        await this.flushNowInternal();
        return false; // 返回 false 表示已中断
      }
      // 否则保持最后可见状态，继续尝试
      return true;
    }
  }

  private hasObservedNewFinalReply(): boolean {
    if (!this.latestRequesterReply) {
      return false;
    }
    const currentPreview = normalizeObservedReplyText(this.previewText);
    const currentFinal = normalizeObservedReplyText(this.finalText);
    return (
      this.latestRequesterReply !== this.baselineRequesterReply &&
      this.latestRequesterReply !== currentPreview &&
      this.latestRequesterReply !== currentFinal
    );
  }

  private async adoptObservedFinalReply(): Promise<void> {
    if (!this.latestRequesterReply) {
      return;
    }
    this.stopBackgroundMonitor();
    this.stopBackgroundChangeSubscription();
    this.finalText = truncateText(this.latestRequesterReply, PREVIEW_LIMIT);
    this.externalFinalNotice = this.latestRequesterReply.length > PREVIEW_LIMIT;
    this.stage = "done";
    this.parentTurnCompleted = true;
    this.updateLifecycleRegistration();
    await this.ensureStartedInternal();
    this.dirty = true;
    await this.flushNowInternal();
  }

  private scheduleBackgroundMonitor(delayOverrideMs?: number): void {
    if (this.stopRequested) {
      return;
    }
    if (!this.backgroundMonitor || this.failed || !this.started || isTerminalStage(this.stage)) {
      return;
    }
    if (this.backgroundTimer) {
      if (delayOverrideMs === undefined) {
        return;
      }
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    const delay = Math.max(
      50,
      delayOverrideMs ??
        Math.max(
          1000,
          Math.floor(this.backgroundMonitor.intervalMs ?? BACKGROUND_MONITOR_INTERVAL_MS),
        ),
    );
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      void this.enqueue(async () => {
        await this.pollBackgroundMonitor();
      });
    }, delay);
    this.backgroundTimer.unref?.();
  }

  private async pollBackgroundMonitor(): Promise<void> {
    const shouldContinue = await this.refreshBackgroundSnapshot();
    if (!shouldContinue) {
      // 已标记为中断，停止后续处理
      return;
    }
    if (this.totalTrackedRuns > 0) {
      this.backgroundPhaseSeen = true;
    }
    if (this.totalActiveRuns > 0) {
      this.waitingFinalStartedAt = undefined;
      // When background work is ongoing and we already have concrete progress
      // snapshots, hide any previous inline "final" placeholder so the card
      // focuses on the latest subagent state.
      if (this.latestCompletedRun && this.parentFinalDelivery === "inline") {
        this.finalText = undefined;
      }
      // The background monitor should not spam stage flips while the parent
      // agent is actively producing output. Only override when the card is in a
      // post-turn state (or was accidentally marked done too early).
      if (
        (this.parentTurnCompleted || this.stage === "done" || this.stage === "waiting_final") &&
        this.stage !== "error"
      ) {
        this.stage = "background";
      }
      await this.ensureStartedInternal();
      this.scheduleFlush();
      this.scheduleBackgroundMonitor();
      return;
    }
    if (this.parentTurnCompleted && this.hasObservedNewFinalReply()) {
      await this.adoptObservedFinalReply();
      return;
    }
    if (this.stage === "done" || this.stage === "error" || this.stage === "aborted") {
      this.stopBackgroundMonitor();
      this.stopBackgroundChangeSubscription();
      this.updateLifecycleRegistration();
      return;
    }
    if (this.parentTurnCompleted && this.backgroundPhaseSeen) {
      if (this.parentFinalDelivery === "inline") {
        const now = Date.now();
        if (this.waitingFinalStartedAt === undefined) {
          this.waitingFinalStartedAt = now;
        }
        if (now - this.waitingFinalStartedAt > WAITING_FINAL_TIMEOUT_MS) {
          this.stopBackgroundMonitor();
          this.stopBackgroundChangeSubscription();
          if (!this.finalText?.trim()) {
            const truncatedPreview = truncateText(this.previewText, PREVIEW_LIMIT);
            this.finalText = truncatedPreview?.trim() ? truncatedPreview : NO_FINAL_TEXT_NOTICE;
          }
          this.stage = "done";
          this.updateLifecycleRegistration();
          await this.ensureStartedInternal();
          this.dirty = true;
          await this.flushNowInternal();
          return;
        }
        if (this.stage !== "waiting_final") {
          this.stage = "waiting_final";
          await this.ensureStartedInternal();
          this.dirty = true;
          await this.flushNowInternal();
        }
        this.scheduleBackgroundMonitor();
        return;
      }
      this.stopBackgroundMonitor();
      this.stopBackgroundChangeSubscription();
      if (!this.finalText?.trim()) {
        const truncatedPreview = truncateText(this.previewText, PREVIEW_LIMIT);
        this.finalText = truncatedPreview?.trim() ? truncatedPreview : NO_FINAL_TEXT_NOTICE;
      }
      this.stage = "done";
      this.updateLifecycleRegistration();
      await this.ensureStartedInternal();
      this.dirty = true;
      await this.flushNowInternal();
      return;
    }
    if (this.backgroundPhaseSeen) {
      await this.ensureStartedInternal();
      this.scheduleFlush();
      this.scheduleBackgroundMonitor();
      return;
    }
    this.stopBackgroundMonitor();
  }

  async ensureStarted(): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureStartedInternal();
    });
  }

  async noteToolStart(payload: {
    name?: string;
    phase?: string;
    toolCallId?: string;
  }): Promise<void> {
    await this.enqueue(async () => {
      const phase = payload.phase ?? "start";
      const toolName = sanitizeInlineText(payload.name) ?? "tool";
      const toolCallId = sanitizeInlineText(payload.toolCallId);
      const toolId = toolCallId ?? `${toolName}:${this.toolOrder.length}`;
      const existingId =
        toolCallId ?? (phase === "start" ? toolId : this.toolOrder[this.toolOrder.length - 1]);
      const nextId = existingId ?? toolId;
      this.tools.set(nextId, {
        id: nextId,
        name: toolName,
        toolCallId,
        status: "running",
        detail: this.tools.get(nextId)?.detail,
      });
      if (!this.toolOrder.includes(nextId)) {
        this.toolOrder.push(nextId);
      }
      this.stage = "tool";
      await this.ensureStartedInternal();
      this.scheduleFlush();
      this.scheduleBackgroundMonitor();
    });
  }

  async noteToolEvent(event: ToolLifecycleEvent): Promise<void> {
    await this.enqueue(async () => {
      const phase = event.phase ?? "";
      if (phase !== "result") {
        return;
      }
      const toolName = sanitizeInlineText(event.name) ?? "tool";
      const toolCallId = sanitizeInlineText(event.toolCallId);
      const existingId = toolCallId
        ? [...this.toolOrder]
            .reverse()
            .find((toolId) => this.tools.get(toolId)?.toolCallId === toolCallId)
        : [...this.toolOrder].reverse().find((toolId) => this.tools.get(toolId)?.name === toolName);
      const toolId = existingId ?? toolCallId ?? `${toolName}:${this.toolOrder.length}`;
      const current = this.tools.get(toolId);
      this.tools.set(toolId, {
        id: toolId,
        name: toolName,
        toolCallId: toolCallId ?? current?.toolCallId,
        status: event.isError ? "error" : "done",
        detail: sanitizeInlineText(event.meta) ?? current?.detail,
      });
      if (!this.toolOrder.includes(toolId)) {
        this.toolOrder.push(toolId);
      }
      if (this.stage !== "done" && this.stage !== "error") {
        // A failed tool step does not necessarily mean the whole workflow is over;
        // keep the card in-progress so the parent agent can recover and summarize.
        this.stage = "tool";
      }
      await this.ensureStartedInternal();
      this.scheduleFlush();
      this.scheduleBackgroundMonitor();
    });
  }

  async noteReasoning(text: string): Promise<void> {
    if (this.mode !== "tools_summary") {
      return;
    }
    await this.enqueue(async () => {
      const summary = summarizeReasoningText(text);
      if (!summary) {
        return;
      }
      this.summaryText = summary;
      if (this.stage === "pending" || this.stage === "thinking") {
        this.stage = "thinking";
      }
      await this.ensureStartedInternal();
      this.scheduleFlush();
      this.scheduleBackgroundMonitor();
    });
  }

  async noteAnswerPreview(text: string, options?: NoteAnswerPreviewOptions): Promise<void> {
    await this.enqueue(async () => {
      const mode = options?.mode ?? "snapshot";
      this.previewText =
        mode === "delta"
          ? `${this.previewText}${text}`
          : mergeStreamingText(this.previewText, text);
      this.stage = "answering";
      await this.ensureStartedInternal();
      this.scheduleFlush();
      this.scheduleBackgroundMonitor();
    });
  }

  async noteFinal(text: string): Promise<void> {
    await this.enqueue(async () => {
      const wasStarted = this.started;
      this.parentTurnCompleted = true;
      this.parentFinalDelivery = "inline";
      this.waitingFinalStartedAt = undefined;
      this.previewText = mergeStreamingText(this.previewText, text);
      this.externalFinalNotice = false;
      const shouldContinue = await this.refreshBackgroundSnapshot();
      if (!shouldContinue) {
        return;
      }
      if (this.totalTrackedRuns > 0) {
        this.backgroundPhaseSeen = true;
      }
      if (this.totalActiveRuns > 0) {
        this.finalText = text;
        this.stage = "background";
        this.clearFlushTimer();
        await this.ensureStartedInternal();
        if (wasStarted) {
          this.dirty = true;
          await this.flushNowInternal();
        }
        this.scheduleBackgroundMonitor();
        return;
      }
      this.finalText = text;
      this.stopBackgroundMonitor();
      this.stopBackgroundChangeSubscription();
      this.stage = "done";
      this.updateLifecycleRegistration();
      this.clearFlushTimer();
      await this.ensureStartedInternal();
      if (wasStarted) {
        this.dirty = true;
        await this.flushNowInternal();
      }
    });
  }

  async noteExternalFinalReference(): Promise<void> {
    await this.enqueue(async () => {
      const wasStarted = this.started;
      this.parentTurnCompleted = true;
      this.parentFinalDelivery = "external";
      this.waitingFinalStartedAt = undefined;
      this.externalFinalNotice = true;
      const shouldContinue = await this.refreshBackgroundSnapshot();
      if (!shouldContinue) {
        return;
      }
      if (this.totalTrackedRuns > 0) {
        this.backgroundPhaseSeen = true;
      }
      if (this.totalActiveRuns > 0) {
        this.stage = "background";
        this.clearFlushTimer();
        await this.ensureStartedInternal();
        if (wasStarted) {
          this.dirty = true;
          await this.flushNowInternal();
        }
        this.scheduleBackgroundMonitor();
        return;
      }
      this.stopBackgroundMonitor();
      this.stopBackgroundChangeSubscription();
      this.stage = "done";
      this.updateLifecycleRegistration();
      this.clearFlushTimer();
      await this.ensureStartedInternal();
      if (wasStarted) {
        this.dirty = true;
        await this.flushNowInternal();
      }
    });
  }

  async noteSilentFinalSkip(): Promise<void> {
    await this.enqueue(async () => {
      const wasStarted = this.started;
      this.parentTurnCompleted = true;
      this.parentFinalDelivery = "silent";
      this.externalFinalNotice = false;
      this.finalText = undefined;
      const shouldContinue = await this.refreshBackgroundSnapshot();
      if (!shouldContinue) {
        return;
      }
      if (this.totalTrackedRuns > 0) {
        this.backgroundPhaseSeen = true;
      }
      if (this.totalActiveRuns > 0) {
        this.stage = "background";
        this.clearFlushTimer();
        await this.ensureStartedInternal();
        if (wasStarted) {
          this.dirty = true;
          await this.flushNowInternal();
        }
        this.scheduleBackgroundMonitor();
        return;
      }
      this.stopBackgroundMonitor();
      this.stopBackgroundChangeSubscription();
      this.stage = "done";
      this.finalText = NO_FINAL_TEXT_NOTICE;
      this.updateLifecycleRegistration();
      this.clearFlushTimer();
      await this.ensureStartedInternal();
      if (wasStarted) {
        this.dirty = true;
        await this.flushNowInternal();
      }
    });
  }

  async noteError(message?: string): Promise<void> {
    await this.enqueue(async () => {
      this.stopBackgroundMonitor();
      this.stopBackgroundChangeSubscription();
      this.stage = "error";
      this.summaryText = summarizeReasoningText(message) ?? this.summaryText;
      this.updateLifecycleRegistration();
      if (!this.isStarted()) {
        return;
      }
      this.clearFlushTimer();
      this.dirty = true;
      await this.flushNowInternal();
    });
  }

  async noteIdle(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.isStarted()) {
        return;
      }
      if (this.stage === "done" || this.stage === "error" || this.stage === "aborted") {
        this.parentTurnCompleted = true;
        this.stopBackgroundMonitor();
        this.stopBackgroundChangeSubscription();
        this.updateLifecycleRegistration();
        return;
      }
      this.parentTurnCompleted = true;
      const shouldContinue = await this.refreshBackgroundSnapshot();
      if (!shouldContinue) {
        return;
      }
      if (this.totalTrackedRuns > 0) {
        this.backgroundPhaseSeen = true;
      }
      if (this.totalActiveRuns > 0) {
        this.waitingFinalStartedAt = undefined;
        this.stage = "background";
        this.clearFlushTimer();
        this.dirty = true;
        await this.flushNowInternal();
        this.scheduleBackgroundMonitor();
        return;
      }
      if (this.hasObservedNewFinalReply()) {
        await this.adoptObservedFinalReply();
        return;
      }
      if (this.backgroundPhaseSeen) {
        if (this.parentFinalDelivery === "inline") {
          // Background runs may finish before the parent agent emits its true summary,
          // so keep polling instead of freezing the card on an intermediate state.
          this.stage = "waiting_final";
          if (this.waitingFinalStartedAt === undefined) {
            this.waitingFinalStartedAt = Date.now();
          }
          this.clearFlushTimer();
          this.dirty = true;
          await this.flushNowInternal();
          this.scheduleBackgroundMonitor();
          return;
        }
      }
      this.stopBackgroundMonitor();
      this.stopBackgroundChangeSubscription();
      if (!this.finalText?.trim()) {
        const truncatedPreview = truncateText(this.previewText, PREVIEW_LIMIT);
        this.finalText = truncatedPreview?.trim() ? truncatedPreview : NO_FINAL_TEXT_NOTICE;
      }
      this.stage = "done";
      this.updateLifecycleRegistration();
      this.clearFlushTimer();
      this.dirty = true;
      await this.flushNowInternal();
    });
  }

  async abort(params?: { reason?: string }): Promise<void> {
    const run = this.queue.then(async () => {
      const reason =
        truncateText(sanitizeInlineText(params?.reason), PREVIEW_LIMIT) ??
        "网关或飞书通道已停止，本轮任务被中途打断，请重试。";
      this.stopRequested = true;
      this.abortMessage = reason;
      this.clearFlushTimer();
      this.stopBackgroundMonitor();
      this.stopBackgroundChangeSubscription();
      this.stage = "aborted";
      this.updateLifecycleRegistration();
      if (!this.isStarted()) {
        return;
      }
      this.dirty = true;
      await this.flushNowInternal();
    });
    this.queue = run.catch((error) => {
      this.fail(error);
    });
    await run;
  }
}
