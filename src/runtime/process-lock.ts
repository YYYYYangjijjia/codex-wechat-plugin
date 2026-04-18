import fs from "node:fs/promises";
import path from "node:path";

export class ProcessLockAlreadyHeldError extends Error {
  public constructor(
    public readonly lockPath: string,
    public readonly pid?: number | undefined,
  ) {
    super(`Lock already held for ${lockPath}${typeof pid === "number" ? ` by pid ${pid}` : ""}.`);
    this.name = "ProcessLockAlreadyHeldError";
  }
}

type LockRecord = {
  pid?: number | undefined;
  acquiredAt?: string | undefined;
  purpose?: string | undefined;
};

export async function acquireProcessLock(input: {
  lockPath: string;
  pid?: number | undefined;
  purpose?: string | undefined;
  isPidAlive?: ((pid: number) => boolean) | undefined;
}): Promise<{ release: () => Promise<void> }> {
  const pid = input.pid ?? process.pid;
  const payload: LockRecord = {
    pid,
    acquiredAt: new Date().toISOString(),
    ...(input.purpose ? { purpose: input.purpose } : {}),
  };
  await fs.mkdir(path.dirname(input.lockPath), { recursive: true });
  const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;

  try {
    await writeLockFile(input.lockPath, payload);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    const existing = await readLockFile(input.lockPath);
    if (typeof existing?.pid === "number" && existing.pid !== pid && isPidAlive(existing.pid)) {
      throw new ProcessLockAlreadyHeldError(input.lockPath, existing.pid);
    }
    await fs.rm(input.lockPath, { force: true });
    await writeLockFile(input.lockPath, payload);
  }

  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      const current = await readLockFile(input.lockPath);
      if (current?.pid === pid) {
        await fs.rm(input.lockPath, { force: true });
      }
    },
  };
}

async function writeLockFile(lockPath: string, payload: LockRecord): Promise<void> {
  await fs.writeFile(lockPath, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });
}

async function readLockFile(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw) as LockRecord;
  } catch {
    return undefined;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EPERM";
  }
}
