import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";

const monitorFeishuProviderMock = vi.hoisted(() => vi.fn());
const setFeishuRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.js", () => ({
  monitorFeishuProvider: monitorFeishuProviderMock,
}));

vi.mock("./runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
  return {
    ...actual,
    setFeishuRuntime: setFeishuRuntimeMock,
  };
});

import { feishuPlugin } from "./channel.js";

function buildConfig(): OpenClawConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          main: {
            enabled: true,
            appId: "cli_main",
            appSecret: "secret_main",
            connectionMode: "websocket",
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("feishuPlugin gateway startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes the Feishu runtime before starting the monitor", async () => {
    const cfg = buildConfig();
    const pluginRuntime = { marker: "plugin-runtime" } as never;
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
    const abortSignal = new AbortController().signal;
    const account = feishuPlugin.config.resolveAccount(cfg, "main");

    monitorFeishuProviderMock.mockResolvedValueOnce(undefined);

    await feishuPlugin.gateway?.startAccount?.({
      cfg,
      accountId: "main",
      account,
      runtime,
      abortSignal,
      getStatus: () => ({ accountId: "main" }) as never,
      setStatus: vi.fn(),
      pluginRuntime,
    });

    expect(setFeishuRuntimeMock).toHaveBeenCalledWith(pluginRuntime);
    expect(monitorFeishuProviderMock).toHaveBeenCalledWith({
      config: cfg,
      runtime,
      abortSignal,
      accountId: "main",
    });
    expect(setFeishuRuntimeMock.mock.invocationCallOrder[0]).toBeLessThan(
      monitorFeishuProviderMock.mock.invocationCallOrder[0],
    );
  });
});
