import { execFile as execFileCb } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type StoredFeishuUatToken = {
  userOpenId: string;
  appId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
  grantedAt: number;
};

const KEYCHAIN_SERVICE = "openclaw-feishu-uat";
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

type TokenBackend = {
  get: (service: string, account: string) => Promise<string | null>;
  set: (service: string, account: string, value: string) => Promise<void>;
  remove: (service: string, account: string) => Promise<void>;
};

function tokenAccountKey(appId: string, userOpenId: string): string {
  return `${appId}:${userOpenId}`;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc";
}

const darwinBackend: TokenBackend = {
  async get(service, account) {
    try {
      const { stdout } = await execFile("security", [
        "find-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  },

  async set(service, account, value) {
    try {
      await execFile("security", ["delete-generic-password", "-s", service, "-a", account]);
    } catch {
      // noop
    }
    await execFile("security", ["add-generic-password", "-s", service, "-a", account, "-w", value]);
  },

  async remove(service, account) {
    try {
      await execFile("security", ["delete-generic-password", "-s", service, "-a", account]);
    } catch {
      // noop
    }
  },
};

const linuxStoreDir = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  KEYCHAIN_SERVICE,
);
const linuxMasterKeyPath = join(linuxStoreDir, "master.key");

const win32StoreDir = join(
  process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? homedir(), "AppData", "Local"),
  KEYCHAIN_SERVICE,
);
const win32MasterKeyPath = join(win32StoreDir, "master.key");

async function ensureSecureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

async function getOrCreateMasterKey(filePath: string, dir: string): Promise<Buffer> {
  try {
    const key = await readFile(filePath);
    if (key.length === MASTER_KEY_BYTES) {
      return key;
    }
  } catch {
    // noop
  }

  await ensureSecureDir(dir);
  const key = randomBytes(MASTER_KEY_BYTES);
  await writeFile(filePath, key, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return key;
}

function encryptValue(plainText: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptValue(value: Buffer, key: Buffer): string | null {
  if (value.length < IV_BYTES + TAG_BYTES) {
    return null;
  }
  try {
    const iv = value.subarray(0, IV_BYTES);
    const authTag = value.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = value.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const linuxBackend: TokenBackend = {
  async get(_service, account) {
    try {
      const key = await getOrCreateMasterKey(linuxMasterKeyPath, linuxStoreDir);
      const encrypted = await readFile(join(linuxStoreDir, safeFileName(account)));
      return decryptValue(encrypted, key);
    } catch {
      return null;
    }
  },

  async set(_service, account, value) {
    const key = await getOrCreateMasterKey(linuxMasterKeyPath, linuxStoreDir);
    await ensureSecureDir(linuxStoreDir);
    const filePath = join(linuxStoreDir, safeFileName(account));
    const encrypted = encryptValue(value, key);
    await writeFile(filePath, encrypted, { mode: 0o600 });
    await chmod(filePath, 0o600);
  },

  async remove(_service, account) {
    try {
      await unlink(join(linuxStoreDir, safeFileName(account)));
    } catch {
      // noop
    }
  },
};

const win32Backend: TokenBackend = {
  async get(_service, account) {
    try {
      const key = await getOrCreateMasterKey(win32MasterKeyPath, win32StoreDir);
      const encrypted = await readFile(join(win32StoreDir, safeFileName(account)));
      return decryptValue(encrypted, key);
    } catch {
      return null;
    }
  },

  async set(_service, account, value) {
    const key = await getOrCreateMasterKey(win32MasterKeyPath, win32StoreDir);
    await ensureSecureDir(win32StoreDir);
    const filePath = join(win32StoreDir, safeFileName(account));
    const encrypted = encryptValue(value, key);
    await writeFile(filePath, encrypted);
  },

  async remove(_service, account) {
    try {
      await unlink(join(win32StoreDir, safeFileName(account)));
    } catch {
      // noop
    }
  },
};

function resolveTokenBackend(): TokenBackend {
  switch (process.platform) {
    case "darwin":
      return darwinBackend;
    case "win32":
      return win32Backend;
    default:
      return linuxBackend;
  }
}

function parseStoredToken(raw: string | null): StoredFeishuUatToken | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredFeishuUatToken;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.appId !== "string" ||
      typeof parsed.userOpenId !== "string" ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.refreshExpiresAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function getStoredFeishuToken(
  appId: string,
  userOpenId: string,
): Promise<StoredFeishuUatToken | null> {
  const backend = resolveTokenBackend();
  const raw = await backend.get(KEYCHAIN_SERVICE, tokenAccountKey(appId, userOpenId));
  return parseStoredToken(raw);
}

export async function setStoredFeishuToken(token: StoredFeishuUatToken): Promise<void> {
  const backend = resolveTokenBackend();
  await backend.set(
    KEYCHAIN_SERVICE,
    tokenAccountKey(token.appId, token.userOpenId),
    JSON.stringify(token),
  );
}

export async function removeStoredFeishuToken(appId: string, userOpenId: string): Promise<void> {
  const backend = resolveTokenBackend();
  await backend.remove(KEYCHAIN_SERVICE, tokenAccountKey(appId, userOpenId));
}

export function maskFeishuToken(token: string): string {
  if (token.length <= 8) {
    return "****";
  }
  return `****${token.slice(-4)}`;
}

export function getStoredFeishuTokenStatus(
  token: StoredFeishuUatToken,
): "valid" | "needs_refresh" | "expired" {
  const now = Date.now();
  if (now >= token.expiresAt) {
    return "expired";
  }
  if (token.expiresAt - now <= REFRESH_AHEAD_MS) {
    return "needs_refresh";
  }
  return "valid";
}
