import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/feishu";
import { onSubagentRegistryChange } from "../../../src/agents/subagent-registry-runtime.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { FeishuProgressCardSession, resolveFeishuProgressCardMode } from "./progress-card.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;
const BACKGROUND_SNAPSHOT_RUN_LIMIT = 3;
const BACKGROUND_ACTIVITY_TEXT_LIMIT = 160;

function summarizeBackgroundActivity(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text
    .replace(/```[\s\S]*?```/g, "[代码块]")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= BACKGROUND_ACTIVITY_TEXT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, BACKGROUND_ACTIVITY_TEXT_LIMIT - 1).trimEnd()}…`;
}

function resolveBackgroundRunLabel(label: string | undefined, childSessionKey: string): string {
  const normalizedLabel = label?.trim();
  if (normalizedLabel) {
    return normalizedLabel;
  }
  const tail = childSessionKey.split(":").pop()?.trim();
  return tail ? `subagent:${tail}` : "subagent";
}

function resolveCompletedRunStatus(
  outcome: { status?: unknown; error?: unknown } | undefined,
): "ok" | "timeout" | "error" | "unknown" {
  if (outcome?.status === "ok") {
    return "ok";
  }
  if (outcome?.status === "timeout") {
    return "timeout";
  }
  if (outcome?.status === "error") {
    return "error";
  }
  return "unknown";
}

function summarizeCompletedRunResult(params: {
  status: "ok" | "timeout" | "error" | "unknown";
  summary?: string;
  error?: unknown;
}): string | undefined {
  if (params.summary) {
    return params.summary;
  }
  if (params.status === "timeout") {
    return "子任务超时结束";
  }
  if (params.status === "error") {
    return typeof params.error === "string" && params.error.trim()
      ? summarizeBackgroundActivity(params.error)
      : "子任务失败结束";
  }
  if (params.status === "unknown") {
    return "子任务已结束";
  }
  return undefined;
}

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  chatType?: "group" | "p2p";
  sessionKey?: string;
  /** Per-turn run id (used to scope subagent workflow tracking). */
  runId?: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  threadId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    chatType,
    replyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    threadReply,
    rootId,
    threadId,
    mentionTargets,
    accountId,
    sessionKey,
    runId,
  } = params;
  const workflowId = typeof runId === "string" && runId.trim() ? runId.trim() : undefined;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // Check if typing indicator is enabled (default: true)
      if (!(account.config.typingIndicator ?? true)) {
        return;
      }
      if (!replyToMessageId) {
        return;
      }
      // Skip typing indicator for old messages — likely replays after context
      // compaction that would flood users with stale notifications (#30418).
      const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
      if (
        messageCreateTimeMs !== undefined &&
        Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
      ) {
        return;
      }
      // Feishu reactions persist until explicitly removed, so skip keepalive
      // re-adds when a reaction already exists. Re-adding the same emoji
      // triggers a new push notification for every call (#28660).
      if (typingState?.reactionId) {
        return;
      }
      typingState = await addTypingIndicator({
        cfg,
        messageId: replyToMessageId,
        accountId,
        runtime: params.runtime,
      });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId, runtime: params.runtime });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  const progressCardMode = resolveFeishuProgressCardMode(account.config);
  const progressCardEnabled = renderMode !== "raw" && progressCardMode !== "off";
  const progressCardFinalInlineLimit = Math.min(textChunkLimit, 3200);
  // Card streaming may miss thread affinity in topic contexts; use direct replies there.
  const streamingEnabled =
    !progressCardEnabled &&
    !threadReplyMode &&
    account.config?.streaming !== false &&
    renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  const deliveredFinalTexts = new Set<string>();
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  let progressCardFailed = false;
  type StreamTextUpdateMode = "snapshot" | "delta";

  const markProgressCardFailure = (error: unknown) => {
    progressCardFailed = true;
    params.runtime.error?.(`feishu[${account.accountId}] progress card failed: ${String(error)}`);
  };

  const backgroundBaselineRunIds =
    progressCardEnabled && sessionKey && !workflowId
      ? new Set(
          core.channel.session.listSubagentRunsForRequester(sessionKey).map((entry) => entry.runId),
        )
      : new Set<string>();
  const completedRunSummaryCache = new Map<string, string | undefined>();
  const requesterReplyBaselinePromise =
    progressCardEnabled && sessionKey
      ? core.channel.session.readLatestAssistantReply({
          sessionKey,
          limit: 12,
        })
      : undefined;

  const backgroundMonitor =
    progressCardEnabled && sessionKey
      ? {
          intervalMs: 4000,
          getSnapshot: async () => {
            const trackedSubagentRunsRaw =
              core.channel.session.listSubagentRunsForRequester(sessionKey);
            const trackedSubagentRuns = workflowId
              ? trackedSubagentRunsRaw.filter((entry) => entry.workflowId === workflowId)
              : trackedSubagentRunsRaw.filter(
                  (entry) => !backgroundBaselineRunIds.has(entry.runId),
                );
            const pendingDescendantCache = new Map<string, boolean>();
            const hasPendingDescendants = (childSessionKey: string) => {
              if (pendingDescendantCache.has(childSessionKey)) {
                return pendingDescendantCache.get(childSessionKey) === true;
              }
              const pending = core.channel.session.countPendingDescendantRuns(childSessionKey) > 0;
              pendingDescendantCache.set(childSessionKey, pending);
              return pending;
            };
            const activeSubagentRuns = trackedSubagentRuns.filter(
              (entry) => !entry.endedAt || hasPendingDescendants(entry.childSessionKey),
            );
            const endedSubagentRuns = trackedSubagentRuns.filter(
              (entry) =>
                typeof entry.endedAt === "number" && !hasPendingDescendants(entry.childSessionKey),
            );
            const visibleActiveSubagentRuns = activeSubagentRuns
              .slice()
              .sort(
                (left, right) =>
                  (left.startedAt ?? left.createdAt ?? Number.MAX_SAFE_INTEGER) -
                  (right.startedAt ?? right.createdAt ?? Number.MAX_SAFE_INTEGER),
              )
              .slice(0, BACKGROUND_SNAPSHOT_RUN_LIMIT);
            const successfulCompletedRuns = endedSubagentRuns.filter(
              (entry) => resolveCompletedRunStatus(entry.outcome) === "ok",
            ).length;
            const failedCompletedRuns = Math.max(
              0,
              endedSubagentRuns.length - successfulCompletedRuns,
            );
            const subagentSnapshots = await Promise.all(
              visibleActiveSubagentRuns.map(async (entry) => ({
                label: resolveBackgroundRunLabel(entry.label, entry.childSessionKey),
                startedAt: entry.startedAt ?? entry.createdAt,
                timeoutSeconds: entry.runTimeoutSeconds,
                latestActivity: summarizeBackgroundActivity(
                  await core.channel.session.readLatestAssistantReply({
                    sessionKey: entry.childSessionKey,
                    limit: 12,
                  }),
                ),
              })),
            );
            const combinedSnapshots = subagentSnapshots.map((entry) => ({
              label: entry.label,
              elapsedMs:
                typeof entry.startedAt === "number"
                  ? Math.max(0, Date.now() - entry.startedAt)
                  : undefined,
              timeoutSeconds: entry.timeoutSeconds,
              latestActivity: entry.latestActivity,
            }));
            const latestCompletedEntry = endedSubagentRuns
              .slice()
              .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0))[0];
            let latestCompletedRun:
              | {
                  label: string;
                  status: "ok" | "timeout" | "error" | "unknown";
                  summary?: string;
                }
              | undefined;
            if (latestCompletedEntry) {
              const status = resolveCompletedRunStatus(latestCompletedEntry.outcome);
              let cachedSummary = completedRunSummaryCache.get(latestCompletedEntry.runId);
              if (cachedSummary === undefined && status === "ok") {
                cachedSummary = summarizeBackgroundActivity(
                  await core.channel.session.readLatestAssistantReply({
                    sessionKey: latestCompletedEntry.childSessionKey,
                    limit: 12,
                  }),
                );
                completedRunSummaryCache.set(latestCompletedEntry.runId, cachedSummary);
              }
              latestCompletedRun = {
                label: resolveBackgroundRunLabel(
                  latestCompletedEntry.label,
                  latestCompletedEntry.childSessionKey,
                ),
                status,
                summary: summarizeCompletedRunResult({
                  status,
                  summary: cachedSummary,
                  error: latestCompletedEntry.outcome?.error,
                }),
              };
            }
            return {
              totalActiveRuns: activeSubagentRuns.length,
              activeRuns: combinedSnapshots,
              totalTrackedRuns: trackedSubagentRuns.length,
              completedSuccessfulRuns: successfulCompletedRuns,
              completedFailedRuns: failedCompletedRuns,
              latestCompletedRun,
              latestRequesterReply: await core.channel.session.readLatestAssistantReply({
                sessionKey,
                limit: 12,
              }),
              baselineRequesterReply: requesterReplyBaselinePromise
                ? await requesterReplyBaselinePromise
                : undefined,
            };
          },
        }
      : undefined;

  const progressCard = progressCardEnabled
    ? new FeishuProgressCardSession({
        cfg,
        chatId,
        chatType,
        targetSessionKey: sessionKey,
        accountId,
        replyToMessageId: sendReplyToMessageId,
        replyInThread: effectiveReplyInThread,
        rootId,
        threadId,
        mentionTargets,
        mode: progressCardMode,
        onFailure: markProgressCardFailure,
        backgroundMonitor,
        backgroundChangeSubscribe: backgroundMonitor
          ? (listener) => onSubagentRegistryChange(listener)
          : undefined,
      })
    : null;

  const runProgressCard = async <T>(
    fn: (card: FeishuProgressCardSession) => Promise<T>,
  ): Promise<T | undefined> => {
    if (!progressCard || progressCardFailed) {
      return undefined;
    }
    try {
      return await fn(progressCard);
    } catch (error) {
      markProgressCardFailure(error);
      return undefined;
    }
  };

  const sendMediaList = async (mediaList: string[]) => {
    for (const mediaUrl of mediaList) {
      await sendMediaFeishu({
        cfg,
        to: chatId,
        mediaUrl,
        replyToMessageId: sendReplyToMessageId,
        replyInThread: effectiveReplyInThread,
        accountId,
      });
    }
  };

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
      mode?: StreamTextUpdateMode;
    },
  ) => {
    if (!nextText) {
      return;
    }
    if (options?.dedupeWithLastPartial && nextText === lastPartial) {
      return;
    }
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    const mode = options?.mode ?? "snapshot";
    streamText =
      mode === "delta" ? `${streamText}${nextText}` : mergeStreamingText(streamText, nextText);
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        await streaming.update(streamText);
      }
    });
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
        });
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = streamText;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      await streaming.close(text);
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        deliveredFinalTexts.clear();
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        const mediaList =
          payload.mediaUrls && payload.mediaUrls.length > 0
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
        const hasText = Boolean(text.trim());
        const hasMedia = mediaList.length > 0;
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText && !hasMedia) {
          return;
        }

        if (progressCardEnabled && shouldDeliverText) {
          if (info?.kind === "block") {
            const handledBlock = await runProgressCard(async (card) => {
              await card.noteAnswerPreview(text, { mode: "delta" });
              return true;
            });
            if (handledBlock) {
              if (hasMedia) {
                await sendMediaList(mediaList);
              }
              return;
            }
          }

          if (progressCard?.isStarted() && info?.kind === "final") {
            if (text.length <= progressCardFinalInlineLimit) {
              const handledFinal = await runProgressCard(async (card) => {
                await card.noteFinal(text);
                return true;
              });
              if (handledFinal) {
                deliveredFinalTexts.add(text);
                if (hasMedia) {
                  await sendMediaList(mediaList);
                }
                return;
              }
            } else {
              await runProgressCard(async (card) => {
                await card.noteExternalFinalReference();
                return true;
              });
            }
          }
        }

        if (shouldDeliverText) {
          const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

          if (info?.kind === "block") {
            // Drop internal block chunks unless we can safely consume them as
            // streaming-card fallback content.
            if (!(streamingEnabled && useCard)) {
              return;
            }
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (info?.kind === "final" && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              // Some runtimes emit block payloads without onPartial/final callbacks.
              // Mirror block text into streamText so onIdle close still sends content.
              queueStreamingUpdate(text, { mode: "delta" });
            }
            if (info?.kind === "final") {
              streamText = mergeStreamingText(streamText, text);
              await closeStreaming();
              deliveredFinalTexts.add(text);
            }
            // Send media even when streaming handled the text
            if (hasMedia) {
              await sendMediaList(mediaList);
            }
            return;
          }

          let first = true;
          if (useCard) {
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode,
            )) {
              await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
            if (info?.kind === "final") {
              deliveredFinalTexts.add(text);
            }
          } else {
            const converted = core.channel.text.convertMarkdownTables(text, tableMode);
            for (const chunk of core.channel.text.chunkTextWithMode(
              converted,
              textChunkLimit,
              chunkMode,
            )) {
              await sendMessageFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
            if (info?.kind === "final") {
              deliveredFinalTexts.add(text);
            }
          }
        }

        if (hasMedia) {
          await sendMediaList(mediaList);
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await runProgressCard(async (card) => {
          await card.noteError(String(error));
        });
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onSkip: async (_payload, info) => {
        if (info.kind !== "final" || info.reason !== "silent") {
          return;
        }
        await runProgressCard(async (card) => {
          await card.noteSilentFinalSkip();
        });
      },
      onIdle: async () => {
        await runProgressCard(async (card) => {
          await card.noteIdle();
        });
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      ...(workflowId ? { runId: workflowId } : {}),
      onPartialReply: progressCardEnabled
        ? async (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            await runProgressCard(async (card) => {
              await card.noteAnswerPreview(payload.text!, {
                mode: "snapshot",
              });
            });
          }
        : streamingEnabled
          ? (payload: ReplyPayload) => {
              if (!payload.text) {
                return;
              }
              queueStreamingUpdate(payload.text, {
                dedupeWithLastPartial: true,
                mode: "snapshot",
              });
            }
          : undefined,
      onReasoningStream:
        progressCardMode === "tools_summary"
          ? async (payload: ReplyPayload) => {
              if (!payload.text) {
                return;
              }
              await runProgressCard(async (card) => {
                await card.noteReasoning(payload.text!);
              });
            }
          : undefined,
      onToolStart: progressCardEnabled
        ? async (payload: { name?: string; phase?: string; toolCallId?: string }) => {
            await runProgressCard(async (card) => {
              await card.noteToolStart(payload);
            });
          }
        : undefined,
      onAgentEvent: progressCardEnabled
        ? async (evt: { stream: string; data: Record<string, unknown> }) => {
            if (evt.stream === "tool") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : undefined;
              if (phase === "start" || phase === "update") {
                return;
              }
              await runProgressCard(async (card) => {
                await card.noteToolEvent({
                  phase,
                  name: typeof evt.data.name === "string" ? evt.data.name : undefined,
                  toolCallId:
                    typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : undefined,
                  meta: typeof evt.data.meta === "string" ? evt.data.meta : undefined,
                  isError: evt.data.isError === true,
                });
              });
              return;
            }
            if (evt.stream === "lifecycle") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : undefined;
              if (phase !== "error") {
                return;
              }
              const errorText = typeof evt.data.error === "string" ? evt.data.error : undefined;
              await runProgressCard(async (card) => {
                await card.noteError(errorText);
              });
            }
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
