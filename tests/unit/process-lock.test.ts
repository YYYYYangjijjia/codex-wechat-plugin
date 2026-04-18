import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { acquireProcessLock, ProcessLockAlreadyHeldError } from "../../src/runtime/process-lock.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-bridge-lock-"));
  tempRoots.push(root);
  return root;
}

describe("process-lock", () => {
  test("acquires and releases a new lock", async () => {
    const root = await makeTempDir();
    const lockPath = path.join(root, "daemon.lock");

    const lock = await acquireProcessLock({ lockPath, pid: 1234, purpose: "daemon" });
    const contents = await fs.readFile(lockPath, "utf8");
    expect(contents).toContain("\"pid\": 1234");

    await lock.release();
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  test("rejects when another live process holds the lock", async () => {
    const root = await makeTempDir();
    const lockPath = path.join(root, "daemon.lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: 2222 }), "utf8");

    await expect(acquireProcessLock({
      lockPath,
      pid: 1234,
      isPidAlive: () => true,
    })).rejects.toEqual(new ProcessLockAlreadyHeldError(lockPath, 2222));
  });

  test("replaces a stale lock", async () => {
    const root = await makeTempDir();
    const lockPath = path.join(root, "daemon.lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: 2222 }), "utf8");

    const lock = await acquireProcessLock({
      lockPath,
      pid: 1234,
      isPidAlive: () => false,
    });

    const contents = await fs.readFile(lockPath, "utf8");
    expect(contents).toContain("\"pid\": 1234");
    await lock.release();
  });
});
