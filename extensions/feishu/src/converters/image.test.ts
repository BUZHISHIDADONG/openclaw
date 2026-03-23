import { describe, expect, it } from "vitest";
import { convertImage } from "./image.js";
import type { ConvertContext } from "./types.js";

describe("convertImage", () => {
  const createContext = (): ConvertContext => ({
    mentions: new Map(),
    mentionsByOpenId: new Map(),
    messageId: "test-msg-id",
  });

  it("converts image message with image_key", async () => {
    const raw = JSON.stringify({ image_key: "img_abc123" });
    const ctx = createContext();
    const result = await convertImage(raw, ctx);

    expect(result.content).toBe("![image](img_abc123)");
    expect(result.resources).toEqual([{ type: "image", fileKey: "img_abc123" }]);
  });

  it("handles missing image_key", async () => {
    const raw = JSON.stringify({ other: "field" });
    const ctx = createContext();
    const result = await convertImage(raw, ctx);

    expect(result.content).toBe("[image]");
    expect(result.resources).toEqual([]);
  });

  it("handles malformed JSON", async () => {
    const raw = "not a json";
    const ctx = createContext();
    const result = await convertImage(raw, ctx);

    expect(result.content).toBe("[image]");
    expect(result.resources).toEqual([]);
  });

  it("handles empty image_key", async () => {
    const raw = JSON.stringify({ image_key: "" });
    const ctx = createContext();
    const result = await convertImage(raw, ctx);

    expect(result.content).toBe("[image]");
    expect(result.resources).toEqual([]);
  });
});
