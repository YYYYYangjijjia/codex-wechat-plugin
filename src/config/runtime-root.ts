import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "codex-wechat-bridge";

type RuntimeRootInput = {
  moduleUrl?: string | undefined;
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  homeDir?: string | undefined;
  existsSync?: ((filePath: string) => boolean) | undefined;
};

export function getInstalledPluginRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, ".codex", "plugins", PLUGIN_NAME);
}

export function resolveRuntimeRoot(input: RuntimeRootInput = {}): string {
  const env = input.env ?? process.env;
  const explicitRoot = env.WECHAT_BRIDGE_RUNTIME_ROOT?.trim();
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const cwd = path.resolve(input.cwd ?? process.cwd());
  const existsSync = input.existsSync ?? fs.existsSync;
  const installedRoot = getInstalledPluginRoot(input.homeDir);
  const modulePath = input.moduleUrl ? fileURLToPath(input.moduleUrl) : undefined;
  const inferredRoot = modulePath ? inferPackageRootFromModulePath(modulePath, existsSync) : undefined;

  if (
    modulePath
    && (isSubPath(modulePath, path.join(input.homeDir ?? os.homedir(), ".codex", "plugins", "cache", "local-personal-plugins", PLUGIN_NAME))
      || isSubPath(modulePath, installedRoot))
    && existsSync(path.join(installedRoot, "package.json"))
  ) {
    return installedRoot;
  }

  return inferredRoot ?? cwd;
}

function inferPackageRootFromModulePath(modulePath: string, existsSync: (filePath: string) => boolean): string | undefined {
  let current = path.dirname(modulePath);
  while (true) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isSubPath(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
