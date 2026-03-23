import { describe, expect, it } from "vitest";
import { convertText } from "./text.js";
import type { ConvertContext } from "./types.js";

describe("convertText", () => {
  const createContext = (overrides?: Partial<ConvertContext>): ConvertContext => ({
    mentions: new Map(),
    mentionsByOpenId: new Map(),
    messageId: "test-msg-id",
    ...overrides,
  });

  it("converts plain text message", async () => {
    const raw = JSON.stringify({ text: "Hello, world!" });
    const ctx = createContext();
    const result = await convertText(raw, ctx);

    expect(result.content).toBe("Hello, world!");
    expect(result.resources).toEqual([]);
  });

  it("handles text with mentions", async () => {
    const raw = JSON.stringify({ text: "Hello @user123!" });
    const ctx = createContext({
      mentions: new Map([
        ["@user123", { key: "@user123", openId: "ou_123", name: "Alice", isBot: false }],
      ]),
    });
    const result = await convertText(raw, ctx);

    expect(result.content).toBe('Hello <at user_id="ou_123">Alice</at>!');
    expect(result.resources).toEqual([]);
  });

  it("strips bot mentions in p2p chat", async () => {
    const raw = JSON.stringify({ text: "@bot Hello!" });
    const ctx = createContext({
      mentions: new Map([["@bot", { key: "@bot", openId: "ou_bot", name: "Bot", isBot: true }]]),
      stripBotMentions: true,
    });
    const result = await convertText(raw, ctx);

    expect(result.content).toBe("Hello!");
    expect(result.resources).toEqual([]);
  });

  it("keeps bot mentions in group chat", async () => {
    const raw = JSON.stringify({ text: "@bot Hello!" });
    const ctx = createContext({
      mentions: new Map([["@bot", { key: "@bot", openId: "ou_bot", name: "Bot", isBot: true }]]),
      stripBotMentions: false,
    });
    const result = await convertText(raw, ctx);

    expect(result.content).toBe('<at user_id="ou_bot">Bot</at> Hello!');
    expect(result.resources).toEqual([]);
  });

  it("handles empty text", async () => {
    const raw = JSON.stringify({ text: "" });
    const ctx = createContext();
    const result = await convertText(raw, ctx);

    expect(result.content).toBe("");
    expect(result.resources).toEqual([]);
  });

  it("handles malformed JSON by returning raw content", async () => {
    const raw = "not a json";
    const ctx = createContext();
    const result = await convertText(raw, ctx);

    expect(result.content).toBe("not a json");
    expect(result.resources).toEqual([]);
  });

  it("handles missing text field", async () => {
    const raw = JSON.stringify({ other: "field" });
    const ctx = createContext();
    const result = await convertText(raw, ctx);

    expect(result.content).toBe(raw);
    expect(result.resources).toEqual([]);
  });
});
