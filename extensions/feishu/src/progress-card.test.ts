import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const updateCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  updateCardFeishu: updateCardFeishuMock,
}));

vi.mock("./streaming-card.js", () => ({
  mergeStreamingText: (previousText: string | undefined, nextText: string | undefined) => {
    const previous = typeof previousText === "string" ? previousText : "";
    const next = typeof nextText === "string" ? nextText : "";
    if (!next) {
      return previous;
    }
    if (!previous || next === previous) {
      return next;
    }
    if (next.startsWith(previous)) {
      return next;
    }
    if (previous.startsWith(next)) {
      return previous;
    }
    return `${previous}${next}`;
  },
}));

import {
  abortActiveFeishuProgressCards,
  abortFeishuProgressCardByMessageId,
  FeishuProgressCardSession,
  resetFeishuProgressCardStateForTests,
  resolveFeishuProgressCardMode,
} from "./progress-card.js";

function findStopButton(card: unknown): { tag?: string; value?: { text?: string } } | undefined {
  const body = (
    card as { body?: { elements?: Array<{ tag?: string; value?: { text?: string } }> } }
  ).body;
  return body?.elements?.find((element) => element.tag === "button");
}

describe("resolveFeishuProgressCardMode", () => {
  it("defaults to off for missing config", () => {
    expect(resolveFeishuProgressCardMode({})).toBe("off");
  });

  it("accepts explicit tools_summary mode", () => {
    expect(resolveFeishuProgressCardMode({ progressCard: { mode: "tools_summary" } })).toBe(
      "tools_summary",
    );
  });
});

