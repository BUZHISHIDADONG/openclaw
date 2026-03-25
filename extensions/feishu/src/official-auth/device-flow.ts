import type { FeishuDomain } from "../types.js";

export type FeishuDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type FeishuDeviceFlowTokenData = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
};

export type FeishuDeviceFlowResult =
  | { ok: true; token: FeishuDeviceFlowTokenData }
  | {
      ok: false;
      error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token";
      message: string;
    };

export function resolveFeishuOAuthEndpoints(domain: FeishuDomain): {
  deviceAuthorization: string;
  token: string;
} {
  if (!domain || domain === "feishu") {
    return {
      deviceAuthorization: "https://accounts.feishu.cn/oauth/v1/device_authorization",
      token: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
    };
  }

  if (domain === "lark") {
    return {
      deviceAuthorization: "https://accounts.larksuite.com/oauth/v1/device_authorization",
      token: "https://open.larksuite.com/open-apis/authen/v2/oauth/token",
    };
  }

  const base = domain.replace(/\/+$/, "");
  let accountsBase = base;
  try {
    const parsed = new URL(base);
    if (parsed.hostname.startsWith("open.")) {
      accountsBase = `${parsed.protocol}//${parsed.hostname.replace(/^open\./, "accounts.")}`;
    }
  } catch {
    accountsBase = base;
  }

  return {
    deviceAuthorization: `${accountsBase}/oauth/v1/device_authorization`,
    token: `${base}/open-apis/authen/v2/oauth/token`,
  };
}

export async function requestFeishuDeviceAuthorization(params: {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  scope: string[];
}): Promise<FeishuDeviceAuthorization> {
  const scopeSet = new Set(params.scope.filter(Boolean));
  scopeSet.add("offline_access");
  const scope = Array.from(scopeSet).sort().join(" ");
  const endpoints = resolveFeishuOAuthEndpoints(params.domain);
  const basicAuth = Buffer.from(`${params.appId}:${params.appSecret}`).toString("base64");

  const response = await fetch(endpoints.deviceAuthorization, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: params.appId,
      scope,
    }).toString(),
  });

  const rawText = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new Error(`Device authorization failed: HTTP ${response.status}`);
  }

  if (!response.ok || data.error) {
    const message =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      `HTTP ${response.status}`;
    throw new Error(`Device authorization failed: ${message}`);
  }

  return {
    deviceCode: String(data.device_code ?? ""),
    userCode: String(data.user_code ?? ""),
    verificationUri: String(data.verification_uri ?? ""),
    verificationUriComplete: String(data.verification_uri_complete ?? data.verification_uri ?? ""),
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 240,
    interval: typeof data.interval === "number" ? data.interval : 5,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function pollFeishuDeviceToken(params: {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  signal?: AbortSignal;
}): Promise<FeishuDeviceFlowResult> {
  const endpoints = resolveFeishuOAuthEndpoints(params.domain);
  const deadline = Date.now() + params.expiresIn * 1000;
  const maxAttempts = 200;
  let interval = params.interval;
  let attempts = 0;

  while (Date.now() < deadline && attempts < maxAttempts) {
    attempts += 1;
    if (params.signal?.aborted) {
      return { ok: false, error: "expired_token", message: "Polling was cancelled." };
    }

    await sleep(interval * 1000, params.signal);

    let data: Record<string, unknown>;
    try {
      const response = await fetch(endpoints.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: params.deviceCode,
          client_id: params.appId,
          client_secret: params.appSecret,
        }).toString(),
      });
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      interval = Math.min(interval + 1, 60);
      continue;
    }

    const error = typeof data.error === "string" ? data.error : undefined;
    if (!error && typeof data.access_token === "string") {
      return {
        ok: true,
        token: {
          accessToken: data.access_token,
          refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
          expiresIn: typeof data.expires_in === "number" ? data.expires_in : 7200,
          refreshExpiresIn:
            typeof data.refresh_token_expires_in === "number"
              ? data.refresh_token_expires_in
              : 604800,
          scope: typeof data.scope === "string" ? data.scope : "",
        },
      };
    }

    if (error === "authorization_pending") {
      continue;
    }

    if (error === "slow_down") {
      interval = Math.min(interval + 5, 60);
      continue;
    }

    if (error === "access_denied") {
      return {
        ok: false,
        error,
        message: "Authorization was denied by the user.",
      };
    }

    if (error === "expired_token") {
      return {
        ok: false,
        error,
        message: "The device authorization request expired.",
      };
    }
  }

  return {
    ok: false,
    error: "expired_token",
    message: "The device authorization request expired.",
  };
}
