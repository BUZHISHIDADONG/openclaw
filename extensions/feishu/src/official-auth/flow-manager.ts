import type { ResolvedFeishuAccount } from "../types.js";
import { pollFeishuDeviceToken, requestFeishuDeviceAuthorization } from "./device-flow.js";
import { applyFeishuUatScopePolicy } from "./scopes.js";
import {
  getStoredFeishuToken,
  getStoredFeishuTokenStatus,
  removeStoredFeishuToken,
  setStoredFeishuToken,
} from "./token-store.js";

type AuthorizationState = "authorized" | "denied" | "error" | "pending";
type FlowLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type FeishuAuthorizationSnapshot = {
  state: AuthorizationState;
  userOpenId: string;
  appId?: string;
  requestedScopes: string[];
  grantedScopes?: string[];
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  expiresAt?: string;
  authorizedAt?: string;
  tokenStatus?: "valid" | "needs_refresh" | "expired";
  error?: string;
  reused?: boolean;
  message: string;
};

type PendingAuthorizationFlow = {
  account: ResolvedFeishuAccount;
  userOpenId: string;
  requestedScopes: string[];
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAtMs: number;
  createdAtMs: number;
  controller: AbortController;
  state: AuthorizationState;
  error?: string;
  authorizedAtMs?: number;
};

const pendingFlows = new Map<string, PendingAuthorizationFlow>();
const completedFlowRetentionMs = 5 * 60 * 1000;

function buildFlowKey(account: ResolvedFeishuAccount, userOpenId: string): string {
  return `${account.appId ?? account.accountId}:${userOpenId}`;
}

function formatIsoTime(value?: number): string | undefined {
  return typeof value === "number" ? new Date(value).toISOString() : undefined;
}

function flowMessageForState(state: AuthorizationState): string {
  switch (state) {
    case "authorized":
      return "Authorization has completed.";
    case "denied":
      return "Authorization was denied.";
    case "error":
      return "Authorization failed.";
    default:
      return "Open the verification URL, complete the Feishu OAuth flow, then retry your tool call.";
  }
}

function toSnapshot(flow: PendingAuthorizationFlow, reused = false): FeishuAuthorizationSnapshot {
  return {
    state: flow.state,
    userOpenId: flow.userOpenId,
    appId: flow.account.appId,
    requestedScopes: [...flow.requestedScopes],
    verificationUri: flow.verificationUri,
    verificationUriComplete: flow.verificationUriComplete,
    userCode: flow.userCode,
    expiresAt: formatIsoTime(flow.expiresAtMs),
    authorizedAt: formatIsoTime(flow.authorizedAtMs),
    error: flow.error,
    reused,
    message: flowMessageForState(flow.state),
  };
}

async function runFlowPolling(flow: PendingAuthorizationFlow, logger?: FlowLogger): Promise<void> {
  const { account } = flow;
  if (!account.appId || !account.appSecret) {
    flow.state = "error";
    flow.error = `Feishu account "${account.accountId}" is not fully configured.`;
    return;
  }

  try {
    const result = await pollFeishuDeviceToken({
      appId: account.appId,
      appSecret: account.appSecret,
      domain: account.domain,
      deviceCode: flow.deviceCode,
      interval: flow.intervalSeconds,
      expiresIn: flow.expiresInSeconds,
      signal: flow.controller.signal,
    });

    if (!result.ok) {
      flow.state = result.error === "access_denied" ? "denied" : "error";
      flow.error = result.message;
      return;
    }

    const now = Date.now();
    await setStoredFeishuToken({
      userOpenId: flow.userOpenId,
      appId: account.appId,
      accessToken: result.token.accessToken,
      refreshToken: result.token.refreshToken,
      expiresAt: now + result.token.expiresIn * 1000,
      refreshExpiresAt: now + result.token.refreshExpiresIn * 1000,
      scope: result.token.scope,
      grantedAt: now,
    });
    flow.state = "authorized";
    flow.authorizedAtMs = now;
  } catch (error) {
    if (flow.controller.signal.aborted) {
      flow.state = "error";
      flow.error = "Authorization flow was replaced by a newer request.";
      return;
    }
    flow.state = "error";
    flow.error = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`feishu_oauth: background poll failed: ${flow.error}`);
  } finally {
    setTimeout(() => {
      const current = pendingFlows.get(buildFlowKey(flow.account, flow.userOpenId));
      if (current === flow && current.state !== "pending") {
        pendingFlows.delete(buildFlowKey(flow.account, flow.userOpenId));
      }
    }, completedFlowRetentionMs);
  }
}

