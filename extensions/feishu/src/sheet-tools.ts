import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuOfficialToolClient } from "./official-auth/tool-client.js";
import {
  assertLarkOk,
  handleFeishuAuthAwareError,
  json,
  resolveTrustedFeishuRequesterOpenId,
  StringEnum,
} from "./official-tools-helpers.js";
import { resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";

const MAX_READ_ROWS = 200;
const MAX_WRITE_ROWS = 5_000;
const MAX_WRITE_COLS = 100;
const EXPORT_POLL_INTERVAL_MS = 1_000;
const EXPORT_POLL_MAX_RETRIES = 30;

const SheetValueRenderOptionSchema = Type.Optional(
  StringEnum(["ToString", "FormattedValue", "Formula", "UnformattedValue"], {
    description: "单元格值渲染模式，默认 ToString",
  }),
);

const SheetSchema = Type.Object({
  action: StringEnum(["info", "read", "write", "append", "find", "create", "export"]),
  url: Type.Optional(Type.String()),
  spreadsheet_token: Type.Optional(Type.String()),
  range: Type.Optional(Type.String()),
  sheet_id: Type.Optional(Type.String()),
  value_render_option: SheetValueRenderOptionSchema,
  values: Type.Optional(Type.Array(Type.Array(Type.Unknown()))),
  find: Type.Optional(Type.String()),
  match_case: Type.Optional(Type.Boolean()),
  match_entire_cell: Type.Optional(Type.Boolean()),
  search_by_regex: Type.Optional(Type.Boolean()),
  include_formulas: Type.Optional(Type.Boolean()),
  title: Type.Optional(Type.String()),
  folder_token: Type.Optional(Type.String()),
  headers: Type.Optional(Type.Array(Type.String())),
  data: Type.Optional(Type.Array(Type.Array(Type.Unknown()))),
  file_extension: Type.Optional(StringEnum(["xlsx", "csv"])),
  output_path: Type.Optional(Type.String()),
});

type SheetParams = {
  action: "info" | "read" | "write" | "append" | "find" | "create" | "export";
  url?: string;
  spreadsheet_token?: string;
  range?: string;
  sheet_id?: string;
  value_render_option?: "ToString" | "FormattedValue" | "Formula" | "UnformattedValue";
  values?: unknown[][];
  find?: string;
  match_case?: boolean;
  match_entire_cell?: boolean;
  search_by_regex?: boolean;
  include_formulas?: boolean;
  title?: string;
  folder_token?: string;
  headers?: string[];
  data?: unknown[][];
  file_extension?: "xlsx" | "csv";
  output_path?: string;
  accountId?: string;
};

type ResolveTokenResult = {
  token: string;
  urlSheetId?: string;
};

const KNOWN_TOKEN_TYPES = new Set([
  "dox",
  "doc",
  "sht",
  "bas",
  "app",
  "sld",
  "bmn",
  "fld",
  "nod",
  "box",
  "jsn",
  "img",
  "isv",
  "wik",
  "wia",
  "wib",
  "wic",
  "wid",
  "wie",
  "dsb",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSheetUrl(url: string): { token: string; sheetId?: string } | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/(?:sheets|wiki)\/([^/?#]+)/);
    if (!match) {
      return null;
    }
    return {
      token: match[1],
      sheetId: parsed.searchParams.get("sheet") || undefined,
    };
  } catch {
    return null;
  }
}

function getTokenType(token: string): string | null {
  if (token.length >= 15) {
    const modernPrefix = token[4] + token[9] + token[14];
    if (KNOWN_TOKEN_TYPES.has(modernPrefix)) {
      return modernPrefix;
    }
  }
  if (token.length >= 3) {
    const legacyPrefix = token.slice(0, 3);
    if (KNOWN_TOKEN_TYPES.has(legacyPrefix)) {
      return legacyPrefix;
    }
  }
  return null;
}

function buildSpreadsheetUrl(
  client: ReturnType<typeof createFeishuOfficialToolClient>,
  token: string,
): string {
  const host = client.account.domain === "lark" ? "docs.larksuite.com" : "docs.feishu.cn";
  return `https://${host}/sheets/${token}`;
}

function colLetter(columnIndex: number): string {
  let value = columnIndex;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function flattenCellValue(cell: unknown): unknown {
  if (!Array.isArray(cell)) {
    return cell;
  }
  if (
    cell.length > 0 &&
    cell.every((segment) => segment && typeof segment === "object" && "text" in segment)
  ) {
    return cell
      .map((segment) => {
        const text = (segment as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return cell;
}

function flattenValues(values: unknown[][] | undefined): unknown[][] | undefined {
  return values?.map((row) => row.map((cell) => flattenCellValue(cell)));
}

function truncateRows(values: unknown[][] | undefined): {
  values: unknown[][] | undefined;
  truncated: boolean;
  total_rows: number;
} {
  if (!values) {
    return {
      values,
      truncated: false,
      total_rows: 0,
    };
  }
  if (values.length <= MAX_READ_ROWS) {
    return {
      values,
      truncated: false,
      total_rows: values.length,
    };
  }
  return {
    values: values.slice(0, MAX_READ_ROWS),
    truncated: true,
    total_rows: values.length,
  };
}

async function resolveSpreadsheetToken(
  params: Pick<SheetParams, "url" | "spreadsheet_token">,
  client: ReturnType<typeof createFeishuOfficialToolClient>,
): Promise<ResolveTokenResult> {
  let token = params.spreadsheet_token?.trim();
  let urlSheetId: string | undefined;

  if (!token) {
    if (!params.url) {
      throw new Error("url or spreadsheet_token is required");
    }
    const parsed = parseSheetUrl(params.url);
    if (!parsed) {
      throw new Error(`Failed to parse spreadsheet token from URL: ${params.url}`);
    }
    token = parsed.token;
    urlSheetId = parsed.sheetId;
  }

  if (getTokenType(token) === "wik") {
    const wikiToken = token;
    const wikiResponse = await client.invoke<{
      code?: number;
      msg?: string;
      data?: {
        node?: { obj_token?: string };
      };
    }>(
      "feishu_sheet.info",
      (sdk, opts) =>
        sdk.wiki.space.getNode({ params: { token: wikiToken, obj_type: "wiki" } }, opts),
      {
        as: "user",
      },
    );
    assertLarkOk(wikiResponse);
    const resolvedToken = wikiResponse.data?.node?.obj_token;
    if (!resolvedToken) {
      throw new Error(`Failed to resolve spreadsheet token from wiki token: ${token}`);
    }
    token = resolvedToken;
  }

  return { token, urlSheetId };
}

async function resolveRange(
  client: ReturnType<typeof createFeishuOfficialToolClient>,
  spreadsheetToken: string,
  range: string | undefined,
  sheetId: string | undefined,
  toolAction: string,
): Promise<string> {
  if (range) {
    if (range.includes("!")) {
      return range;
    }
    if (sheetId) {
      return `${sheetId}!${range}`;
    }
    const sheets = await querySpreadsheetSheets(client, spreadsheetToken, toolAction);
    const firstSheetId = sheets[0]?.sheet_id;
    if (!firstSheetId) {
      throw new Error("Spreadsheet has no worksheets");
    }
    return `${firstSheetId}!${range}`;
  }
  if (sheetId) {
    return sheetId;
  }

  const sheets = await querySpreadsheetSheets(client, spreadsheetToken, toolAction);
  const firstSheetId = sheets[0]?.sheet_id;
  if (!firstSheetId) {
    throw new Error("Spreadsheet has no worksheets");
  }
  return firstSheetId;
}

async function querySpreadsheetSheets(
  client: ReturnType<typeof createFeishuOfficialToolClient>,
  spreadsheetToken: string,
  toolAction: string,
) {
  const response = await client.invokeByPath<{
    code?: number;
    msg?: string;
    data?: {
      sheets?: Array<{
        sheet_id?: string;
        title?: string;
        index?: number;
        grid_properties?: {
          row_count?: number;
          column_count?: number;
          frozen_row_count?: number;
          frozen_column_count?: number;
        };
      }>;
    };
  }>(toolAction, `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`, {
    method: "GET",
    as: "user",
  });
  assertLarkOk(response);
  return response.data?.sheets ?? [];
}

async function downloadExportedFile(
  client: ReturnType<typeof createFeishuOfficialToolClient>,
  fileToken: string,
  outputPath: string,
): Promise<void> {
  const response = await client.invoke<{
    getReadableStream: () => AsyncIterable<Uint8Array>;
  }>(
    "feishu_sheet.export",
    (sdk, opts) => sdk.drive.exportTask.download({ path: { file_token: fileToken } }, opts),
    { as: "user" },
  );

  const chunks: Buffer[] = [];
  for await (const chunk of response.getReadableStream()) {
    chunks.push(Buffer.from(chunk));
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.concat(chunks));
}

export function registerFeishuOfficialSheetTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_sheet_tools: No Feishu accounts configured, skipping");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.sheets) {
    api.logger.debug?.("feishu_sheet_tools: Sheets tool disabled in config");
    return;
  }

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      return {
        name: "feishu_sheet",
        label: "Feishu Sheet",
        description: "以用户身份读取、写入、查找、创建和导出飞书电子表格。",
        parameters: SheetSchema,
        async execute(_toolCallId, params) {
          const p = params as SheetParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });

          try {
            switch (p.action) {
              case "info": {
                const { token } = await resolveSpreadsheetToken(p, client);
                const [spreadsheetResponse, sheetsResponse] = await Promise.all([
                  client.invokeByPath<{
                    code?: number;
                    msg?: string;
                    data?: {
                      spreadsheet?: { title?: string };
                    };
                  }>("feishu_sheet.info", `/open-apis/sheets/v3/spreadsheets/${token}`, {
                    method: "GET",
                    as: "user",
                  }),
                  querySpreadsheetSheets(client, token, "feishu_sheet.info"),
                ]);
                assertLarkOk(spreadsheetResponse);

                return json({
                  title: spreadsheetResponse.data?.spreadsheet?.title,
                  spreadsheet_token: token,
                  url: buildSpreadsheetUrl(client, token),
                  sheets: sheetsResponse.map((sheet) => ({
                    sheet_id: sheet.sheet_id,
                    title: sheet.title,
                    index: sheet.index,
                    row_count: sheet.grid_properties?.row_count,
                    column_count: sheet.grid_properties?.column_count,
                    frozen_row_count: sheet.grid_properties?.frozen_row_count,
                    frozen_column_count: sheet.grid_properties?.frozen_column_count,
                  })),
                });
              }
              case "read": {
                const { token, urlSheetId } = await resolveSpreadsheetToken(p, client);
                const range = await resolveRange(
                  client,
                  token,
                  p.range,
                  p.sheet_id ?? urlSheetId,
                  "feishu_sheet.read",
                );
                const response = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: {
                    valueRange?: {
                      range?: string;
                      values?: unknown[][];
                    };
                  };
                }>(
                  "feishu_sheet.read",
                  `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(range)}`,
                  {
                    method: "GET",
                    query: {
                      valueRenderOption: p.value_render_option ?? "ToString",
                      dateTimeRenderOption: "FormattedString",
                    },
                    as: "user",
                  },
                );
                assertLarkOk(response);
                const truncated = truncateRows(flattenValues(response.data?.valueRange?.values));
                return json({
                  range: response.data?.valueRange?.range,
                  values: truncated.values,
                  ...(truncated.truncated
                    ? {
                        truncated: true,
                        total_rows: truncated.total_rows,
                        hint: `Data exceeds ${MAX_READ_ROWS} rows and was truncated. Narrow the range and retry if needed.`,
                      }
                    : {}),
                });
              }
              case "write": {
                if (!p.values) {
                  return json({ error: "values is required for action=write" });
                }
                if (p.values.length > MAX_WRITE_ROWS) {
                  return json({ error: `Row count exceeds limit ${MAX_WRITE_ROWS}` });
                }
                if (p.values.some((row) => row.length > MAX_WRITE_COLS)) {
                  return json({ error: `Column count exceeds limit ${MAX_WRITE_COLS}` });
                }
                const { token, urlSheetId } = await resolveSpreadsheetToken(p, client);
                const range = await resolveRange(
                  client,
                  token,
                  p.range,
                  p.sheet_id ?? urlSheetId,
                  "feishu_sheet.write",
                );
                const response = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: {
                    updatedRange?: string;
                    updatedRows?: number;
                    updatedColumns?: number;
                    updatedCells?: number;
                    revision?: number;
                  };
                }>("feishu_sheet.write", `/open-apis/sheets/v2/spreadsheets/${token}/values`, {
                  method: "PUT",
                  body: {
                    valueRange: {
                      range,
                      values: p.values,
                    },
                  },
                  as: "user",
                });
                assertLarkOk(response);
                return json({
                  updated_range: response.data?.updatedRange,
                  updated_rows: response.data?.updatedRows,
                  updated_columns: response.data?.updatedColumns,
                  updated_cells: response.data?.updatedCells,
                  revision: response.data?.revision,
                });
              }
              case "append": {
                if (!p.values) {
                  return json({ error: "values is required for action=append" });
                }
                if (p.values.length > MAX_WRITE_ROWS) {
                  return json({ error: `Row count exceeds limit ${MAX_WRITE_ROWS}` });
                }
                const { token, urlSheetId } = await resolveSpreadsheetToken(p, client);
                const range = await resolveRange(
                  client,
                  token,
                  p.range,
                  p.sheet_id ?? urlSheetId,
                  "feishu_sheet.append",
                );
                const response = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: {
                    tableRange?: string;
                    updates?: {
                      updatedRange?: string;
                      updatedRows?: number;
                      updatedColumns?: number;
                      updatedCells?: number;
                      revision?: number;
                    };
                  };
                }>(
                  "feishu_sheet.append",
                  `/open-apis/sheets/v2/spreadsheets/${token}/values_append`,
                  {
                    method: "POST",
                    body: {
                      valueRange: {
                        range,
                        values: p.values,
                      },
                    },
                    as: "user",
                  },
                );
                assertLarkOk(response);
                return json({
                  table_range: response.data?.tableRange,
                  updated_range: response.data?.updates?.updatedRange,
                  updated_rows: response.data?.updates?.updatedRows,
                  updated_columns: response.data?.updates?.updatedColumns,
                  updated_cells: response.data?.updates?.updatedCells,
                  revision: response.data?.updates?.revision,
                });
              }
              case "find": {
                if (!p.find || !p.sheet_id) {
                  return json({ error: "find and sheet_id are required for action=find" });
                }
                const find = p.find;
                const sheetId = p.sheet_id;
                const { token } = await resolveSpreadsheetToken(p, client);
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    find_result?: {
                      matched_cells?: unknown[];
                      matched_formula_cells?: unknown[];
                      rows_count?: number;
                    };
                  };
                }>(
                  "feishu_sheet.find",
                  (sdk, opts) =>
                    sdk.sheets.spreadsheetSheet.find(
                      {
                        path: {
                          spreadsheet_token: token,
                          sheet_id: sheetId,
                        },
                        data: {
                          find,
                          find_condition: {
                            range: p.range ? `${sheetId}!${p.range}` : sheetId,
                            ...(p.match_case !== undefined ? { match_case: !p.match_case } : {}),
                            ...(p.match_entire_cell !== undefined
                              ? { match_entire_cell: p.match_entire_cell }
                              : {}),
                            ...(p.search_by_regex !== undefined
                              ? { search_by_regex: p.search_by_regex }
                              : {}),
                            ...(p.include_formulas !== undefined
                              ? { include_formulas: p.include_formulas }
                              : {}),
                          },
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  matched_cells: response.data?.find_result?.matched_cells ?? [],
                  matched_formula_cells: response.data?.find_result?.matched_formula_cells ?? [],
                  rows_count: response.data?.find_result?.rows_count,
                });
              }
              case "create": {
                if (!p.title) {
                  return json({ error: "title is required for action=create" });
                }
                const title = p.title;
                const createResponse = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: {
                    spreadsheet?: {
                      spreadsheet_token?: string;
                    };
                  };
                }>("feishu_sheet.create", "/open-apis/sheets/v3/spreadsheets", {
                  method: "POST",
                  body: {
                    title,
                    folder_token: p.folder_token,
                  },
                  as: "user",
                });
                assertLarkOk(createResponse);
                const token = createResponse.data?.spreadsheet?.spreadsheet_token;
                if (!token) {
                  throw new Error("Failed to create spreadsheet: no spreadsheet_token returned");
                }

                const rows: unknown[][] = [];
                if (p.headers?.length) {
                  rows.push(p.headers);
                }
                if (p.data?.length) {
                  rows.push(...p.data);
                }
                if (rows.length > 0) {
                  const sheets = await querySpreadsheetSheets(client, token, "feishu_sheet.create");
                  const sheetId = sheets[0]?.sheet_id;
                  if (sheetId) {
                    const columnCount = Math.max(...rows.map((row) => row.length), 1);
                    const range = `${sheetId}!A1:${colLetter(columnCount)}${rows.length}`;
                    const writeResponse = await client.invokeByPath<{
                      code?: number;
                      msg?: string;
                    }>("feishu_sheet.create", `/open-apis/sheets/v2/spreadsheets/${token}/values`, {
                      method: "PUT",
                      body: {
                        valueRange: {
                          range,
                          values: rows,
                        },
                      },
                      as: "user",
                    });
                    assertLarkOk(writeResponse);
                  }
                }

                return json({
                  spreadsheet_token: token,
                  title,
                  url: buildSpreadsheetUrl(client, token),
                });
              }
              case "export": {
                if (!p.file_extension) {
                  return json({ error: "file_extension is required for action=export" });
                }
                const fileExtension = p.file_extension;
                if (fileExtension === "csv" && !p.sheet_id) {
                  return json({
                    error: "sheet_id is required when exporting csv",
                  });
                }
                const { token } = await resolveSpreadsheetToken(p, client);
                const createResponse = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    ticket?: string;
                  };
                }>(
                  "feishu_sheet.export",
                  (sdk, opts) =>
                    sdk.drive.exportTask.create(
                      {
                        data: {
                          file_extension: fileExtension,
                          token,
                          type: "sheet",
                          sub_id: p.sheet_id,
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(createResponse);
                const ticket = createResponse.data?.ticket;
                if (!ticket) {
                  throw new Error("Failed to create export task: no ticket returned");
                }

                let fileToken: string | undefined;
                let fileName: string | undefined;
                let fileSize: number | undefined;

                for (let attempt = 0; attempt < EXPORT_POLL_MAX_RETRIES; attempt += 1) {
                  await sleep(EXPORT_POLL_INTERVAL_MS);
                  const pollResponse: {
                    code?: number;
                    msg?: string;
                    data?: {
                      result?: {
                        job_status?: number;
                        job_error_msg?: string;
                        file_token?: string;
                        file_name?: string;
                        file_size?: number;
                      };
                    };
                  } = await client.invoke<{
                    code?: number;
                    msg?: string;
                    data?: {
                      result?: {
                        job_status?: number;
                        job_error_msg?: string;
                        file_token?: string;
                        file_name?: string;
                        file_size?: number;
                      };
                    };
                  }>(
                    "feishu_sheet.export",
                    (sdk, opts) =>
                      sdk.drive.exportTask.get(
                        {
                          path: { ticket },
                          params: { token },
                        },
                        opts,
                      ),
                    { as: "user" },
                  );
                  assertLarkOk(pollResponse);

                  const result:
                    | {
                        job_status?: number;
                        job_error_msg?: string;
                        file_token?: string;
                        file_name?: string;
                        file_size?: number;
                      }
                    | undefined = pollResponse.data?.result;
                  if (result?.job_status === 0) {
                    fileToken = result.file_token;
                    fileName = result.file_name;
                    fileSize = result.file_size;
                    break;
                  }
                  if (result?.job_status !== undefined && result.job_status >= 3) {
                    throw new Error(
                      result.job_error_msg || `Export failed with status ${result.job_status}`,
                    );
                  }
                }

                if (!fileToken) {
                  throw new Error("Export timed out");
                }

                if (p.output_path) {
                  await downloadExportedFile(client, fileToken, p.output_path);
                  return json({
                    file_path: p.output_path,
                    file_name: fileName,
                    file_size: fileSize,
                  });
                }

                return json({
                  file_token: fileToken,
                  file_name: fileName,
                  file_size: fileSize,
                  hint: "Provide output_path if you want the exported file downloaded locally.",
                });
              }
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
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
    { name: "feishu_sheet" },
  );

  api.logger.info?.("feishu_sheet_tools: Registered feishu_sheet");
}
