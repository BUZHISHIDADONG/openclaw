import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import {
  handleFeishuMessage,
  type FeishuMessageEvent,
  type FeishuSyntheticCommandMeta,
} from "./bot.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  context: {
    open_id: string;
    user_id: string;
    chat_id: string;
  };
};

type FeishuCardActionValue = {
  text?: string;
  command?: string;
  targetSessionKey?: string;
  targetChatId?: string;
  targetChatType?: "group" | "p2p";
  targetRootId?: string;
  targetThreadId?: string;
  targetCardMessageId?: string;
};

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;

  // Extract action value
  const actionValue =
    typeof event.action.value === "object" && event.action.value !== null
      ? (event.action.value as FeishuCardActionValue)
      : undefined;
  let content = "";
  if (actionValue) {
    if (typeof actionValue.text === "string") {
      content = actionValue.text;
    } else if (typeof actionValue.command === "string") {
      content = actionValue.command;
    } else {
      content = JSON.stringify(actionValue);
    }
  } else {
    content = String(event.action.value);
  }

  const targetSessionKey = actionValue?.targetSessionKey?.trim() || undefined;
  const targetChatId =
    actionValue?.targetChatId?.trim() || event.context.chat_id || event.operator.open_id;
  const targetChatType =
    actionValue?.targetChatType === "group" || targetSessionKey?.includes(":group:")
      ? "group"
      : actionValue?.targetChatType === "p2p"
        ? "p2p"
        : event.context.chat_id
          ? "group"
          : "p2p";
  const targetRootId = actionValue?.targetRootId?.trim() || undefined;
  const targetThreadId = actionValue?.targetThreadId?.trim() || undefined;
  const targetCardMessageId = actionValue?.targetCardMessageId?.trim() || undefined;
  const syntheticMeta: FeishuSyntheticCommandMeta = {
    commandSource: "native",
    commandTargetSessionKey: targetSessionKey,
    ...(targetRootId ? {} : { skipReplyTo: true }),
  };

  // Construct a synthetic message event
  const messageEvent: FeishuMessageEvent = {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      ...(targetRootId ? { root_id: targetRootId } : {}),
      ...(targetThreadId ? { thread_id: targetThreadId } : {}),
      chat_id: targetChatId,
      chat_type: targetChatType,
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
    syntheticMeta,
  };

  log(
    `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content} -> chat=${targetChatId} type=${targetChatType} targetSession=${targetSessionKey ?? "(none)"}`,
  );

  // Dispatch as normal message
  await handleFeishuMessage({
    cfg,
    event: messageEvent,
    botOpenId: params.botOpenId,
    runtime,
    accountId,
  });
}
