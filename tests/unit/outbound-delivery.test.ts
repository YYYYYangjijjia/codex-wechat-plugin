import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveDeliveryCandidates } from "../../src/daemon/outbound-delivery.js";

describe("resolveDeliveryCandidates", () => {
  test("prefers an explicitly referenced absolute workspace path", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-delivery-"));
    const pdfPath = path.join(workspaceDir, "artifacts", "report.pdf");
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, "pdf");

    const result = resolveDeliveryCandidates({
      workspaceDir,
      finalMessage: `Finished. Output: ${pdfPath}`,
      requestedKinds: ["pdf"],
      taskStartedAtMs: Date.now() - 10_000,
    });

    expect(result).toEqual({
      status: "ready",
      files: [pdfPath],
      source: "final_message_path",
    });
  });

  test("accepts a referenced relative markdown link target inside the workspace", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-delivery-"));
    const zipPath = path.join(workspaceDir, "build", "bundle.zip");
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    fs.writeFileSync(zipPath, "zip");

    const result = resolveDeliveryCandidates({
      workspaceDir,
      finalMessage: "Created [bundle](./build/bundle.zip) for delivery.",
      requestedKinds: ["zip"],
      taskStartedAtMs: Date.now() - 10_000,
    });

    expect(result).toEqual({
      status: "ready",
      files: [zipPath],
      source: "final_message_path",
    });
  });

  test("falls back to exactly one recent matching file when no path is referenced", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-delivery-"));
    const txtPath = path.join(workspaceDir, "exports", "notes.txt");
    fs.mkdirSync(path.dirname(txtPath), { recursive: true });
    fs.writeFileSync(txtPath, "notes");

    const result = resolveDeliveryCandidates({
      workspaceDir,
      finalMessage: "Finished generating the notes file.",
      requestedKinds: ["text"],
      taskStartedAtMs: Date.now() - 10_000,
    });

    expect(result).toEqual({
      status: "ready",
      files: [txtPath],
      source: "recent_workspace_scan",
    });
  });

  test("refuses to guess when multiple recent candidates match", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-delivery-"));
    const firstPdf = path.join(workspaceDir, "exports", "a.pdf");
    const secondPdf = path.join(workspaceDir, "exports", "b.pdf");
    fs.mkdirSync(path.dirname(firstPdf), { recursive: true });
    fs.writeFileSync(firstPdf, "a");
    fs.writeFileSync(secondPdf, "b");

    const result = resolveDeliveryCandidates({
      workspaceDir,
      finalMessage: "Finished generating the requested files.",
      requestedKinds: ["pdf"],
      taskStartedAtMs: Date.now() - 10_000,
    });

    expect(result).toEqual({
      status: "ambiguous",
      candidates: [firstPdf, secondPdf],
      notice: expect.stringContaining("multiple candidate files"),
    });
  });

  test("excludes runtime and dependency directories from the scan", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-delivery-"));
    const excludedPdf = path.join(workspaceDir, "node_modules", "pkg", "ignored.pdf");
    fs.mkdirSync(path.dirname(excludedPdf), { recursive: true });
    fs.writeFileSync(excludedPdf, "ignore");

    const result = resolveDeliveryCandidates({
      workspaceDir,
      finalMessage: "Finished generating the requested file.",
      requestedKinds: ["pdf"],
      taskStartedAtMs: Date.now() - 10_000,
    });

    expect(result).toEqual({
      status: "none",
      notice: expect.stringContaining("No delivery candidate"),
    });
  });
});
