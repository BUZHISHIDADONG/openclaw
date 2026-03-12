import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { extractAssistantText, stripToolMessages } from "./sessions-helpers.js";

function hasEmbeddedToolCall(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (
    Array.isArray(content) &&
    content.some(
      (part) =>
        part &&
        typeof part === "object" &&
        ((part as { type?: unknown }).type === "toolCall" ||
          (part as { type?: unknown }).type === "tool_use"),
    )
  ) {
    return true;
  }
  const rawToolCalls =
    message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
  if (Array.isArray(rawToolCalls)) {
    return rawToolCalls.length > 0;
  }
  return Boolean(rawToolCalls);
}

function isTerminalAssistantMessage(message: Record<string, unknown>): boolean {
  if (hasEmbeddedToolCall(message)) {
    return false;
  }
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  return (
    stopReason !== "toolUse" &&
    stopReason !== "tool_use" &&
    stopReason !== "tool_calls" &&
    stopReason !== "function_call" &&
    stopReason !== "functionCall"
  );
}

export async function readLatestAssistantReply(params: {
  sessionKey: string;
  limit?: number;
}): Promise<string | undefined> {
  const history = await callGateway<{ messages: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: params.limit ?? 50 },
  });
  const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
  for (let i = filtered.length - 1; i >= 0; i -= 1) {
    const candidate = filtered[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const text = extractAssistantText(candidate);
    if (!text?.trim()) {
      continue;
    }
    // A newest assistant turn that still carries tool calls is an in-flight update,
    // not a stable final reply for downstream delivery or summarization.
    return isTerminalAssistantMessage(candidate as Record<string, unknown>) ? text : undefined;
  }
  return undefined;
}

export async function runAgentStep(params: {
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  channel?: string;
  lane?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
}): Promise<string | undefined> {
  const stepIdem = crypto.randomUUID();
  const response = await callGateway<{ runId?: string }>({
    method: "agent",
    params: {
      message: params.message,
      sessionKey: params.sessionKey,
      idempotencyKey: stepIdem,
      deliver: false,
      channel: params.channel ?? INTERNAL_MESSAGE_CHANNEL,
      lane: params.lane ?? AGENT_LANE_NESTED,
      extraSystemPrompt: params.extraSystemPrompt,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool ?? "sessions_send",
      },
    },
    timeoutMs: 10_000,
  });

  const stepRunId = typeof response?.runId === "string" && response.runId ? response.runId : "";
  const resolvedRunId = stepRunId || stepIdem;
  const stepWaitMs = Math.min(params.timeoutMs, 60_000);
  const wait = await callGateway<{ status?: string }>({
    method: "agent.wait",
    params: {
      runId: resolvedRunId,
      timeoutMs: stepWaitMs,
    },
    timeoutMs: stepWaitMs + 2000,
  });
  if (wait?.status !== "ok") {
    return undefined;
  }
  return await readLatestAssistantReply({ sessionKey: params.sessionKey });
}
