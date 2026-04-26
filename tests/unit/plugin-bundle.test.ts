import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");

describe("plugin bundle manifest", () => {
  test("keeps the desktop SVG source in the repo but excludes it from installed plugin context", () => {
    const svgPath = path.join(repoRoot, "assets", "desktop", "codex_wechat_desktop_round.svg");
    const manifestPath = path.join(repoRoot, "scripts", "plugin-bundle.json");
    const pluginManifestPath = path.join(repoRoot, ".codex-plugin", "plugin.json");

    expect(fs.existsSync(svgPath)).toBe(true);

    const bundle = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      excludeFiles?: string[];
      staleInstallDirectories?: string[];
    };
    const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8")) as {
      interface?: {
        composerIcon?: string;
        logo?: string;
      };
    };

    expect(bundle.excludeFiles).toContain("assets/desktop/codex_wechat_desktop_round.svg");
    expect(bundle.staleInstallDirectories).toContain("artifacts");
    expect(bundle.staleInstallDirectories).not.toContain("state");
    expect(pluginManifest.interface?.composerIcon).not.toMatch(/\.svg$/i);
    expect(pluginManifest.interface?.logo).not.toMatch(/\.svg$/i);
  });

  test("keeps discovery text compact without removing safety-critical skill rules", () => {
    const pluginManifestPath = path.join(repoRoot, ".codex-plugin", "plugin.json");
    const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8")) as {
      description?: string;
      interface?: {
        defaultPrompt?: string[];
        shortDescription?: string;
        longDescription?: string;
      };
    };
    const skillPaths = [
      path.join(repoRoot, "skills", "deliver-file", "SKILL.md"),
      path.join(repoRoot, "skills", "task-finished-notifier", "SKILL.md"),
      path.join(repoRoot, "skills", "wechat-bridge-ops", "SKILL.md"),
    ] as const;

    expect(pluginManifest.description?.length ?? 0).toBeLessThanOrEqual(70);
    expect(pluginManifest.interface?.shortDescription?.length ?? 0).toBeLessThanOrEqual(70);
    expect(pluginManifest.interface?.longDescription?.length ?? 0).toBeLessThanOrEqual(130);
    expect(pluginManifest.interface?.defaultPrompt ?? []).toHaveLength(1);
    expect((pluginManifest.interface?.defaultPrompt?.[0] ?? "").length).toBeLessThanOrEqual(90);

    for (const skillPath of skillPaths) {
      const raw = fs.readFileSync(skillPath, "utf8");
      const description = raw.match(/^description:\s*"([^"]+)"/m)?.[1] ?? "";
      expect(description.length).toBeLessThanOrEqual(95);
    }

    const deliverFile = fs.readFileSync(skillPaths[0], "utf8");
    const taskFinished = fs.readFileSync(skillPaths[1], "utf8");
    const ops = fs.readFileSync(skillPaths[2], "utf8");

    expect(deliverFile).toContain("Send nothing unless");
    expect(deliverFile).toContain("runtime database");
    expect(taskFinished).toContain("--payload-file");
    expect(taskFinished).toContain("<💡Task Finished>:");
    expect(ops).toContain("wechat_account_id + peer_user_id");
  });

  test("excludes generated type declarations from installed plugin payload", () => {
    const manifestPath = path.join(repoRoot, "scripts", "plugin-bundle.json");
    const bundle = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      excludeFiles?: string[];
    };

    expect(bundle.excludeFiles).toContain(
      "skills/task-finished-notifier/scripts/send_task_finished_notification.d.ts",
    );
  });
});
