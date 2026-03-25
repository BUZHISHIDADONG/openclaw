export const FEISHU_AUTH_ERROR = {
  APP_SCOPE_MISSING: 99991672,
  USER_SCOPE_INSUFFICIENT: 99991679,
  TOKEN_INVALID: 99991668,
  TOKEN_EXPIRED: 99991677,
  REFRESH_TOKEN_INVALID: 20026,
  REFRESH_TOKEN_EXPIRED: 20037,
  REFRESH_TOKEN_REVOKED: 20064,
  REFRESH_TOKEN_ALREADY_USED: 20073,
  REFRESH_SERVER_ERROR: 20050,
} as const;

export const FEISHU_REFRESH_RETRYABLE_CODES = new Set<number>([
  FEISHU_AUTH_ERROR.REFRESH_SERVER_ERROR,
]);

export const FEISHU_ACCESS_TOKEN_RETRY_CODES = new Set<number>([
  FEISHU_AUTH_ERROR.TOKEN_INVALID,
  FEISHU_AUTH_ERROR.TOKEN_EXPIRED,
]);

export class MissingFeishuRequesterError extends Error {
  constructor() {
    super("This tool requires a trusted Feishu requester and must be called from a Feishu chat.");
    this.name = "MissingFeishuRequesterError";
  }
}

export class FeishuUatScopePolicyError extends Error {
  readonly requestedScopes: string[];

  constructor(requestedScopes: string[]) {
    super("Requested user scopes are blocked by the current Feishu UAT policy.");
    this.name = "FeishuUatScopePolicyError";
    this.requestedScopes = requestedScopes;
  }
}

export class FeishuUserAuthRequiredError extends Error {
  readonly toolAction: string;
  readonly userOpenId: string;
  readonly requiredScopes: string[];

  constructor(params: { toolAction: string; userOpenId: string; requiredScopes: string[] }) {
    super("User authorization is required.");
    this.name = "FeishuUserAuthRequiredError";
    this.toolAction = params.toolAction;
    this.userOpenId = params.userOpenId;
    this.requiredScopes = params.requiredScopes;
  }
}

export class FeishuUserScopeInsufficientError extends Error {
  readonly toolAction: string;
  readonly userOpenId: string;
  readonly missingScopes: string[];
  readonly grantedScopes: string[];

  constructor(params: {
    toolAction: string;
    userOpenId: string;
    missingScopes: string[];
    grantedScopes: string[];
  }) {
    super("User authorization does not cover the required scopes.");
    this.name = "FeishuUserScopeInsufficientError";
    this.toolAction = params.toolAction;
    this.userOpenId = params.userOpenId;
    this.missingScopes = params.missingScopes;
    this.grantedScopes = params.grantedScopes;
  }
}

export class FeishuAppScopeMissingError extends Error {
  readonly toolAction: string;
  readonly appId?: string;
  readonly requiredScopes: string[];

  constructor(params: { toolAction: string; requiredScopes: string[]; appId?: string }) {
    super("The Feishu app is missing required scopes.");
    this.name = "FeishuAppScopeMissingError";
    this.toolAction = params.toolAction;
    this.appId = params.appId;
    this.requiredScopes = params.requiredScopes;
  }
}

export function readFeishuErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "number") {
    return direct;
  }

  const responseCode = (error as { response?: { data?: { code?: unknown } } }).response?.data?.code;
  return typeof responseCode === "number" ? responseCode : undefined;
}
