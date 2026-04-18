import fs from "node:fs";
import path from "node:path";

export type InstalledSkillsCatalog = {
  local: string[];
  plugin: string[];
};

export function listInstalledSkills(input?: {
  codexHomeDir?: string;
}): InstalledSkillsCatalog {
  const codexHomeDir = input?.codexHomeDir ?? resolveCodexHomeDir();
  if (!codexHomeDir) {
    return { local: [], plugin: [] };
  }

  return {
    local: scanLocalSkills(path.join(codexHomeDir, "skills")),
    plugin: scanPluginSkills(path.join(codexHomeDir, "plugins", "cache")),
  };
}

function resolveCodexHomeDir(): string | undefined {
  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    return path.join(userProfile, ".codex");
  }
  const home = process.env.HOME;
  if (home) {
    return path.join(home, ".codex");
  }
  return undefined;
}

function scanLocalSkills(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }
  const names = new Set<string>();
  for (const skillFile of findSkillFiles(skillsDir)) {
    names.add(path.basename(path.dirname(skillFile)));
  }
  return [...names].sort();
}

function scanPluginSkills(pluginCacheDir: string): string[] {
  if (!fs.existsSync(pluginCacheDir)) {
    return [];
  }
  const names = new Set<string>();
  for (const skillFile of findSkillFiles(pluginCacheDir)) {
    const parts = skillFile.split(path.sep);
    const cacheIndex = parts.findIndex((part) => part === "cache");
    const skillsIndex = parts.findIndex((part) => part === "skills");
    if (cacheIndex === -1 || skillsIndex === -1 || skillsIndex + 1 >= parts.length - 1) {
      continue;
    }
    const pluginName = parts[cacheIndex + 2];
    const skillName = parts[skillsIndex + 1];
    if (!pluginName || !skillName) {
      continue;
    }
    names.add(`${pluginName}:${skillName}`);
  }
  return [...names].sort();
}

function findSkillFiles(rootDir: string): string[] {
  const results: string[] = [];
  walk(rootDir, results);
  return results;
}

function walk(currentDir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, results);
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      results.push(fullPath);
    }
  }
}
