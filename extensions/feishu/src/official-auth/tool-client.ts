import * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import { createFeishuClient } from "../client.js";
import { resolveFeishuToolAccount } from "../tool-account.js";
import type { ResolvedFeishuAccount } from "../types.js";
import {
  FeishuAppScopeMissingError,
  FeishuUserAuthRequiredError,
  FeishuUserScopeInsufficientError,
  MissingFeishuRequesterError,
  readFeishuErrorCode,
  FEISHU_AUTH_ERROR,
} from "./errors.js";
import { applyFeishuUatScopePolicy, getFeishuRequiredScopes } from "./scopes.js";
import { callWithFeishuUserAccessToken } from "./uat-client.js";

type InvokeMode = "tenant" | "user";

export type FeishuOfficialInvokeOptions = {
  as?: InvokeMode;
  userOpenId?: string;
  requiredScopes?: string[];
};

export type FeishuOfficialInvokeByPathOptions = FeishuOfficialInvokeOptions & {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
};

function sanitizeQuery(
  query?: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> | undefined {
  if (!query) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string | number | boolean] => {
      const [, value] = entry;
      return value !== undefined;
    }),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function resolveRequestedScopes(
  account: ResolvedFeishuAccount,
  toolAction: string,
  override?: string[],
): string[] {
  const requestedScopes =
    override && override.length > 0 ? override : getFeishuRequiredScopes(toolAction);
  if (requestedScopes.length === 0) {
    return [];
  }
  return applyFeishuUatScopePolicy(requestedScopes, account.config.uat);
}

function mapAuthCodeToError(params: {
  code?: number;
  toolAction: string;
  account: ResolvedFeishuAccount;
  userOpenId?: string;
  requiredScopes: string[];
  grantedScopes?: string[];
}): Error | null {
  if (!params.code) {
    return null;
  }

  if (params.code === FEISHU_AUTH_ERROR.APP_SCOPE_MISSING) {
    return new FeishuAppScopeMissingError({
      toolAction: params.toolAction,
      appId: params.account.appId,
      requiredScopes: params.requiredScopes,
    });
  }

  if (params.code === FEISHU_AUTH_ERROR.USER_SCOPE_INSUFFICIENT && params.userOpenId) {
    return new FeishuUserScopeInsufficientError({
      toolAction: params.toolAction,
      userOpenId: params.userOpenId,
      missingScopes: params.requiredScopes,
      grantedScopes: params.grantedScopes ?? [],
    });
  }

  return null;
}

export class FeishuOfficialToolClient {
  readonly account: ResolvedFeishuAccount;
  readonly sdk: Lark.Client;
  readonly requesterOpenId?: string;

  constructor(params: { account: ResolvedFeishuAccount; requesterOpenId?: string }) {
    if (!params.account.configured) {
      throw new Error(`Feishu account "${params.account.accountId}" is not configured.`);
    }
    this.account = params.account;
    this.sdk = createFeishuClient(params.account);
    this.requesterOpenId = params.requesterOpenId?.trim() || undefined;
  }

  private resolveUserOpenId(options?: FeishuOfficialInvokeOptions): string {
    const userOpenId = options?.userOpenId?.trim() || this.requesterOpenId;
    if (!userOpenId) {
      throw new MissingFeishuRequesterError();
    }
    return userOpenId;
  }

  async invoke<T>(
    toolAction: string,
    fn: (
      sdk: Lark.Client,
      requestOptions?: ReturnType<typeof Lark.withUserAccessToken>,
    ) => Promise<T>,
    options?: FeishuOfficialInvokeOptions,
  ): Promise<T> {
    const mode = options?.as ?? "user";
    if (mode === "tenant") {
      return await fn(this.sdk);
    }

    const userOpenId = this.resolveUserOpenId(options);
    const requiredScopes = resolveRequestedScopes(
      this.account,
      toolAction,
      options?.requiredScopes,
    );
    try {
      return await callWithFeishuUserAccessToken({
        account: this.account,
        userOpenId,
        toolAction,
        requiredScopes,
        apiCall: async (accessToken) => await fn(this.sdk, Lark.withUserAccessToken(accessToken)),
      });
    } catch (error) {
      const mapped = mapAuthCodeToError({
        code: readFeishuErrorCode(error),
        toolAction,
        account: this.account,
        userOpenId,
        requiredScopes,
      });
      throw mapped ?? error;
    }
  }

  async invokeByPath<T>(
    toolAction: string,
    path: string,
    options?: FeishuOfficialInvokeByPathOptions,
  ): Promise<T> {
    const mode = options?.as ?? "user";
    const query = sanitizeQuery(options?.query);
    const method = options?.method ?? "GET";

    if (mode === "tenant") {
      const response = await this.sdk.request<T>({
        method,
        url: path,
        params: query,
        data: options?.body,
        headers: options?.headers,
      });
      const mapped = mapAuthCodeToError({
        code:
          typeof (response as { code?: unknown }).code === "number"
            ? ((response as { code?: number }).code ?? undefined)
            : undefined,
        toolAction,
        account: this.account,
        requiredScopes: resolveRequestedScopes(this.account, toolAction, options?.requiredScopes),
      });
      if (mapped) {
        throw mapped;
      }
      return response;
    }

    const userOpenId = this.resolveUserOpenId(options);
    const requiredScopes = resolveRequestedScopes(
      this.account,
      toolAction,
      options?.requiredScopes,
    );
    try {
      return await callWithFeishuUserAccessToken({
        account: this.account,
        userOpenId,
        toolAction,
        requiredScopes,
        apiCall: async (accessToken) => {
          const response = await this.sdk.request<T>(
            {
              method,
              url: path,
              params: query,
              data: options?.body,
              headers: {
                ...(options?.headers ?? {}),
                Authorization: `Bearer ${accessToken}`,
              },
            },
            Lark.withUserAccessToken(accessToken),
          );
          const mapped = mapAuthCodeToError({
            code:
              typeof (response as { code?: unknown }).code === "number"
                ? ((response as { code?: number }).code ?? undefined)
                : undefined,
            toolAction,
            account: this.account,
            userOpenId,
            requiredScopes,
          });
          if (mapped) {
            throw mapped;
          }
          return response;
        },
      });
    } catch (error) {
      const mapped = mapAuthCodeToError({
        code: readFeishuErrorCode(error),
        toolAction,
        account: this.account,
        userOpenId,
        requiredScopes,
      });
      throw mapped ?? error;
    }
  }
}

export function createFeishuOfficialToolClient(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: { accountId?: string };
  defaultAccountId?: string;
  requesterOpenId?: string;
}): FeishuOfficialToolClient {
  const account = resolveFeishuToolAccount({
    api: params.api,
    executeParams: params.executeParams,
    defaultAccountId: params.defaultAccountId,
  });
  return new FeishuOfficialToolClient({
    account,
    requesterOpenId: params.requesterOpenId,
  });
}

export function isFeishuAuthorizationError(
  error: unknown,
): error is
  | FeishuUserAuthRequiredError
  | FeishuUserScopeInsufficientError
  | FeishuAppScopeMissingError
  | MissingFeishuRequesterError {
  return (
    error instanceof FeishuUserAuthRequiredError ||
    error instanceof FeishuUserScopeInsufficientError ||
    error instanceof FeishuAppScopeMissingError ||
    error instanceof MissingFeishuRequesterError
  );
}
