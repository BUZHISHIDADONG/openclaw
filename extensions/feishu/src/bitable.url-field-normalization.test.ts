import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerFeishuBitableTools } from "./bitable.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const mocks = vi.hoisted(() => {
  const appTableFieldList = vi.fn();
  const appTableRecordUpdate = vi.fn();
  const appTableRecordCreate = vi.fn();

  const createFeishuClient = vi.fn(() => ({
    bitable: {
      appTableField: {
        list: appTableFieldList,
      },
      appTableRecord: {
        update: appTableRecordUpdate,
        create: appTableRecordCreate,
      },
    },
  }));

  return {
    appTableFieldList,
    appTableRecordUpdate,
    appTableRecordCreate,
    createFeishuClient,
  };
});

vi.mock("./client.js", () => ({
  // oxlint-disable-next-line typescript/no-explicit-any
  createFeishuClient: (account: any) => mocks.createFeishuClient(account),
}));

function createConfig(): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          a: {
            appId: "app-a",
            appSecret: "sec-a",
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

describe("feishu bitable URL field normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.appTableFieldList.mockResolvedValue({
      code: 0,
      data: {
        items: [{ field_name: "需求文档URL", type: 15 }],
      },
    });

    mocks.appTableRecordUpdate.mockResolvedValue({
      code: 0,
      data: {
        record: { id: "rec" },
      },
    });

    mocks.appTableRecordCreate.mockResolvedValue({
      code: 0,
      data: {
        record: { id: "rec" },
      },
    });
  });

  test("update_record accepts URL string and sends {link}", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_update_record", { agentAccountId: "a" });
    await tool.execute("call", {
      app_token: "app",
      table_id: "tbl",
      record_id: "rec",
      fields: {
        需求文档URL: "https://feishu.cn/docx/CLF1dBLaCo3JUkx2stGcKs3JnOd",
      },
    });

    expect(mocks.appTableRecordUpdate).toHaveBeenCalledTimes(1);
    const call = mocks.appTableRecordUpdate.mock.calls[0]?.[0];
    expect(call.data.fields.需求文档URL).toEqual({
      link: "https://feishu.cn/docx/CLF1dBLaCo3JUkx2stGcKs3JnOd",
    });
  });

  test("create_record accepts URL string and sends {link}", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_create_record", { agentAccountId: "a" });
    await tool.execute("call", {
      app_token: "app",
      table_id: "tbl",
      fields: {
        需求文档URL: "https://example.com/spec",
      },
    });

    expect(mocks.appTableRecordCreate).toHaveBeenCalledTimes(1);
    const call = mocks.appTableRecordCreate.mock.calls[0]?.[0];
    expect(call.data.fields.需求文档URL).toEqual({
      link: "https://example.com/spec",
    });
  });

  test("tool returns Lark error hint when API responds with URLFieldConvFail", async () => {
    mocks.appTableRecordUpdate.mockResolvedValue({
      code: 1254068,
      msg: "URLFieldConvFail",
    });

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const tool = resolveTool("feishu_bitable_update_record", { agentAccountId: "a" });
    const res = (await tool.execute("call", {
      app_token: "app",
      table_id: "tbl",
      record_id: "rec",
      fields: {
        需求文档URL: { link: "https://example.com" },
      },
    })) as { details?: Record<string, unknown> };

    expect(res.details?.code).toBe(1254068);
    expect(res.details?.hint).toMatch("URL 字段格式错误");
  });
});
