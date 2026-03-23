import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedFs = vi.hoisted(() => {
  const files = new Map<string, string>();
  let readDelayMs = 0;

  return {
    files,
    setReadDelay(ms: number) {
      readDelayMs = ms;
    },
    reset() {
      files.clear();
      readDelayMs = 0;
    },
    readFile: vi.fn(async (filePath: string) => {
      const normalizedPath = String(filePath);
      const snapshot = files.get(normalizedPath);
      if (readDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      }
      if (snapshot === undefined) {
        const error = new Error(`ENOENT: ${normalizedPath}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return snapshot;
    }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (filePath: string, content: string) => {
      files.set(String(filePath), String(content));
    }),
  };
});

const sendCardFeishuMock = vi.hoisted(() =>
  vi.fn(async ({ to }: { to: string }) => ({
    messageId: `msg:${to}`,
    chatId: to,
  })),
);
const updateCardFeishuMock = vi.hoisted(() =>
  vi.fn(async (_params?: { messageId: string }) => undefined),
);

vi.mock("fs/promises", () => ({
  default: {
    readFile: mockedFs.readFile,
    mkdir: mockedFs.mkdir,
    writeFile: mockedFs.writeFile,
  },
  readFile: mockedFs.readFile,
  mkdir: mockedFs.mkdir,
  writeFile: mockedFs.writeFile,
}));

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  updateCardFeishu: updateCardFeishuMock,
}));

vi.mock("./streaming-card.js", () => ({
  mergeStreamingText: (previousText: string | undefined, nextText: string | undefined) => {
    const previous = typeof previousText === "string" ? previousText : "";
    const next = typeof nextText === "string" ? nextText : "";
    if (!next) {
      return previous;
    }
    if (!previous || next === previous) {
      return next;
    }
    if (next.startsWith(previous)) {
      return next;
    }
    if (previous.startsWith(next)) {
      return previous;
    }
    return `${previous}${next}`;
  },
}));

const persistenceFilePath = path.join(os.homedir(), ".openclaw", "feishu-progress-cards.json");

async function importProgressCardModule() {
  vi.resetModules();
  return import("./progress-card.js");
}

describe("progress card persistence", () => {
  beforeEach(() => {
    mockedFs.reset();
    mockedFs.readFile.mockClear();
    mockedFs.mkdir.mockClear();
    mockedFs.writeFile.mockClear();
    sendCardFeishuMock.mockClear();
    updateCardFeishuMock.mockReset();
    updateCardFeishuMock.mockResolvedValue(undefined);
  });

  it("serializes concurrent persistence updates from multiple sessions", async () => {
    mockedFs.setReadDelay(1);
    const { persistFeishuProgressCardStateForTests, resetFeishuProgressCardStateForTests } =
      await importProgressCardModule();
    resetFeishuProgressCardStateForTests();

    await Promise.all([
      persistFeishuProgressCardStateForTests({
        messageId: "msg:oc_chat_a",
        chatId: "oc_chat_a",
        accountId: "main",
        stage: "tool",
        startedAt: 1,
      }),
      persistFeishuProgressCardStateForTests({
        messageId: "msg:oc_chat_b",
        chatId: "oc_chat_b",
        accountId: "main",
        stage: "tool",
        startedAt: 2,
      }),
    ]);

    const persisted = mockedFs.files.get(persistenceFilePath);
    expect(persisted).toBeDefined();
    expect(JSON.parse(persisted!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: "msg:oc_chat_a", chatId: "oc_chat_a" }),
        expect.objectContaining({ messageId: "msg:oc_chat_b", chatId: "oc_chat_b" }),
      ]),
    );
    expect(JSON.parse(persisted!)).toHaveLength(2);
  });

  it("keeps failed recovery entries persisted for the next startup", async () => {
    mockedFs.files.set(
      persistenceFilePath,
      JSON.stringify(
        [
          {
            messageId: "msg:keep",
            chatId: "oc_chat_keep",
            accountId: "main",
            stage: "thinking",
            startedAt: 1,
          },
          {
            messageId: "msg:drop",
            chatId: "oc_chat_drop",
            accountId: "main",
            stage: "tool",
            startedAt: 2,
          },
        ],
        null,
        2,
      ),
    );

    updateCardFeishuMock.mockImplementation(async (params?: { messageId: string }) => {
      const messageId = params?.messageId;
      if (messageId === "msg:keep") {
        throw new Error("temporary Feishu API error");
      }
    });

    const { recoverInterruptedProgressCards, resetFeishuProgressCardStateForTests } =
      await importProgressCardModule();
    resetFeishuProgressCardStateForTests();

    await recoverInterruptedProgressCards({
      cfg: {} as never,
      accountId: "main",
      logger: vi.fn(),
    });

    const persisted = mockedFs.files.get(persistenceFilePath);
    expect(persisted).toBeDefined();
    expect(JSON.parse(persisted!)).toEqual([
      expect.objectContaining({
        messageId: "msg:keep",
        chatId: "oc_chat_keep",
        accountId: "main",
        stage: "thinking",
      }),
    ]);
  });
});
