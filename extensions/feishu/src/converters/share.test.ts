import { describe, expect, it } from "vitest";
import { convertShareChat, convertShareUser } from "./share.js";

describe("convertShareChat", () => {
  it("prefers body text for forwarded chats", async () => {
    const raw = JSON.stringify({
      body: "Merged and Forwarded Message",
      share_chat_id: "sc_abc123",
    });

    const result = await convertShareChat(raw, {
      mentions: new Map(),
      mentionsByOpenId: new Map(),
      messageId: "msg-share-chat",
    });

    expect(result.content).toBe("Merged and Forwarded Message");
    expect(result.resources).toEqual([]);
  });

  it("falls back to summary and then share_chat_id", async () => {
    const summaryResult = await convertShareChat(JSON.stringify({ summary: "Forward summary" }), {
      mentions: new Map(),
      mentionsByOpenId: new Map(),
      messageId: "msg-share-chat-summary",
    });
    const idResult = await convertShareChat(JSON.stringify({ share_chat_id: "sc_abc123" }), {
      mentions: new Map(),
      mentionsByOpenId: new Map(),
      messageId: "msg-share-chat-id",
    });

    expect(summaryResult.content).toBe("Forward summary");
    expect(idResult.content).toBe("[Forwarded message: sc_abc123]");
  });
});

describe("convertShareUser", () => {
  it("keeps shared user identifiers", async () => {
    const raw = JSON.stringify({ user_id: "ou_alice" });

    const result = await convertShareUser(raw, {
      mentions: new Map(),
      mentionsByOpenId: new Map(),
      messageId: "msg-share-user",
    });

    expect(result.content).toBe("[Shared user: ou_alice]");
    expect(result.resources).toEqual([]);
  });
});
