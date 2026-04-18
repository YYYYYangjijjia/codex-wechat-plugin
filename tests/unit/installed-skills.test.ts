import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { listInstalledSkills } from "../../src/commands/installed-skills.js";

const tempDirs: string[] = [];

function makeSkill(rootDir: string, relativePath: string): void {
  const skillDir = path.join(rootDir, relativePath);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${path.basename(skillDir)}\n`, "utf8");
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("listInstalledSkills", () => {
  test("collects local and plugin skills from the Codex home layout", () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skills-"));
    tempDirs.push(codexHomeDir);

    makeSkill(codexHomeDir, path.join("skills", "code-builder"));
    makeSkill(codexHomeDir, path.join("skills", "superpowers", "brainstorming"));
    makeSkill(codexHomeDir, path.join("plugins", "cache", "openai-curated", "gmail", "hash-1", "skills", "gmail"));
    makeSkill(codexHomeDir, path.join("plugins", "cache", "openai-curated", "google-calendar", "hash-2", "skills", "google-calendar"));

    expect(listInstalledSkills({ codexHomeDir })).toEqual({
      local: ["brainstorming", "code-builder"],
      plugin: ["gmail:gmail", "google-calendar:google-calendar"],
    });
  });
});
