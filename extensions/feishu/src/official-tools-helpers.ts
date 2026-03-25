import { Type, type TSchema } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  FeishuAppScopeMissingError,
  FeishuUatScopePolicyError,
  FeishuUserAuthRequiredError,
  FeishuUserScopeInsufficientError,
  MissingFeishuRequesterError,
} from "./official-auth/errors.js";
import {
  getFeishuAuthorizationSnapshot,
  startFeishuAuthorizationFlow,
} from "./official-auth/flow-manager.js";
import { jsonToolResult } from "./tool-result.js";
import type { ResolvedFeishuAccount } from "./types.js";

type LarkResult = { code?: number; msg?: string };
type FeishuToolContextLike = {
  messageChannel?: string;
  requesterSenderId?: string;
};

export function json(data: unknown) {
  return jsonToolResult(data);
}

export function StringEnum<TValues extends readonly string[]>(
  values: TValues,
  options?: { description?: string },
): TSchema {
  return Type.Unsafe<TValues[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description ? { description: options.description } : {}),
  });
}

export function assertLarkOk<T extends LarkResult>(result: T): asserts result is T & { code: 0 } {
  if (result.code !== 0) {
    throw new Error(result.msg ?? `Feishu API request failed with code=${String(result.code)}`);
  }
}

export function createFeishuToolLogger(api: OpenClawPluginApi, toolName: string) {
  const prefix = `${toolName}:`;
  return {
    info(message: string) {
      api.logger.info?.(`${prefix} ${message}`);
    },
    warn(message: string) {
      api.logger.warn?.(`${prefix} ${message}`);
    },
    error(message: string) {
      api.logger.error?.(`${prefix} ${message}`);
    },
    debug(message: string) {
      api.logger.debug?.(`${prefix} ${message}`);
    },
  };
}

export function resolveTrustedFeishuRequesterOpenId(
  ctx: FeishuToolContextLike,
): string | undefined {
  if (ctx.messageChannel !== "feishu") {
    return undefined;
  }
  const requesterOpenId = ctx.requesterSenderId?.trim();
  return requesterOpenId || undefined;
}

function resolveOpenPlatformAppScopesUrl(account: ResolvedFeishuAccount): string | undefined {
  if (!account.appId) {
    return undefined;
  }
  if (account.domain === "lark") {
    return `https://open.larksuite.com/app/${account.appId}/auth`;
  }
  if (account.domain === "feishu" || !account.domain) {
    return `https://open.feishu.cn/app/${account.appId}/auth`;
  }
  return undefined;
}

export async function handleFeishuAuthAwareError(params: {
  error: unknown;
  api: OpenClawPluginApi;
  account: ResolvedFeishuAccount;
  requesterOpenId?: string;
}): Promise<ReturnType<typeof json>> {
  const { error, api, account, requesterOpenId } = params;

  if (error instanceof MissingFeishuRequesterError) {
    return json({
      error: "feishu_requester_context_required",
      message: error.message,
    });
  }

  if (error instanceof FeishuUatScopePolicyError) {
    return json({
      error: "feishu_uat_scope_policy_blocked",
      requested_scopes: error.requestedScopes,
      message: error.message,
    });
  }

  if (error instanceof FeishuAppScopeMissingError) {
    return json({
      error: "feishu_app_scope_missing",
      app_id: account.appId,
      tool_action: error.toolAction,
      required_scopes: error.requiredScopes,
      permission_url: resolveOpenPlatformAppScopesUrl(account),
      message:
        "The Feishu app is missing required scopes in the Open Platform console. Enable the required scopes, then retry.",
    });
  }

  if (error instanceof FeishuUserAuthRequiredError) {
    const authorization = await startFeishuAuthorizationFlow({
      account,
      userOpenId: requesterOpenId ?? error.userOpenId,
      requestedScopes: error.requiredScopes,
      logger: api.logger,
    });
    return json({
      error: "feishu_user_authorization_required",
      tool_action: error.toolAction,
      required_scopes: error.requiredScopes,
      authorization,
      message: authorization.message,
    });
  }

  if (error instanceof FeishuUserScopeInsufficientError) {
    const authorization = await startFeishuAuthorizationFlow({
      account,
      userOpenId: requesterOpenId ?? error.userOpenId,
      requestedScopes: error.missingScopes,
      logger: api.logger,
    });
    return json({
      error: "feishu_user_scope_insufficient",
      tool_action: error.toolAction,
      granted_scopes: error.grantedScopes,
      missing_scopes: error.missingScopes,
      authorization,
      message: authorization.message,
    });
  }

  return json({
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function describeFeishuAuthorizationStatus(params: {
  account: ResolvedFeishuAccount;
  userOpenId: string;
}) {
  return await getFeishuAuthorizationSnapshot(params);
}
