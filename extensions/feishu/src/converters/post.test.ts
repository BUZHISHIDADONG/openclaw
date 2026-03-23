import { describe, expect, it } from "vitest";
import { convertPost } from "./post.js";
import type { ConvertContext } from "./types.js";

describe("convertPost", () => {
  const createContext = (overrides?: Partial<ConvertContext>): ConvertContext => ({
    mentions: new Map(),
    mentionsByOpenId: new Map(),
    messageId: "test-msg-id",
    ...overrides,
  });

  it("converts simple text post", async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: "text", text: "Hello, world!" }]],
      },
    });
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("Hello, world!");
    expect(result.resources).toEqual([]);
  });

  it("converts post with title", async () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: "My Title",
        content: [[{ tag: "text", text: "Content here" }]],
      },
    });
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("**My Title**\n\nContent here");
  });

  it("converts bold text", async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: "text", text: "bold text", style: ["bold"] }]],
      },
    });
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("**bold text**");
  });

  it("converts italic text", async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: "text", text: "italic text", style: ["italic"] }]],
      },
    });
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("*italic text*");
  });

  it("converts link", async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: "a", text: "Click here", href: "https://example.com" }]],
      },
    });
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("[Click here](https://example.com)");
  });

  it("converts image with resources", async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: "img", image_key: "img_abc123" }]],
      },
    });
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("![image](img_abc123)");
    expect(result.resources).toEqual([{ type: "image", fileKey: "img_abc123" }]);
  });

  it("converts at mention", async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: "at", user_id: "ou_123" }]],
      },
    });
    const ctx = createContext({
      mentionsByOpenId: new Map([
        ["ou_123", { key: "@_user_1", openId: "ou_123", name: "Alice", isBot: false }],
      ]),
      mentions: new Map([
        ["@_user_1", { key: "@_user_1", openId: "ou_123", name: "Alice", isBot: false }],
      ]),
    });
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe('<at user_id="ou_123">Alice</at>');
  });

  it("handles multiple paragraphs", async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [
          [{ tag: "text", text: "First paragraph" }],
          [{ tag: "text", text: "Second paragraph" }],
        ],
      },
    });
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("First paragraph\nSecond paragraph");
  });

  it("falls back to en_us when zh_cn not available", async () => {
    const raw = JSON.stringify({
      en_us: {
        content: [[{ tag: "text", text: "English content" }]],
      },
    });
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("English content");
  });

  it("handles empty content", async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [],
      },
    });
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("[rich text message]");
    expect(result.resources).toEqual([]);
  });

  it("handles malformed JSON", async () => {
    const raw = "not a json";
    const ctx = createContext();
    const result = await convertPost(raw, ctx);

    expect(result.content).toBe("[rich text message]");
    expect(result.resources).toEqual([]);
  });
});
