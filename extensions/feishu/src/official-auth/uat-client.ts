import type { ResolvedFeishuAccount } from "../types.js";
import { resolveFeishuOAuthEndpoints } from "./device-flow.js";
import {
  FEISHU_ACCESS_TOKEN_RETRY_CODES,
  FEISHU_REFRESH_RETRYABLE_CODES,
  FeishuUserAuthRequiredError,
  FeishuUserScopeInsufficientError,
  readFeishuErrorCode,
} from "./errors.js";
import {
  getStoredFeishuToken,
  getStoredFeishuTokenStatus,
  removeStoredFeishuToken,
  setStoredFeishuToken,
  type StoredFeishuUatToken,
} from "./token-store.js";

type ResolveUserAccessTokenParams = {
  account: ResolvedFeishuAccount;
  userOpenId: string;
  toolAction: string;
  requiredScopes: string[];
};

const refreshLocks = new Map<string, Promise<StoredFeishuUatToken | null>>();

function splitGrantedScopes(scope: string): string[] {
  return Array.from(
    new Set(
      scope
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).sort();
}

async function doRefreshToken(
  account: ResolvedFeishuAccount,
  stored: StoredFeishuUatToken,
): Promise<StoredFeishuUatToken | null> {
  if (!account.appId || !account.appSecret) {
    return null;
  }

  if (Date.now() >= stored.refreshExpiresAt) {
    await removeStoredFeishuToken(account.appId, stored.userOpenId);
    return null;
  }

  const endpoints = resolveFeishuOAuthEndpoints(account.domain);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: account.appId,
    client_secret: account.appSecret,
  }).toString();

  const callEndpoint = async () => {
    const response = await fetch(endpoints.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    return (await response.json()) as Record<string, unknown>;
  };

  let data = await callEndpoint();
  let code = typeof data.code === "number" ? data.code : undefined;
  let error = typeof data.error === "string" ? data.error : undefined;
  if ((code !== undefined && code !== 0) || error) {
    if (code !== undefined && FEISHU_REFRESH_RETRYABLE_CODES.has(code)) {
      data = await callEndpoint();
      code = typeof data.code === "number" ? data.code : undefined;
      error = typeof data.error === "string" ? data.error : undefined;
    }
    if ((code !== undefined && code !== 0) || error) {
      await removeStoredFeishuToken(account.appId, stored.userOpenId);
      return null;
    }
  }

  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Token refresh returned no access_token.");
  }

  const now = Date.now();
  const refreshed: StoredFeishuUatToken = {
    userOpenId: stored.userOpenId,
    appId: account.appId,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : stored.refreshToken,
    expiresAt: now + (typeof data.expires_in === "number" ? data.expires_in : 7200) * 1000,
    refreshExpiresAt:
      typeof data.refresh_token_expires_in === "number"
        ? now + data.refresh_token_expires_in * 1000
        : stored.refreshExpiresAt,
    scope: typeof data.scope === "string" ? data.scope : stored.scope,
    grantedAt: stored.grantedAt,
  };

  await setStoredFeishuToken(refreshed);
  return refreshed;
}

async function refreshWithLock(
  account: ResolvedFeishuAccount,
  stored: StoredFeishuUatToken,
): Promise<StoredFeishuUatToken | null> {
  const key = `${stored.appId}:${stored.userOpenId}`;
  const existing = refreshLocks.get(key);
  if (existing) {
    await existing;
    return await getStoredFeishuToken(stored.appId, stored.userOpenId);
  }

  const promise = doRefreshToken(account, stored);
  refreshLocks.set(key, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(key);
  }
}

export async function resolveFeishuUserAccessToken(
  params: ResolveUserAccessTokenParams,
): Promise<string> {
  const { account, userOpenId, toolAction, requiredScopes } = params;
  if (!account.appId) {
    throw new Error(`Feishu account "${account.accountId}" is missing appId.`);
  }

  const stored = await getStoredFeishuToken(account.appId, userOpenId);
  if (!stored) {
    throw new FeishuUserAuthRequiredError({
      toolAction,
      userOpenId,
      requiredScopes,
    });
  }

  const grantedScopes = splitGrantedScopes(stored.scope);
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new FeishuUserScopeInsufficientError({
      toolAction,
      userOpenId,
      missingScopes,
      grantedScopes,
    });
  }

  const status = getStoredFeishuTokenStatus(stored);
  if (status === "valid") {
    return stored.accessToken;
  }

  if (status === "needs_refresh") {
    const refreshed = await refreshWithLock(account, stored);
    if (!refreshed) {
      throw new FeishuUserAuthRequiredError({
        toolAction,
        userOpenId,
        requiredScopes,
      });
    }
    return refreshed.accessToken;
  }

  await removeStoredFeishuToken(account.appId, userOpenId);
  throw new FeishuUserAuthRequiredError({
    toolAction,
    userOpenId,
    requiredScopes,
  });
}

export async function callWithFeishuUserAccessToken<T>(
  params: ResolveUserAccessTokenParams & { apiCall: (accessToken: string) => Promise<T> },
): Promise<T> {
  const accessToken = await resolveFeishuUserAccessToken(params);
  try {
    return await params.apiCall(accessToken);
  } catch (error) {
    const code = readFeishuErrorCode(error);
    if (!code || !FEISHU_ACCESS_TOKEN_RETRY_CODES.has(code) || !params.account.appId) {
      throw error;
    }

    const stored = await getStoredFeishuToken(params.account.appId, params.userOpenId);
    if (!stored) {
      throw new FeishuUserAuthRequiredError({
        toolAction: params.toolAction,
        userOpenId: params.userOpenId,
        requiredScopes: params.requiredScopes,
      });
    }

    const refreshed = await refreshWithLock(params.account, stored);
    if (!refreshed) {
      throw new FeishuUserAuthRequiredError({
        toolAction: params.toolAction,
        userOpenId: params.userOpenId,
        requiredScopes: params.requiredScopes,
      });
    }

    return await params.apiCall(refreshed.accessToken);
  }
}

export async function revokeFeishuUserAuthorization(
  account: ResolvedFeishuAccount,
  userOpenId: string,
): Promise<void> {
  if (!account.appId) {
    return;
  }
  await removeStoredFeishuToken(account.appId, userOpenId);
}