describe("FeishuProgressCardSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeishuProgressCardStateForTests();
    sendCardFeishuMock.mockResolvedValue({ messageId: "om_progress", chatId: "oc_chat" });
    updateCardFeishuMock.mockResolvedValue(undefined);
  });

  it("creates a single card on tool start and patches it on final reply", async () => {
    const session = new FeishuProgressCardSession({
      cfg: {} as never,
      chatId: "oc_chat",
      mode: "tools_summary",
    });

    await session.noteToolStart({ name: "read", phase: "start" });
    await session.noteReasoning("Checking project files");
    await session.noteFinal("final answer");

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(updateCardFeishuMock).toHaveBeenCalledTimes(2);
    const patchedCard = updateCardFeishuMock.mock.calls[
      updateCardFeishuMock.mock.calls.length - 1
    ]?.[0]?.card as {
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(patchedCard.body?.elements?.[0]?.content).toContain("### 最终回复");
    expect(patchedCard.body?.elements?.[0]?.content).toContain("final answer");
    expect(patchedCard.body?.elements?.[0]?.content).toContain("已收起详细步骤");
  });

  it("shows a stop button while the run is active", async () => {
    const session = new FeishuProgressCardSession({
      cfg: {} as never,
      chatId: "oc_chat",
      chatType: "group",
      targetSessionKey: "agent:main:feishu:group:oc_chat",
      mode: "tools",
    });

    await session.noteToolStart({ name: "read", phase: "start" });

    const sentCard = sendCardFeishuMock.mock.calls[0]?.[0]?.card;
    expect(findStopButton(sentCard)).toMatchObject({
      tag: "button",
      value: {
        text: "/stop",
        command: "/stop",
        targetSessionKey: "agent:main:feishu:group:oc_chat",
        targetChatId: "oc_chat",
        targetChatType: "group",
      },
    });
  });

  it("removes the stop button after the run finishes", async () => {
    const session = new FeishuProgressCardSession({
      cfg: {} as never,
      chatId: "oc_chat",
      mode: "tools",
    });

    await session.noteToolStart({ name: "read", phase: "start" });
    await session.noteFinal("final answer");

    const patchedCard =
      updateCardFeishuMock.mock.calls[updateCardFeishuMock.mock.calls.length - 1]?.[0]?.card;
    expect(findStopButton(patchedCard)).toBeUndefined();
  });

  it("falls back to a plain progress card when controls are unsupported on first send", async () => {
    const onFailure = vi.fn();
    sendCardFeishuMock
      .mockRejectedValueOnce(new Error("Failed to create card content: unsupported tag action"))
      .mockResolvedValueOnce({ messageId: "om_progress", chatId: "oc_chat" });

    const session = new FeishuProgressCardSession({
      cfg: {} as never,
      chatId: "oc_chat",
      mode: "tools",
      onFailure,
    });

    await session.noteToolStart({ name: "read", phase: "start" });

    expect(session.isStarted()).toBe(true);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(2);
    expect(findStopButton(sendCardFeishuMock.mock.calls[0]?.[0]?.card)).toBeTruthy();
    expect(findStopButton(sendCardFeishuMock.mock.calls[1]?.[0]?.card)).toBeUndefined();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("falls back to a plain progress card when controls are unsupported on update", async () => {
    vi.useFakeTimers();
    try {
      const onFailure = vi.fn();
      updateCardFeishuMock
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          new Error("cards of schema V2 no longer support this capability: unsupported tag button"),
        )
        .mockResolvedValueOnce(undefined);

      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        mode: "tools",
        onFailure,
      });

      await session.noteToolStart({ name: "read", phase: "start" });
      await session.noteAnswerPreview("draft reply", { mode: "snapshot" });
      await vi.advanceTimersByTimeAsync(600);

      expect(updateCardFeishuMock).toHaveBeenCalledTimes(3);
      expect(findStopButton(updateCardFeishuMock.mock.calls[1]?.[0]?.card)).toBeTruthy();
      expect(findStopButton(updateCardFeishuMock.mock.calls[2]?.[0]?.card)).toBeUndefined();
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a short external-final notice when final reply is sent separately", async () => {
    const session = new FeishuProgressCardSession({
      cfg: {} as never,
      chatId: "oc_chat",
      mode: "tools",
    });

    await session.noteToolStart({ name: "exec", phase: "start" });
    await session.noteExternalFinalReference();

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(updateCardFeishuMock).toHaveBeenCalledTimes(2);
    const patchedCard = updateCardFeishuMock.mock.calls[
      updateCardFeishuMock.mock.calls.length - 1
    ]?.[0]?.card as {
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(patchedCard.body?.elements?.[0]?.content).toContain("完整回复较长");
  });

  it("matches tool results by toolCallId when the same tool runs multiple times", async () => {
    vi.useFakeTimers();
    try {
      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        mode: "tools_summary",
      });

      await session.noteToolStart({ name: "read", phase: "start", toolCallId: "call-read-1" });
      await session.noteToolStart({ name: "read", phase: "start", toolCallId: "call-read-2" });
      await session.noteToolEvent({
        phase: "result",
        name: "read",
        toolCallId: "call-read-1",
        meta: "first read done",
      });
      await vi.advanceTimersByTimeAsync(600);

      const patchedCard = updateCardFeishuMock.mock.calls[
        updateCardFeishuMock.mock.calls.length - 1
      ]?.[0]?.card as {
        body?: { elements?: Array<{ content?: string }> };
      };
      const content = patchedCard.body?.elements?.[0]?.content ?? "";
      expect(content).toContain("✅ `read`: first read done");
      expect(content).toContain("⏳ `read`");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes the preview text on idle when no final payload arrives", async () => {
    const session = new FeishuProgressCardSession({
      cfg: {} as never,
      chatId: "oc_chat",
      mode: "tools_summary",
    });

    await session.noteToolStart({ name: "read", phase: "start" });
    await session.noteAnswerPreview("partial answer", { mode: "snapshot" });
    await session.noteIdle();

    expect(updateCardFeishuMock).toHaveBeenCalledTimes(2);
    const patchedCard = updateCardFeishuMock.mock.calls[
      updateCardFeishuMock.mock.calls.length - 1
    ]?.[0]?.card as {
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(patchedCard.body?.elements?.[0]?.content).toContain("### 最终回复");
    expect(patchedCard.body?.elements?.[0]?.content).toContain("partial answer");
  });

  it("finalizes the card as done when final reply is silently skipped", async () => {
    const session = new FeishuProgressCardSession({
      cfg: {} as never,
      chatId: "oc_chat",
      mode: "tools_summary",
    });

    await session.noteToolStart({ name: "read", phase: "start" });
    await session.noteAnswerPreview("partial answer", { mode: "snapshot" });
    await session.noteSilentFinalSkip();
    await session.noteIdle();

    const patchedCard = updateCardFeishuMock.mock.calls[
      updateCardFeishuMock.mock.calls.length - 1
    ]?.[0]?.card as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 已完成");
    expect(patchedCard.body?.elements?.[0]?.content).toContain("本轮无最终文本");
    expect(patchedCard.body?.elements?.[0]?.content).not.toContain("partial answer");
  });

  it("keeps the card in-progress when a single tool step fails", async () => {
    vi.useFakeTimers();
    try {
      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        chatType: "group",
        targetSessionKey: "agent:main:feishu:group:oc_chat",
        mode: "tools_summary",
      });

      await session.noteToolStart({ name: "cron", phase: "start" });
      await session.noteToolEvent({
        phase: "result",
        name: "cron",
        isError: true,
        meta: "gateway timeout after 10000ms",
      });
      await vi.advanceTimersByTimeAsync(600);

      const patchedCard = updateCardFeishuMock.mock.calls[
        updateCardFeishuMock.mock.calls.length - 1
      ]?.[0]?.card as {
        header?: { title?: { content?: string } };
        body?: { elements?: Array<{ content?: string }> };
      };
      expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 正在处理中");
      expect(patchedCard.body?.elements?.[0]?.content).toContain(
        "❌ `cron`: gateway timeout after 10000ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates subagent progress when background runs complete", async () => {
    vi.useFakeTimers();
    try {
      const getSnapshot = vi
        .fn()
        .mockResolvedValueOnce({
          totalActiveRuns: 3,
          activeRuns: [
            { label: "researcher", elapsedMs: 1_000, timeoutSeconds: 1200 },
            { label: "skill-auditor", elapsedMs: 1_000, timeoutSeconds: 1200 },
            { label: "ops-guard", elapsedMs: 1_000, timeoutSeconds: 1200 },
          ],
          totalTrackedRuns: 3,
          completedSuccessfulRuns: 0,
          completedFailedRuns: 0,
        })
        .mockResolvedValueOnce({
          totalActiveRuns: 2,
          activeRuns: [
            { label: "skill-auditor", elapsedMs: 3_000, timeoutSeconds: 1200 },
            { label: "ops-guard", elapsedMs: 3_000, timeoutSeconds: 1200 },
          ],
          totalTrackedRuns: 3,
          completedSuccessfulRuns: 1,
          completedFailedRuns: 0,
          latestCompletedRun: {
            label: "researcher",
            status: "ok",
            summary: "筛出高质量 skills 与来源",
          },
        });

      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        chatType: "group",
        targetSessionKey: "agent:main:feishu:group:oc_chat",
        mode: "tools_summary",
        backgroundMonitor: {
          getSnapshot,
          intervalMs: 1000,
        },
      });

      await session.noteToolStart({ name: "read", phase: "start" });
      await session.noteFinal("进度 20%：已派发 3 个子任务");
      await vi.advanceTimersByTimeAsync(1600);

      const patchedCard = updateCardFeishuMock.mock.calls[
        updateCardFeishuMock.mock.calls.length - 1
      ]?.[0]?.card as {
        body?: { elements?: Array<{ content?: string }> };
      };
      expect(patchedCard.body?.elements?.[0]?.content).toContain("已完成 1/3 个子任务");
      expect(patchedCard.body?.elements?.[0]?.content).toContain("最近完成：`researcher`");
      expect(patchedCard.body?.elements?.[0]?.content).not.toContain("进度 20%");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks active cards as aborted when the channel stops", async () => {
    const session = new FeishuProgressCardSession({
      cfg: {} as never,
      chatId: "oc_chat",
      accountId: "main",
      mode: "tools_summary",
    });

    await session.noteToolStart({ name: "read", phase: "start" });
    await abortActiveFeishuProgressCards({
      accountId: "main",
      reason: "网关正在重启，本轮任务被中途打断，请重试。",
    });

    const patchedCard = updateCardFeishuMock.mock.calls[
      updateCardFeishuMock.mock.calls.length - 1
    ]?.[0]?.card as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 已中断");
    expect(patchedCard.body?.elements?.[0]?.content).toContain("任务已中断");
    expect(patchedCard.body?.elements?.[0]?.content).toContain("网关正在重启");
    expect(findStopButton(patchedCard)).toBeUndefined();
  });

  it("marks the matching card as aborted after a stop button request is processed", async () => {
    const session = new FeishuProgressCardSession({
      cfg: {} as never,
      chatId: "oc_chat",
      accountId: "main",
      mode: "tools_summary",
    });

    await session.noteToolStart({ name: "read", phase: "start" });

    const aborted = await abortFeishuProgressCardByMessageId({
      messageId: "om_progress",
      accountId: "main",
    });

    expect(aborted).toBe(true);
    const patchedCard = updateCardFeishuMock.mock.calls[
      updateCardFeishuMock.mock.calls.length - 1
    ]?.[0]?.card as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 已中断");
    expect(patchedCard.body?.elements?.[0]?.content).toContain("已收到停止指令");
    expect(findStopButton(patchedCard)).toBeUndefined();
  });

  it("marks the card done when a new final reply appears after background work settles", async () => {
    vi.useFakeTimers();
    try {
      const getSnapshot = vi
        .fn()
        .mockResolvedValueOnce({
          totalActiveRuns: 3,
          activeRuns: [
            { label: "researcher", elapsedMs: 1_000, timeoutSeconds: 1200 },
            { label: "skill-auditor", elapsedMs: 1_000, timeoutSeconds: 1200 },
            { label: "ops-guard", elapsedMs: 1_000, timeoutSeconds: 1200 },
          ],
          totalTrackedRuns: 3,
          completedSuccessfulRuns: 0,
          completedFailedRuns: 0,
        })
        .mockResolvedValueOnce({
          totalActiveRuns: 0,
          activeRuns: [],
          totalTrackedRuns: 3,
          completedSuccessfulRuns: 3,
          completedFailedRuns: 0,
          latestCompletedRun: {
            label: "researcher",
            status: "ok",
            summary: "最终一份研究也已回传",
          },
          latestRequesterReply: "最终结论：优先关注 Feishu 办公流、研究型工作流和浏览器自动化。",
        });

      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        mode: "tools_summary",
        backgroundMonitor: {
          getSnapshot,
          intervalMs: 1000,
        },
      });

      await session.noteToolStart({ name: "read", phase: "start" });
      await session.noteFinal("进度 20%：已派发 3 个子任务");
      await vi.advanceTimersByTimeAsync(1600);

      const patchedCard = updateCardFeishuMock.mock.calls[
        updateCardFeishuMock.mock.calls.length - 1
      ]?.[0]?.card as {
        header?: { title?: { content?: string } };
        body?: { elements?: Array<{ content?: string }> };
      };
      expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 已完成");
      expect(patchedCard.body?.elements?.[0]?.content).toContain(
        "最终结论：优先关注 Feishu 办公流",
      );
      expect(patchedCard.body?.elements?.[0]?.content).not.toContain("等待最终汇总");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes background progress immediately when subagent state changes", async () => {
    vi.useFakeTimers();
    try {
      let triggerBackgroundChange: (() => void) | undefined;
      const getSnapshot = vi
        .fn()
        .mockResolvedValueOnce({
          totalActiveRuns: 2,
          activeRuns: [
            { label: "researcher", elapsedMs: 1_000, timeoutSeconds: 1200 },
            { label: "ops-guard", elapsedMs: 1_000, timeoutSeconds: 1200 },
          ],
          totalTrackedRuns: 2,
          completedSuccessfulRuns: 0,
          completedFailedRuns: 0,
        })
        .mockResolvedValueOnce({
          totalActiveRuns: 1,
          activeRuns: [{ label: "ops-guard", elapsedMs: 2_000, timeoutSeconds: 1200 }],
          totalTrackedRuns: 2,
          completedSuccessfulRuns: 1,
          completedFailedRuns: 0,
          latestCompletedRun: {
            label: "researcher",
            status: "ok",
            summary: "研究结果已回传",
          },
        });

      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        mode: "tools_summary",
        backgroundMonitor: {
          getSnapshot,
          intervalMs: 4000,
        },
        backgroundChangeSubscribe: (listener) => {
          triggerBackgroundChange = listener;
          return () => {
            triggerBackgroundChange = undefined;
          };
        },
      });

      await session.noteToolStart({ name: "read", phase: "start" });
      await session.noteFinal("进度 20%：已派发 2 个子任务");
      triggerBackgroundChange?.();
      await vi.advanceTimersByTimeAsync(700);

      const patchedCard = updateCardFeishuMock.mock.calls[
        updateCardFeishuMock.mock.calls.length - 1
      ]?.[0]?.card as {
        body?: { elements?: Array<{ content?: string }> };
      };
      expect(patchedCard.body?.elements?.[0]?.content).toContain("已完成 1/2 个子任务");
      expect(patchedCard.body?.elements?.[0]?.content).toContain("最近完成：`researcher`");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling after idle while waiting for the true final summary", async () => {
    vi.useFakeTimers();
    try {
      const getSnapshot = vi
        .fn()
        .mockResolvedValueOnce({
          totalActiveRuns: 2,
          activeRuns: [
            { label: "researcher", elapsedMs: 1_000, timeoutSeconds: 1200 },
            { label: "ops-guard", elapsedMs: 1_000, timeoutSeconds: 1200 },
          ],
          totalTrackedRuns: 2,
          completedSuccessfulRuns: 0,
          completedFailedRuns: 0,
        })
        .mockResolvedValueOnce({
          totalActiveRuns: 0,
          activeRuns: [],
          totalTrackedRuns: 2,
          completedSuccessfulRuns: 2,
          completedFailedRuns: 0,
          latestCompletedRun: {
            label: "researcher",
            status: "ok",
            summary: "阶段研究已交回",
          },
        })
        .mockResolvedValueOnce({
          totalActiveRuns: 0,
          activeRuns: [],
          totalTrackedRuns: 2,
          completedSuccessfulRuns: 2,
          completedFailedRuns: 0,
          latestCompletedRun: {
            label: "researcher",
            status: "ok",
            summary: "阶段研究已交回",
          },
          latestRequesterReply: "最终结论：先收口 Feishu 交互，再补运行态治理。",
        });

      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        mode: "tools_summary",
        backgroundMonitor: {
          getSnapshot,
          intervalMs: 1000,
        },
      });

      await session.noteToolStart({ name: "read", phase: "start" });
      await session.noteFinal("进度 20%：已派发 2 个子任务");
      await session.noteIdle();
      await vi.advanceTimersByTimeAsync(1600);

      const patchedCard = updateCardFeishuMock.mock.calls[
        updateCardFeishuMock.mock.calls.length - 1
      ]?.[0]?.card as {
        header?: { title?: { content?: string } };
        body?: { elements?: Array<{ content?: string }> };
      };
      expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 已完成");
      expect(patchedCard.body?.elements?.[0]?.content).toContain("最终结论：先收口 Feishu 交互");
      expect(patchedCard.body?.elements?.[0]?.content).not.toContain("等待最终汇总");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat mixed NO_REPLY progress text as the final requester reply", async () => {
    vi.useFakeTimers();
    try {
      const getSnapshot = vi
        .fn()
        .mockResolvedValueOnce({
          totalActiveRuns: 1,
          activeRuns: [{ label: "researcher", elapsedMs: 1_000, timeoutSeconds: 1200 }],
          totalTrackedRuns: 1,
          completedSuccessfulRuns: 0,
          completedFailedRuns: 0,
        })
        .mockResolvedValueOnce({
          totalActiveRuns: 0,
          activeRuns: [],
          totalTrackedRuns: 1,
          completedSuccessfulRuns: 1,
          completedFailedRuns: 0,
          latestCompletedRun: {
            label: "researcher",
            status: "ok",
            summary: "阶段研究已交回",
          },
          latestRequesterReply: "进度 20%：已派发 1 个子任务 NO_REPLY",
        });

      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        chatType: "group",
        targetSessionKey: "agent:main:feishu:group:oc_chat",
        mode: "tools_summary",
        backgroundMonitor: {
          getSnapshot,
          intervalMs: 1000,
        },
      });

      await session.noteToolStart({ name: "read", phase: "start" });
      await session.noteFinal("进度 20%：已派发 1 个子任务");
      await session.noteIdle();
      await vi.advanceTimersByTimeAsync(1600);

      const patchedCard = updateCardFeishuMock.mock.calls[
        updateCardFeishuMock.mock.calls.length - 1
      ]?.[0]?.card as {
        header?: { title?: { content?: string } };
        body?: { elements?: Array<{ content?: string }> };
      };
      expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 等待最终汇总");
      expect(patchedCard.body?.elements?.[0]?.content).toContain("等待最终汇总");
      expect(patchedCard.body?.elements?.[0]?.content).not.toContain("### 最终回复");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the stop button while waiting for the final summary", async () => {
    vi.useFakeTimers();
    try {
      const getSnapshot = vi
        .fn()
        .mockResolvedValueOnce({
          totalActiveRuns: 1,
          activeRuns: [{ label: "researcher", elapsedMs: 1_000, timeoutSeconds: 1200 }],
          totalTrackedRuns: 1,
          completedSuccessfulRuns: 0,
          completedFailedRuns: 0,
        })
        .mockResolvedValueOnce({
          totalActiveRuns: 0,
          activeRuns: [],
          totalTrackedRuns: 1,
          completedSuccessfulRuns: 1,
          completedFailedRuns: 0,
        });

      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        chatType: "group",
        targetSessionKey: "agent:main:feishu:group:oc_chat",
        mode: "tools_summary",
        backgroundMonitor: {
          getSnapshot,
          intervalMs: 1000,
        },
      });

      await session.noteToolStart({ name: "read", phase: "start" });
      await session.noteFinal("进度 20%：已派发 1 个子任务");
      await session.noteIdle();

      const patchedCard =
        updateCardFeishuMock.mock.calls[updateCardFeishuMock.mock.calls.length - 1]?.[0]?.card;
      expect(findStopButton(patchedCard)).toMatchObject({
        tag: "button",
        value: {
          text: "/stop",
          command: "/stop",
          targetSessionKey: "agent:main:feishu:group:oc_chat",
          targetChatId: "oc_chat",
          targetChatType: "group",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks card as aborted after consecutive monitor failures", async () => {
    vi.useFakeTimers();
    try {
      const getSnapshot = vi
        .fn()
        .mockResolvedValueOnce({
          totalActiveRuns: 1,
          activeRuns: [{ label: "researcher", elapsedMs: 1_000, timeoutSeconds: 1200 }],
          totalTrackedRuns: 1,
          completedSuccessfulRuns: 0,
          completedFailedRuns: 0,
        })
        .mockRejectedValueOnce(new Error("Connection timeout"))
        .mockRejectedValueOnce(new Error("Connection timeout"))
        .mockRejectedValueOnce(new Error("Connection timeout"));

      const session = new FeishuProgressCardSession({
        cfg: {} as never,
        chatId: "oc_chat",
        chatType: "group",
        targetSessionKey: "agent:main:feishu:group:oc_chat",
        mode: "tools_summary",
        backgroundMonitor: {
          getSnapshot,
          intervalMs: 1000,
        },
      });

      await session.noteToolStart({ name: "read", phase: "start" });
      await session.noteFinal("进度 20%：已派发 1 个子任务");
      await session.noteIdle();

      // 第一次轮询成功，显示后台任务
      await vi.advanceTimersByTimeAsync(1000);

      // 后续3次轮询失败
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      const patchedCard =
        updateCardFeishuMock.mock.calls[updateCardFeishuMock.mock.calls.length - 1]?.[0]?.card;
      const markdown = (
        patchedCard as { body?: { elements?: Array<{ tag?: string; content?: string }> } }
      ).body?.elements?.find((el) => el.tag === "markdown")?.content;

      expect(markdown).toContain("后台连接中断");
      expect(getSnapshot).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("progress card persistence and recovery", () => {
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
});
