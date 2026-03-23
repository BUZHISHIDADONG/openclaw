import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { parseFeishuMessageEventWithConverters } from "./bot.js";

function makeTextEvent(params: {
  chatType: "p2p" | "group";
  text: string;
  mentions?: FeishuMessageEvent["message"]["mentions"];
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou_sender",
        user_id: "u_sender",
      },
    },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat_1",
      chat_type: params.chatType,
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      mentions: params.mentions,
    },
  };
}

function makeShareChatEvent(content: Record<string, unknown>): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou_sender",
        user_id: "u_sender",
      },
    },
    message: {
      message_id: "msg_share_1",
      chat_id: "oc_chat_1",
      chat_type: "group",
      message_type: "share_chat",
      content: JSON.stringify(content),
      mentions: [],
    },
  };
}

describe("parseFeishuMessageEventWithConverters", () => {
  it("strips bot mentions in p2p text messages", async () => {
    const event = makeTextEvent({
      chatType: "p2p",
      text: "@_bot_1 /help",
      mentions: [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }],
    });

    const ctx = await parseFeishuMessageEventWithConverters({
      event,
      botOpenId: "ou_bot",
    });

    expect(ctx.content).toBe("/help");
  });

  it("preserves mention tags in group text messages", async () => {
    const event = makeTextEvent({
      chatType: "group",
      text: "hello @_user_1",
      mentions: [{ key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } }],
    });

    const ctx = await parseFeishuMessageEventWithConverters({
      event,
      botOpenId: "ou_bot",
    });

    expect(ctx.content).toBe('hello <at user_id="ou_alice">Alice</at>');
  });

  it("keeps share_chat summary text on the converter path", async () => {
    const event = makeShareChatEvent({
      summary: "Merged and Forwarded Message",
      share_chat_id: "sc_abc123",
    });

    const ctx = await parseFeishuMessageEventWithConverters({
      event,
      botOpenId: "ou_bot",
    });

    expect(ctx.content).toBe("Merged and Forwarded Message");
  });
});
