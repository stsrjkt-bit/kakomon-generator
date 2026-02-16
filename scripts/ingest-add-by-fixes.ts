#!/usr/bin/env tsx
/**
 * Ingest "add" fixes (download official PDFs -> upload to R2 -> upsert kakomon_documents).
 *
 * This is a deterministic alternative to kakomon-collector for this repo.
 *
 * Usage:
 *   bash -lc 'set -a; source .env; set +a; npx -y tsx@4.19.0 scripts/ingest-add-by-fixes.ts --add-fixes path/to/fixes-add.json --dry-run'
 *   bash -lc 'set -a; source .env; set +a; npx -y tsx@4.19.0 scripts/ingest-add-by-fixes.ts --add-fixes path/to/fixes-add.json --force'
 */

import { readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import net from "net";
import { createClient } from "@supabase/supabase-js";
import { uploadToR2 } from "../src/lib/r2";

type FixEntry = {
  url: string;
  university_id: string;
  year: number;
  subject_id: string;
  subject_variant: string | null;
  subject_raw: string;
  subject_display: string;
  exam_type: string;
  exam_variant: string | null;
  exam_type_raw: string;
  content_type: "problem" | "answer";
  is_bundled: boolean;
  bundled_subjects: string[] | null;
  action: "add" | "split";
  r2_path: string;
};

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

function isPrivateOrLocalhost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const ipType = net.isIP(h);
  if (ipType === 4) {
    const parts = h.split(".").map((x) => parseInt(x, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (ipType === 6) {
    if (h === "::1") return true;
    if (h.startsWith("fe80:")) return true;
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
    return false;
  }
  return false;
}

function validateHttpUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`URL must be http(s): ${input}`);
  if (u.username || u.password) throw new Error(`URL must not include credentials: ${input}`);
  if (isPrivateOrLocalhost(u.hostname)) throw new Error(`Refusing localhost/private host URL: ${input}`);
  return u;
}

function expectedR2Path(params: {
  university_id: string;
  year: number;
  subject_id: string;
  subject_variant: string | null;
  exam_type: string;
  exam_variant: string | null;
  content_type: "problem" | "answer";
}): string {
  const subjectPart = params.subject_variant ? `${params.subject_id}_${params.subject_variant}` : params.subject_id;
  const examPart = params.exam_variant ? `${params.exam_type}_${params.exam_variant}` : params.exam_type;
  return `${params.university_id}/${params.year}/${subjectPart}/${examPart}/${params.content_type}.pdf`;
}

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim();
    throw new Error(`${cmd} failed: ${cmd} ${args.join(" ")}\n${msg}`);
  }
  return r.stdout;
}

async function main() {
  const addPath = getArg("--add-fixes");
  if (!addPath) {
    console.error("Error: --add-fixes is required");
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  if (!dryRun && !force) {
    console.error("Refusing to run LIVE without --force (use --dry-run first)");
    process.exit(1);
  }

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }
  const supabase = createClient(sbUrl, sbKey);

  const add = JSON.parse(readFileSync(addPath, "utf8")) as FixEntry[];
  const entries = add.filter((e) => e.action === "add");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Fixes: ${addPath}`);
  console.log(`Entries: ${entries.length}`);

  // Uniqueness + path guard
  const keys = new Set<string>();
  for (const e of entries) {
    validateHttpUrl(e.url);
    const exp = expectedR2Path({
      university_id: e.university_id,
      year: e.year,
      subject_id: e.subject_id,
      subject_variant: e.subject_variant,
      exam_type: e.exam_type,
      exam_variant: e.exam_variant,
      content_type: e.content_type,
    });
    if (e.r2_path !== exp) {
      throw new Error(`Unexpected r2_path (refusing)\n  url=${e.url}\n  got=${e.r2_path}\n  exp=${exp}`);
    }
    if (keys.has(e.r2_path)) throw new Error(`Duplicate r2_path: ${e.r2_path}`);
    keys.add(e.r2_path);
  }

  const workDir = mkdtempSync(path.join(tmpdir(), "kakomon-ingest-add-"));
  console.log(`Workdir: ${workDir}`);
  try {
    let done = 0;
    for (const e of entries) {
      done += 1;
      console.log(`\n[${done}/${entries.length}] ${e.r2_path}`);
      if (dryRun) continue;

      const outPdf = path.join(workDir, `${done}.pdf`);
      sh("curl", [
        "-L",
        "--fail",
        "-sS",
        "-A",
        "Mozilla/5.0",
        "--max-redirs",
        "5",
        "--proto",
        "=https,http",
        "--proto-redir",
        "=https,http",
        "-o",
        outPdf,
        "--",
        e.url,
      ]);
      const body = readFileSync(outPdf);
      await uploadToR2(e.r2_path, body, "application/pdf");

      const { error } = await supabase
        .from("kakomon_documents")
        .upsert(
          {
            university_id: e.university_id,
            year: e.year,
            subject: e.subject_id,
            subject_raw: e.subject_raw,
            subject_display: e.subject_display,
            exam_type: e.exam_type,
            exam_type_raw: e.exam_type_raw,
            content_type: e.content_type,
            pdf_storage_path: e.r2_path,
            original_url: e.url,
            is_bundled_origin: false,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "pdf_storage_path" },
        );
      if (error) throw new Error(`DB upsert failed (${e.r2_path}): ${error.message}`);
    }
  } finally {
    if (!dryRun) rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
