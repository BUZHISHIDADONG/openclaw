import { describe, it, expect, vi } from "vitest";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";

// Mock resolveFeishuAccount
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));

// Mock bot.js to verify handleFeishuMessage call
vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));
vi.mock("./progress-card.js", () => ({
  markFeishuProgressCardStopRequested: vi.fn(),
}));
vi.mock("./send.js", () => ({
  updateCardFeishu: vi.fn(),
}));

import { handleFeishuMessage } from "./bot.js";
import { markFeishuProgressCardStopRequested } from "./progress-card.js";
import { updateCardFeishu } from "./send.js";

describe("Feishu Card Action Handler", () => {
  const cfg = {} as any; // Minimal mock
  const runtime = { log: vi.fn(), error: vi.fn() } as any;

  it("handles card action with text payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok1",
      action: { value: { text: "/ping" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/ping"}',
            chat_id: "chat1",
            chat_type: "group",
          }),
          syntheticMeta: expect.objectContaining({
            commandSource: "native",
            skipReplyTo: true,
          }),
        }),
      }),
    );
  });

  it("keeps card actions in the original group when button payload carries group target", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok-group-stop",
      action: {
        value: {
          text: "/stop",
          targetSessionKey: "agent:main:feishu:group:oc-group-1",
          targetChatId: "oc-group-1",
          targetChatType: "group",
        },
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/stop"}',
            chat_id: "oc-group-1",
            chat_type: "group",
          }),
          syntheticMeta: expect.objectContaining({
            commandSource: "native",
            commandTargetSessionKey: "agent:main:feishu:group:oc-group-1",
            skipReplyTo: true,
          }),
        }),
      }),
    );
  });

  it("does not freeze the origin progress card before /stop is actually processed", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok-group-stop-card",
      action: {
        value: {
          text: "/stop",
          targetSessionKey: "agent:main:feishu:group:oc-group-1",
          targetChatId: "oc-group-1",
          targetChatType: "group",
          targetCardMessageId: "om_progress_card",
        },
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "oc-group-1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(markFeishuProgressCardStopRequested).not.toHaveBeenCalled();
    expect(updateCardFeishu).not.toHaveBeenCalled();
  });

  it("handles card action with JSON object payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok2",
      action: { value: { key: "val" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"{\\"key\\":\\"val\\"}"}',
            chat_id: "u123", // Fallback to open_id
          }),
        }),
      }),
    );
  });
});
