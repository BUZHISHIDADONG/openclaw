import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { resolveToolsConfig } from "./tools-config.js";

describe("feishu tools config", () => {
  it("enables chat tool by default", () => {
    const resolved = resolveToolsConfig(undefined);
    expect(resolved.chat).toBe(true);
  });

  it("enables official business tools by default", () => {
    const resolved = resolveToolsConfig(undefined);
    expect(resolved.oauth).toBe(true);
    expect(resolved.calendar).toBe(true);
    expect(resolved.task).toBe(true);
    expect(resolved.sheets).toBe(true);
    expect(resolved.im).toBe(true);
    expect(resolved.search).toBe(true);
  });

  it("accepts tools.chat in config schema", () => {
    const parsed = FeishuConfigSchema.parse({
      enabled: true,
      tools: {
        chat: false,
      },
    });

    expect(parsed.tools?.chat).toBe(false);
  });

  it("accepts official tools toggles in config schema", () => {
    const parsed = FeishuConfigSchema.parse({
      enabled: true,
      tools: {
        oauth: false,
        calendar: false,
        task: false,
        sheets: false,
        im: false,
        search: false,
      },
    });

    expect(parsed.tools?.oauth).toBe(false);
    expect(parsed.tools?.calendar).toBe(false);
    expect(parsed.tools?.task).toBe(false);
    expect(parsed.tools?.sheets).toBe(false);
    expect(parsed.tools?.im).toBe(false);
    expect(parsed.tools?.search).toBe(false);
  });
});
