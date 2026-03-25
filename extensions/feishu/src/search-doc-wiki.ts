import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuOfficialToolClient } from "./official-auth/tool-client.js";
import { convertTimeRangeToTimestamps, unixTimestampToISO8601 } from "./official-time.js";
import {
  createFeishuToolLogger,
  handleFeishuAuthAwareError,
  json,
  resolveTrustedFeishuRequesterOpenId,
  StringEnum,
} from "./official-tools-helpers.js";
import { resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";

const TimeRangeSchema = Type.Object({
  start: Type.Optional(
    Type.String({
      description: "ISO 8601 / RFC 3339 start time",
    }),
  ),
  end: Type.Optional(
    Type.String({
      description: "ISO 8601 / RFC 3339 end time",
    }),
  ),
});

const SearchDocWikiSchema = Type.Object({
  action: StringEnum(["search"], { description: "search" }),
  query: Type.Optional(
    Type.String({
      description: "Search keyword. Omit or pass empty string for empty search.",
      maxLength: 50,
    }),
  ),
  filter: Type.Optional(
    Type.Object({
      creator_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      doc_types: Type.Optional(
        Type.Array(
          StringEnum([
            "DOC",
            "SHEET",
            "BITABLE",
            "MINDNOTE",
            "FILE",
            "WIKI",
            "DOCX",
            "FOLDER",
            "CATALOG",
            "SLIDES",
            "SHORTCUT",
          ]),
          { maxItems: 10 },
        ),
      ),
      only_title: Type.Optional(Type.Boolean()),
      open_time: Type.Optional(TimeRangeSchema),
      sort_type: Type.Optional(
        StringEnum(["DEFAULT_TYPE", "OPEN_TIME", "EDIT_TIME", "EDIT_TIME_ASC", "CREATE_TIME"]),
      ),
      create_time: Type.Optional(TimeRangeSchema),
    }),
  ),
  page_token: Type.Optional(Type.String()),
  page_size: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
});

type SearchDocWikiParams = {
  action: "search";
  query?: string;
  filter?: {
    creator_ids?: string[];
    doc_types?: string[];
    only_title?: boolean;
    open_time?: { start?: string; end?: string };
    sort_type?: string;
    create_time?: { start?: string; end?: string };
  };
  page_token?: string;
  page_size?: number;
  accountId?: string;
};

function normalizeTimeFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTimeFields(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith("_time")) {
      const iso = unixTimestampToISO8601(item as string | number | undefined);
      normalized[key] = iso ?? item;
      continue;
    }
    normalized[key] = normalizeTimeFields(item);
  }
  return normalized as T;
}

export function registerFeishuSearchDocWikiTool(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_search_doc_wiki: No Feishu accounts configured, skipping");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.search) {
    api.logger.debug?.("feishu_search_doc_wiki: Search tool disabled in config");
    return;
  }

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      const log = createFeishuToolLogger(api, "feishu_search_doc_wiki");
      return {
        name: "feishu_search_doc_wiki",
        label: "Feishu Search Doc Wiki",
        description: "Search Feishu documents and wiki content as the current Feishu user.",
        parameters: SearchDocWikiSchema,
        async execute(_toolCallId, params) {
          const p = params as SearchDocWikiParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            const filter = p.filter
              ? {
                  ...p.filter,
                  ...(p.filter.open_time
                    ? { open_time: convertTimeRangeToTimestamps(p.filter.open_time) }
                    : {}),
                  ...(p.filter.create_time
                    ? { create_time: convertTimeRangeToTimestamps(p.filter.create_time) }
                    : {}),
                }
              : undefined;

            log.info(
              `search query=${JSON.stringify(p.query ?? "")} page_size=${String(p.page_size ?? 15)}`,
            );

            const response = await client.invokeByPath<{
              code?: number;
              msg?: string;
              data?: Record<string, unknown>;
            }>("feishu_search_doc_wiki.search", "/open-apis/search/v2/doc_wiki/search", {
              method: "POST",
              as: "user",
              body: {
                query: p.query ?? "",
                page_size: p.page_size ?? 15,
                page_token: p.page_token,
                doc_filter: filter ?? {},
                wiki_filter: filter ?? {},
              },
              headers: {
                "Content-Type": "application/json; charset=utf-8",
              },
            });

            return json(normalizeTimeFields(response.data ?? response));
          } catch (error) {
            return await handleFeishuAuthAwareError({
              error,
              api,
              account: client.account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_search_doc_wiki" },
  );

  api.logger.info?.("feishu_search_doc_wiki: Registered feishu_search_doc_wiki");
}
