import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuOfficialImTools } from "./im-tools.js";
import { registerFeishuOfficialSheetTools } from "./sheet-tools.js";
import { registerFeishuOfficialTaskTools } from "./task-tools.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const requestMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    request: requestMock,
  })),
);
const callWithFeishuUserAccessTokenMock = vi.hoisted(() =>
  vi.fn(async (params: { apiCall: (accessToken: string) => Promise<unknown> }) => {
    return await params.apiCall("uat-token");
  }),
);
const withUserAccessTokenMock = vi.hoisted(() => vi.fn((accessToken: string) => ({ accessToken })));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./official-auth/uat-client.js", () => ({
  callWithFeishuUserAccessToken: callWithFeishuUserAccessTokenMock,
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  withUserAccessToken: withUserAccessTokenMock,
}));

function createConfig(
  tools: NonNullable<
    NonNullable<NonNullable<OpenClawPluginApi["config"]>["channels"]>["feishu"]
  >["accounts"][string]["tools"],
): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          main: {
            appId: "app-main",
            appSecret: "sec-main", // pragma: allowlist secret
            tools,
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

const feishuCtx = {
  messageChannel: "feishu",
  requesterSenderId: "ou_requester",
} as const;

describe("feishu official REST routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestMock.mockReset();
    requestMock.mockImplementation(async (config: { url: string }) => {
      throw new Error(`Unexpected request: ${config.url}`);
    });
  });

  test("task read-side actions use direct REST endpoints", async () => {
    requestMock.mockImplementation(async (config: { url: string }) => {
      if (config.url.includes("/open-apis/task/v2/tasks/")) {
        if (config.url.endsWith("/subtasks")) {
          return { code: 0, data: { items: [], has_more: false, page_token: "" } };
        }
        return { code: 0, data: { task: { guid: "task/1" } } };
      }
      if (config.url === "/open-apis/task/v2/tasklists") {
        return { code: 0, data: { items: [], has_more: false, page_token: "" } };
      }
      if (config.url === "/open-apis/task/v2/comments") {
        return { code: 0, data: { items: [], has_more: false, page_token: "" } };
      }
      if (config.url.includes("/open-apis/task/v2/comments/")) {
        return { code: 0, data: { comment: { id: "comment/1" } } };
      }
      throw new Error(`Unexpected request: ${config.url}`);
    });

    const { api, resolveTool } = createToolFactoryHarness(createConfig({ task: true }));
    registerFeishuOfficialTaskTools(api);

    const taskTool = resolveTool("feishu_task_task", feishuCtx);
    await taskTool.execute("call-task-get", {
      action: "get",
      task_guid: "task/1",
    });

    const tasklistTool = resolveTool("feishu_task_tasklist", feishuCtx);
    await tasklistTool.execute("call-tasklist-list", {
      action: "list",
      page_size: 5,
    });

    const commentTool = resolveTool("feishu_task_comment", feishuCtx);
    await commentTool.execute("call-comment-get", {
      action: "get",
      comment_id: "comment/1",
    });
    await commentTool.execute("call-comment-list", {
      action: "list",
      resource_id: "task/1",
      page_size: 5,
      direction: "desc",
    });

    const subtaskTool = resolveTool("feishu_task_subtask", feishuCtx);
    await subtaskTool.execute("call-subtask-list", {
      action: "list",
      task_guid: "task/1",
      page_size: 5,
    });

    const urls = requestMock.mock.calls.map((call) => (call[0] as { url: string }).url);
    expect(urls).toEqual([
      "/open-apis/task/v2/tasks/task%2F1",
      "/open-apis/task/v2/tasklists",
      "/open-apis/task/v2/comments/comment%2F1",
      "/open-apis/task/v2/comments",
      "/open-apis/task/v2/tasks/task%2F1/subtasks",
    ]);

    expect(requestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      params: { user_id_type: "open_id" },
    });
    expect(requestMock.mock.calls[1]?.[0]).toMatchObject({
      method: "GET",
      params: { page_size: 5, user_id_type: "open_id" },
    });
    expect(requestMock.mock.calls[3]?.[0]).toMatchObject({
      method: "GET",
      params: {
        direction: "desc",
        page_size: 5,
        resource_id: "task/1",
        resource_type: "task",
        user_id_type: "open_id",
      },
    });
  });

  test("sheet read auto-prefixes the first sheet id for bare ranges", async () => {
    requestMock.mockImplementation(async (config: { url: string }) => {
      if (config.url === "/open-apis/sheets/v3/spreadsheets/sht-token/sheets/query") {
        return {
          code: 0,
          data: {
            sheets: [{ sheet_id: "220d8b", title: "Sheet1" }],
          },
        };
      }
      if (config.url === "/open-apis/sheets/v2/spreadsheets/sht-token/values/220d8b!A1%3AB2") {
        return {
          code: 0,
          data: {
            valueRange: {
              range: "220d8b!A1:B2",
              values: [["col1"], ["v1"]],
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${config.url}`);
    });

    const { api, resolveTool } = createToolFactoryHarness(createConfig({ sheets: true }));
    registerFeishuOfficialSheetTools(api);

    const tool = resolveTool("feishu_sheet", feishuCtx);
    const result = (await tool.execute("call-sheet-read", {
      action: "read",
      spreadsheet_token: "sht-token",
      range: "A1:B2",
    })) as { details: { range: string; values: unknown[][] } };

    expect(result.details).toEqual({
      range: "220d8b!A1:B2",
      values: [["col1"], ["v1"]],
    });
    expect(requestMock.mock.calls.map((call) => (call[0] as { url: string }).url)).toEqual([
      "/open-apis/sheets/v3/spreadsheets/sht-token/sheets/query",
      "/open-apis/sheets/v2/spreadsheets/sht-token/values/220d8b!A1%3AB2",
    ]);
  });

  test("im history and thread history use direct REST message listing", async () => {
    requestMock.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_1",
            chat_id: "oc_chat",
            msg_type: "text",
            body: { content: '{"text":"hello"}' },
            create_time: "1774400000000",
          },
        ],
        has_more: false,
        page_token: "",
      },
    });

    const { api, resolveTool } = createToolFactoryHarness(createConfig({ im: true }));
    registerFeishuOfficialImTools(api);

    const historyTool = resolveTool("feishu_im_user_get_messages", feishuCtx);
    await historyTool.execute("call-im-history", {
      chat_id: "oc_chat",
      page_size: 3,
      sort_rule: "create_time_desc",
    });

    const threadTool = resolveTool("feishu_im_user_get_thread_messages", feishuCtx);
    await threadTool.execute("call-im-thread", {
      thread_id: "omt_thread",
      page_size: 2,
      sort_rule: "create_time_asc",
    });

    expect(requestMock.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/im/v1/messages",
        params: expect.objectContaining({
          container_id_type: "chat",
          container_id: "oc_chat",
          page_size: 3,
          sort_type: "ByCreateTimeDesc",
          card_msg_content_type: "raw_card_content",
        }),
      }),
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/im/v1/messages",
        params: expect.objectContaining({
          container_id_type: "thread",
          container_id: "omt_thread",
          page_size: 2,
          sort_type: "ByCreateTimeAsc",
          card_msg_content_type: "raw_card_content",
        }),
      }),
    ]);
  });
});
