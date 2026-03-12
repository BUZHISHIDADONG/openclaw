import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const updateCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const addTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "om_msg" })));
const removeTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => {}));
const streamingInstances = vi.hoisted(() => [] as any[]);

vi.mock("./accounts.js", () => ({ resolveFeishuAccount: resolveFeishuAccountMock }));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
  updateCardFeishu: updateCardFeishuMock,
}));
vi.mock("./media.js", () => ({ sendMediaFeishu: sendMediaFeishuMock }));
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", () => ({ resolveReceiveIdType: resolveReceiveIdTypeMock }));
vi.mock("./typing.js", () => ({
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
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
  FeishuStreamingSession: class {
    active = false;
    start = vi.fn(async () => {
      this.active = true;
    });
    update = vi.fn(async () => {});
    close = vi.fn(async () => {
      this.active = false;
    });
    isActive = vi.fn(() => this.active);

    constructor() {
      streamingInstances.push(this);
    }
  },
}));

import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";

describe("createFeishuReplyDispatcher streaming behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamingInstances.length = 0;
    sendMediaFeishuMock.mockResolvedValue(undefined);
    sendCardFeishuMock.mockResolvedValue({ messageId: "om_progress", chatId: "oc_chat" });
    updateCardFeishuMock.mockResolvedValue(undefined);

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
      },
    });

    resolveReceiveIdTypeMock.mockReturnValue("chat_id");
    createFeishuClientMock.mockReturnValue({});

    createReplyDispatcherWithTypingMock.mockImplementation((opts) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _opts: opts,
    }));

    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text) => text),
          chunkTextWithMode: vi.fn((text) => [text]),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
        session: {
          countActiveSubagentRuns: vi.fn(() => 0),
          listSubagentRunsForRequester: vi.fn(() => []),
          readLatestAssistantReply: vi.fn(async () => undefined),
        },
      },
    });
  });

  it("skips typing indicator when account typingIndicator is disabled", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        typingIndicator: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("skips typing indicator for stale replayed messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 3 * 60_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("treats second-based timestamps as stale for typing suppression", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Math.floor((Date.now() - 3 * 60_000) / 1000),
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("keeps typing indicator for fresh messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 30_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).toHaveBeenCalledTimes(1);
    expect(addTypingIndicatorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_parent",
      }),
    );
  });

  it("keeps auto mode plain text on non-streaming send path", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps raw render mode on pure text even when progressCard is enabled", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "raw",
        streaming: false,
        progressCard: {
          mode: "tools_summary",
        },
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      sessionKey: "agent:main:feishu:p2p:oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain raw text" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "plain raw text",
      }),
    );
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(updateCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("suppresses internal block payload delivery", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "internal reasoning chunk" }, { kind: "block" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("uses streaming session for auto mode markdown payloads", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      rootId: "om_root_topic",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith("oc_chat", "chat_id", {
      replyToMessageId: undefined,
      replyInThread: undefined,
      rootId: "om_root_topic",
    });
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("closes streaming with block text when final reply is missing", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\npartial answer\n```" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\npartial answer\n```");
  });

  it("delivers distinct final payloads after streaming close", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\n完整回复第一段\n```" }, { kind: "final" });
    await options.deliver({ text: "```md\n完整回复第一段 + 第二段\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(2);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\n完整回复第一段\n```");
    expect(streamingInstances[1].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[1].close).toHaveBeenCalledWith("```md\n完整回复第一段 + 第二段\n```");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("skips exact duplicate final text after streaming close", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\n同一条回复\n```");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });
  it("suppresses duplicate final text while still sending media", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain final" }, { kind: "final" });
    await options.deliver(
      { text: "plain final", mediaUrl: "https://example.com/a.png" },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "plain final",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("keeps distinct non-streaming final payloads", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "notice header" }, { kind: "final" });
    await options.deliver({ text: "actual answer body" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "notice header" }),
    );
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "actual answer body" }),
    );
  });

  it("treats block updates as delta chunks", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    await result.replyOptions.onPartialReply?.({ text: "hello" });
    await options.deliver({ text: "lo world" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("hellolo world");
  });

  it("sends media-only payloads as attachments", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "oc_chat",
        mediaUrl: "https://example.com/a.png",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to legacy mediaUrl when mediaUrls is an empty array", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      { text: "caption", mediaUrl: "https://example.com/a.png", mediaUrls: [] },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("sends attachments after streaming final markdown replies", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      { text: "```ts\nconst x = 1\n```", mediaUrls: ["https://example.com/a.png"] },
      { kind: "final" },
    );

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("passes replyInThread to sendMessageFeishu for plain text", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyInThread to sendMarkdownCardFeishu for card text", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "card text" }, { kind: "final" });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyToMessageId and replyInThread to streaming.start()", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith("oc_chat", "chat_id", {
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
  });

  it("disables streaming for thread replies and keeps reply metadata", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyInThread to media attachments", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("updates a single progress card from tool events and final reply", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        progressCard: { mode: "tools_summary" },
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await result.replyOptions.onToolStart?.({ name: "read", phase: "start" });
    await result.replyOptions.onReasoningStream?.({ text: "Checking related files" });
    await result.replyOptions.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "result",
        name: "read",
        meta: "src/index.ts",
        isError: false,
      },
    });
    await options.deliver({ text: "final answer" }, { kind: "final" });

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(updateCardFeishuMock).toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps progress-card delivery when controls are rejected once by Feishu", async () => {
    sendCardFeishuMock
      .mockRejectedValueOnce(new Error("Failed to create card content: unsupported tag button"))
      .mockResolvedValueOnce({ messageId: "om_progress", chatId: "oc_chat" });

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        progressCard: { mode: "tools_summary" },
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await result.replyOptions.onToolStart?.({ name: "read", phase: "start" });
    await result.replyOptions.onReasoningStream?.({ text: "Checking related files" });
    await options.deliver({ text: "final answer" }, { kind: "final" });

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(2);
    expect(updateCardFeishuMock).toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to normal final send when progress-card final text is too long", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        progressCard: { mode: "tools" },
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await result.replyOptions.onToolStart?.({ name: "exec", phase: "start" });
    await options.deliver({ text: "x".repeat(4001) }, { kind: "final" });

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(updateCardFeishuMock).toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("starts a progress card from partial-only text updates", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        progressCard: { mode: "tools_summary" },
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await result.replyOptions.onPartialReply?.({ text: "partial answer only" });

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(updateCardFeishuMock).toHaveBeenCalled();
    const patchedCard =
      updateCardFeishuMock.mock.calls[updateCardFeishuMock.mock.calls.length - 1]?.[0]?.card;
    expect(JSON.stringify(patchedCard)).toContain("partial answer only");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("marks the progress card as done when a final reply is silently skipped", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        progressCard: { mode: "tools_summary" },
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await result.replyOptions.onToolStart?.({ name: "read", phase: "start" });
    await result.replyOptions.onPartialReply?.({ text: "partial answer" });
    await options.onSkip?.({ text: "NO_REPLY" }, { kind: "final", reason: "silent" });
    await options.onIdle?.();

    const patchedCard = updateCardFeishuMock.mock.calls[
      updateCardFeishuMock.mock.calls.length - 1
    ]?.[0]?.card as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 已完成");
    expect(patchedCard.body?.elements?.[0]?.content).toContain("本轮无最终文本");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("lets a later final summary override a failed tool step", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        progressCard: { mode: "tools_summary" },
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await result.replyOptions.onToolStart?.({ name: "cron", phase: "start" });
    await result.replyOptions.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "result",
        name: "cron",
        meta: "gateway timeout after 10000ms",
        isError: true,
      },
    });
    await result.replyOptions.onPartialReply?.({ text: "我继续盯着这次运行。" });
    await options.deliver({ text: "最终汇总：任务已继续完成。" }, { kind: "final" });

    const patchedCard = updateCardFeishuMock.mock.calls[
      updateCardFeishuMock.mock.calls.length - 1
    ]?.[0]?.card as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 已完成");
    expect(patchedCard.body?.elements?.[0]?.content).toContain("最终汇总：任务已继续完成");
    expect(patchedCard.body?.elements?.[0]?.content).not.toContain("处理失败");
  });

  it("keeps watching for a parent final reply even after tracked subagents are cleaned up", async () => {
    vi.useFakeTimers();
    try {
      resolveFeishuAccountMock.mockReturnValue({
        accountId: "main",
        appId: "app_id",
        appSecret: "app_secret",
        domain: "feishu",
        config: {
          renderMode: "auto",
          streaming: true,
          progressCard: { mode: "tools_summary" },
        },
      });

      const sessionKey = "agent:main:main";
      const childSessionKey = "agent:main:subagent:researcher";
      const sessionApi = {
        countActiveSubagentRuns: vi.fn(() => 0),
        listSubagentRunsForRequester: vi
          .fn()
          .mockReturnValueOnce([])
          .mockReturnValueOnce([
            {
              runId: "run-1",
              childSessionKey,
              label: "researcher",
              createdAt: 1_000,
              startedAt: 1_000,
              runTimeoutSeconds: 3_600,
            },
          ])
          .mockReturnValueOnce([]),
        readLatestAssistantReply: vi.fn(),
      };
      let parentReadCount = 0;
      sessionApi.readLatestAssistantReply.mockImplementation(
        async ({ sessionKey: requestedSessionKey }: { sessionKey: string }) => {
          if (requestedSessionKey === sessionKey) {
            parentReadCount += 1;
            return parentReadCount >= 3 ? "最终汇总：这次任务已经全部收口。" : "上一轮旧回复";
          }
          if (requestedSessionKey === childSessionKey) {
            return "阶段汇报：子任务正在整理材料";
          }
          return undefined;
        },
      );
      getFeishuRuntimeMock.mockReturnValue({
        channel: {
          text: {
            resolveTextChunkLimit: vi.fn(() => 4000),
            resolveChunkMode: vi.fn(() => "line"),
            resolveMarkdownTableMode: vi.fn(() => "preserve"),
            convertMarkdownTables: vi.fn((value) => value),
            chunkTextWithMode: vi.fn((value) => [value]),
          },
          reply: {
            createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
            resolveHumanDelayConfig: vi.fn(() => undefined),
          },
          session: sessionApi,
        },
      });
      const result = createFeishuReplyDispatcher({
        cfg: {} as never,
        agentId: "agent",
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        chatId: "oc_chat",
        sessionKey,
      });

      const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
      await result.replyOptions.onToolStart?.({ name: "subagents", phase: "start" });
      await options.deliver({ text: "进度 20%：已派发 1 个子任务" }, { kind: "final" });
      await vi.advanceTimersByTimeAsync(4500);

      const patchedCard = updateCardFeishuMock.mock.calls[
        updateCardFeishuMock.mock.calls.length - 1
      ]?.[0]?.card as {
        header?: { title?: { content?: string } };
        body?: { elements?: Array<{ content?: string }> };
      };
      expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 已完成");
      expect(patchedCard.body?.elements?.[0]?.content).toContain("最终汇总：这次任务已经全部收口");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat the previous turn's assistant reply as the current final summary", async () => {
    vi.useFakeTimers();
    try {
      resolveFeishuAccountMock.mockReturnValue({
        accountId: "main",
        appId: "app_id",
        appSecret: "app_secret",
        domain: "feishu",
        config: {
          renderMode: "auto",
          streaming: true,
          progressCard: { mode: "tools_summary" },
        },
      });

      const sessionKey = "agent:main:main";
      const childSessionKey = "agent:main:subagent:researcher";
      const sessionApi = {
        countActiveSubagentRuns: vi.fn(() => 0),
        listSubagentRunsForRequester: vi
          .fn()
          .mockReturnValueOnce([])
          .mockReturnValueOnce([
            {
              runId: "run-1",
              childSessionKey,
              label: "researcher",
              createdAt: 1_000,
              startedAt: 1_000,
              runTimeoutSeconds: 3_600,
            },
          ])
          .mockReturnValueOnce([]),
        readLatestAssistantReply: vi.fn(),
      };
      sessionApi.readLatestAssistantReply.mockImplementation(
        async ({ sessionKey: requestedSessionKey }: { sessionKey: string }) => {
          if (requestedSessionKey === sessionKey) {
            return "上一轮旧回复";
          }
          if (requestedSessionKey === childSessionKey) {
            return "阶段汇报：子任务正在整理材料";
          }
          return undefined;
        },
      );
      getFeishuRuntimeMock.mockReturnValue({
        channel: {
          text: {
            resolveTextChunkLimit: vi.fn(() => 4000),
            resolveChunkMode: vi.fn(() => "line"),
            resolveMarkdownTableMode: vi.fn(() => "preserve"),
            convertMarkdownTables: vi.fn((value) => value),
            chunkTextWithMode: vi.fn((value) => [value]),
          },
          reply: {
            createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
            resolveHumanDelayConfig: vi.fn(() => undefined),
          },
          session: sessionApi,
        },
      });
      const result = createFeishuReplyDispatcher({
        cfg: {} as never,
        agentId: "agent",
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        chatId: "oc_chat",
        sessionKey,
      });

      const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
      await result.replyOptions.onToolStart?.({ name: "subagents", phase: "start" });
      await options.deliver({ text: "进度 20%：已派发 1 个子任务" }, { kind: "final" });
      await vi.advanceTimersByTimeAsync(4500);

      const patchedCard = updateCardFeishuMock.mock.calls[
        updateCardFeishuMock.mock.calls.length - 1
      ]?.[0]?.card as {
        header?: { title?: { content?: string } };
        body?: { elements?: Array<{ content?: string }> };
      };
      expect(patchedCard.header?.title?.content).toBe("🦞 OpenClaw 等待最终汇总");
      expect(patchedCard.body?.elements?.[0]?.content).toContain("等待最终汇总");
      expect(patchedCard.body?.elements?.[0]?.content).not.toContain("上一轮旧回复");
    } finally {
      vi.useRealTimers();
    }
  });

  it("only reads activity for the visible active subagents on each snapshot", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        progressCard: { mode: "tools_summary" },
      },
    });

    const sessionKey = "agent:main:main";
    const activeRuns = Array.from({ length: 5 }, (_, index) => ({
      runId: `run-${index + 1}`,
      childSessionKey: `agent:main:subagent:worker-${index + 1}`,
      label: `worker-${index + 1}`,
      createdAt: 1_000 + index,
      startedAt: 1_000 + index,
      runTimeoutSeconds: 3_600,
    }));
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      sessionKey,
    });
    const sessionApi = getFeishuRuntimeMock.mock.results[0]?.value?.channel?.session as {
      listSubagentRunsForRequester: ReturnType<typeof vi.fn>;
      readLatestAssistantReply: ReturnType<typeof vi.fn>;
    };
    sessionApi.listSubagentRunsForRequester.mockReturnValue(activeRuns);
    const childActivityReads: string[] = [];
    sessionApi.readLatestAssistantReply.mockImplementation(
      async ({ sessionKey: requestedSessionKey }: { sessionKey: string }) => {
        if (requestedSessionKey !== sessionKey) {
          childActivityReads.push(requestedSessionKey);
          return `动态：${requestedSessionKey}`;
        }
        return "上一轮旧回复";
      },
    );

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await result.replyOptions.onToolStart?.({ name: "subagents", phase: "start" });
    await options.deliver({ text: "进度 20%：已派发 5 个子任务" }, { kind: "final" });

    expect(childActivityReads).toEqual(
      activeRuns.slice(0, 3).map((entry) => entry.childSessionKey),
    );
  });
});
