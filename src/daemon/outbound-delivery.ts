import fs from "node:fs";
import path from "node:path";

import type { DeliveryKind } from "./delivery-intent.js";

type DeliveryReady = {
  status: "ready";
  files: string[];
  source: "final_message_path" | "recent_workspace_scan";
};

type DeliveryNone = {
  status: "none";
  notice: string;
};

type DeliveryAmbiguous = {
  status: "ambiguous";
  candidates: string[];
  notice: string;
};

export type DeliveryResolution = DeliveryReady | DeliveryNone | DeliveryAmbiguous;

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "state",
]);

const REQUESTED_KIND_EXTENSIONS: Record<DeliveryKind, string[]> = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"],
  pdf: [".pdf"],
  doc: [".doc", ".docx"],
  text: [".txt", ".md"],
  zip: [".zip"],
  file: [".pdf", ".doc", ".docx", ".txt", ".md", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"],
};

export function resolveDeliveryCandidates(input: {
  workspaceDir: string;
  finalMessage: string;
  requestedKinds: DeliveryKind[];
  taskStartedAtMs: number;
}): DeliveryResolution {
  const explicitPaths = extractReferencedPaths(input.finalMessage, input.workspaceDir)
    .filter((filePath) => isCandidateFile(filePath, input.workspaceDir, input.requestedKinds));

  if (explicitPaths.length > 0) {
    return {
      status: "ready",
      files: explicitPaths,
      source: "final_message_path",
    };
  }

  const scanned = listRecentWorkspaceFiles(input.workspaceDir, input.taskStartedAtMs)
    .filter((filePath) => isCandidateFile(filePath, input.workspaceDir, input.requestedKinds));

  if (scanned.length === 1) {
    return {
      status: "ready",
      files: scanned,
      source: "recent_workspace_scan",
    };
  }

  if (scanned.length > 1) {
    return {
      status: "ambiguous",
      candidates: scanned,
      notice: "Found multiple candidate files for delivery. Refusing to guess which one to send.",
    };
  }

  return {
    status: "none",
    notice: "No delivery candidate matched the requested file kind in the current workspace.",
  };
}

function extractReferencedPaths(finalMessage: string, workspaceDir: string): string[] {
  const candidates: string[] = [];

  for (const match of finalMessage.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const rawTarget = match[1]?.trim();
    const resolved = resolveCandidatePath(rawTarget, workspaceDir);
    if (resolved && !candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  }

  const pathPattern = /([A-Za-z]:[\\/][^\s`'"<>|]+|\.{0,2}[\\/][^\s`'"<>|]+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_. -]+)*\.[A-Za-z0-9]+)/g;
  for (const match of finalMessage.matchAll(pathPattern)) {
    const rawTarget = match[1]?.trim();
    const resolved = resolveCandidatePath(rawTarget, workspaceDir);
    if (resolved && !candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  }

  return candidates;
}

function resolveCandidatePath(rawTarget: string | undefined, workspaceDir: string): string | undefined {
  if (!rawTarget) {
    return undefined;
  }
  const trimmed = stripWrapping(rawTarget);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return undefined;
  }
  const resolved = path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.resolve(workspaceDir, trimmed);
  return fs.existsSync(resolved) ? resolved : undefined;
}

function stripWrapping(value: string): string {
  return value.replace(/^<|>$/g, "").replace(/^`|`$/g, "");
}

function listRecentWorkspaceFiles(workspaceDir: string, taskStartedAtMs: number): string[] {
  const results: string[] = [];
  visit(workspaceDir);
  return results.sort((left, right) => left.localeCompare(right));

  function visit(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (shouldExcludePath(fullPath, workspaceDir)) {
          continue;
        }
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (shouldExcludePath(fullPath, workspaceDir)) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= taskStartedAtMs) {
        results.push(fullPath);
      }
    }
  }
}

function isCandidateFile(filePath: string, workspaceDir: string, requestedKinds: DeliveryKind[]): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  if (shouldExcludePath(filePath, workspaceDir)) {
    return false;
  }
  if (!isInsideWorkspace(filePath, workspaceDir)) {
    return false;
  }
  const extension = path.extname(filePath).toLowerCase();
  return requestedKinds.some((kind) => REQUESTED_KIND_EXTENSIONS[kind]?.includes(extension));
}

function shouldExcludePath(targetPath: string, workspaceDir: string): boolean {
  if (!isInsideWorkspace(targetPath, workspaceDir)) {
    return true;
  }
  const relative = path.relative(workspaceDir, targetPath);
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.includes(".cache") && segments.includes("wechat-bridge")) {
    return true;
  }
  return segments.some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function isInsideWorkspace(targetPath: string, workspaceDir: string): boolean {
  const relative = path.relative(workspaceDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