export async function getFeishuAuthorizationSnapshot(params: {
  account: ResolvedFeishuAccount;
  userOpenId: string;
}): Promise<FeishuAuthorizationSnapshot> {
  const pending = pendingFlows.get(buildFlowKey(params.account, params.userOpenId));
  if (pending) {
    return toSnapshot(pending);
  }

  if (!params.account.appId) {
    return {
      state: "error",
      userOpenId: params.userOpenId,
      requestedScopes: [],
      message: `Feishu account "${params.account.accountId}" is missing appId.`,
    };
  }

  const stored = await getStoredFeishuToken(params.account.appId, params.userOpenId);
  if (!stored) {
    return {
      state: "error",
      userOpenId: params.userOpenId,
      appId: params.account.appId,
      requestedScopes: [],
      message: "No stored Feishu user authorization was found.",
    };
  }

  return {
    state: "authorized",
    userOpenId: params.userOpenId,
    appId: params.account.appId,
    requestedScopes: [],
    grantedScopes: stored.scope.split(/\s+/).filter(Boolean),
    authorizedAt: new Date(stored.grantedAt).toISOString(),
    tokenStatus: getStoredFeishuTokenStatus(stored),
    message: "Stored Feishu user authorization is available.",
  };
}

export async function startFeishuAuthorizationFlow(params: {
  account: ResolvedFeishuAccount;
  userOpenId: string;
  requestedScopes: string[];
  logger?: FlowLogger;
}): Promise<FeishuAuthorizationSnapshot> {
  const { account, userOpenId, logger } = params;
  if (!account.appId || !account.appSecret) {
    return {
      state: "error",
      userOpenId,
      requestedScopes: [],
      message: `Feishu account "${account.accountId}" is not fully configured.`,
    };
  }

  const requestedScopes = applyFeishuUatScopePolicy(params.requestedScopes, account.config.uat);
  const stored = await getStoredFeishuToken(account.appId, userOpenId);
  if (stored) {
    const grantedScopes = stored.scope.split(/\s+/).filter(Boolean);
    const missingScopes = requestedScopes.filter((scope) => !grantedScopes.includes(scope));
    if (missingScopes.length === 0) {
      return {
        state: "authorized",
        userOpenId,
        appId: account.appId,
        requestedScopes,
        grantedScopes,
        authorizedAt: new Date(stored.grantedAt).toISOString(),
        tokenStatus: getStoredFeishuTokenStatus(stored),
        message: "Stored Feishu user authorization already satisfies the requested scopes.",
      };
    }
  }

  const key = buildFlowKey(account, userOpenId);
  const existing = pendingFlows.get(key);
  if (
    existing &&
    existing.state === "pending" &&
    requestedScopes.every((scope) => existing.requestedScopes.includes(scope))
  ) {
    return toSnapshot(existing, true);
  }

  if (existing) {
    existing.controller.abort();
    pendingFlows.delete(key);
  }

  const authorization = await requestFeishuDeviceAuthorization({
    appId: account.appId,
    appSecret: account.appSecret,
    domain: account.domain,
    scope: requestedScopes,
  });

  const flow: PendingAuthorizationFlow = {
    account,
    userOpenId,
    requestedScopes,
    deviceCode: authorization.deviceCode,
    intervalSeconds: authorization.interval,
    expiresInSeconds: authorization.expiresIn,
    verificationUri: authorization.verificationUri,
    verificationUriComplete: authorization.verificationUriComplete,
    userCode: authorization.userCode,
    expiresAtMs: Date.now() + authorization.expiresIn * 1000,
    createdAtMs: Date.now(),
    controller: new AbortController(),
    state: "pending",
  };

  pendingFlows.set(key, flow);
  void runFlowPolling(flow, logger);

  logger?.info?.(
    `feishu_oauth: started device flow for ${userOpenId} scopes=${requestedScopes.join(",")}`,
  );

  return toSnapshot(flow);
}

export async function revokeFeishuAuthorizationFlow(params: {
  account: ResolvedFeishuAccount;
  userOpenId: string;
}): Promise<void> {
  const pending = pendingFlows.get(buildFlowKey(params.account, params.userOpenId));
  if (pending) {
    pending.controller.abort();
    pendingFlows.delete(buildFlowKey(params.account, params.userOpenId));
  }

  if (params.account.appId) {
    await removeStoredFeishuToken(params.account.appId, params.userOpenId);
  }
}
