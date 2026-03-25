import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import {
  revokeFeishuAuthorizationFlow,
  startFeishuAuthorizationFlow,
} from "./official-auth/flow-manager.js";
import { getAllKnownFeishuBusinessScopes, parseScopeInput } from "./official-auth/scopes.js";
import {
  describeFeishuAuthorizationStatus,
  json,
  handleFeishuAuthAwareError,
  resolveTrustedFeishuRequesterOpenId,
  StringEnum,
} from "./official-tools-helpers.js";
import { resolveFeishuToolAccount, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";

const FeishuOAuthSchema = Type.Object({
  action: StringEnum(["authorize", "status", "revoke"], {
    description: "authorize | status | revoke",
  }),
  scope: Type.Optional(
    Type.String({
      description:
        "Space-separated scopes to authorize. Omit this when using action=status or action=revoke.",
    }),
  ),
});

const FeishuOAuthBatchSchema = Type.Object({});

type FeishuOAuthParams = {
  action: "authorize" | "status" | "revoke";
  scope?: string;
  accountId?: string;
};

function registerSingleOauthTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      return {
        name: "feishu_oauth",
        label: "Feishu OAuth",
        description: "Manage Feishu user OAuth authorization. Actions: authorize, status, revoke.",
        parameters: FeishuOAuthSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuOAuthParams;
          const account = resolveFeishuToolAccount({
            api,
            executeParams: p,
            defaultAccountId,
          });
          try {
            if (!requesterOpenId) {
              throw new Error(
                "feishu_oauth must be called from a Feishu conversation so the current requester can be identified.",
              );
            }

            switch (p.action) {
              case "authorize": {
                const requestedScopes = parseScopeInput(p.scope);
                if (requestedScopes.length === 0) {
                  return json({
                    error: "missing_scope",
                    message:
                      "authorize requires scope. Use feishu_oauth_batch_auth to authorize the full known business scope set, or let auto-auth trigger it for the failing tool.",
                  });
                }
                return json(
                  await startFeishuAuthorizationFlow({
                    account,
                    userOpenId: requesterOpenId,
                    requestedScopes,
                    logger: api.logger,
                  }),
                );
              }
              case "status":
                return json(
                  await describeFeishuAuthorizationStatus({
                    account,
                    userOpenId: requesterOpenId,
                  }),
                );
              case "revoke":
                await revokeFeishuAuthorizationFlow({
                  account,
                  userOpenId: requesterOpenId,
                });
                return json({
                  ok: true,
                  message: "Stored Feishu user authorization has been revoked.",
                });
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
          } catch (error) {
            return await handleFeishuAuthAwareError({
              error,
              api,
              account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_oauth" },
  );
}

function registerBatchOauthTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      return {
        name: "feishu_oauth_batch_auth",
        label: "Feishu OAuth Batch Authorization",
        description: "Authorize the known Feishu user-scope business tools in one Device Flow.",
        parameters: FeishuOAuthBatchSchema,
        async execute(_toolCallId, params) {
          const p = (params ?? {}) as { accountId?: string };
          const account = resolveFeishuToolAccount({
            api,
            executeParams: p,
            defaultAccountId,
          });
          try {
            if (!requesterOpenId) {
              throw new Error(
                "feishu_oauth_batch_auth must be called from a Feishu conversation so the current requester can be identified.",
              );
            }

            const requestedScopes = getAllKnownFeishuBusinessScopes(account.config.uat);
            return json(
              await startFeishuAuthorizationFlow({
                account,
                userOpenId: requesterOpenId,
                requestedScopes,
                logger: api.logger,
              }),
            );
          } catch (error) {
            return await handleFeishuAuthAwareError({
              error,
              api,
              account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_oauth_batch_auth" },
  );
}

export function registerFeishuOauthTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_oauth: No Feishu accounts configured, skipping OAuth tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.oauth) {
    api.logger.debug?.("feishu_oauth: OAuth tools disabled in config");
    return;
  }

  registerSingleOauthTool(api);
  registerBatchOauthTool(api);
  api.logger.info?.("feishu_oauth: Registered feishu_oauth and feishu_oauth_batch_auth");
}
