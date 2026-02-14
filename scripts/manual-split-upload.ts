#!/usr/bin/env tsx
/**
 * Manual split pipeline for bundled-subject PDFs when kakomon-collector (pdf-lib) cannot split.
 *
 * - Download source PDF (official URL)
 * - Split by explicit page ranges using qpdf
 * - Upload each split PDF to R2
 * - Upsert kakomon_documents rows (is_bundled_origin=true, original_url=source)
 *
 * Usage:
 *   bash -lc 'set -a; source .env; set +a; npx -s tsx scripts/manual-split-upload.ts --plan path/to/manual-split-plan.json --dry-run'
 *   bash -lc 'set -a; source .env; set +a; npx -s tsx scripts/manual-split-upload.ts --plan path/to/manual-split-plan.json --force'
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { uploadToR2 } from "../src/lib/r2";

type PlanOut = {
  r2_path: string;
  // 1-based page range for qpdf, e.g. "1-3" or "7-8"
  pages: string;
  subject_id: string;
  subject_raw: string;
  subject_display: string;
  exam_type: string;
  exam_type_raw: string;
  exam_variant?: string | null;
  content_type: "problem" | "answer";
};

type PlanItem = {
  source_url: string;
  university_id: string;
  year: number;
  outputs: PlanOut[];
};

type PlanFile = {
  generated_at: string;
  items: PlanItem[];
};

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim();
    throw new Error(`${cmd} failed: ${cmd} ${args.join(" ")}\n${msg}`);
  }
  return r.stdout;
}

function sha8(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}

async function main() {
  const planPath = getArg("--plan");
  if (!planPath) {
    console.error("Error: --plan is required");
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

  const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanFile;
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Plan: ${planPath}`);
  console.log(`Items: ${plan.items.length}`);

  const workDir = mkdtempSync(path.join(tmpdir(), "kakomon-manual-split-"));
  console.log(`Workdir: ${workDir}`);

  const summary: any[] = [];
  try {
    for (const item of plan.items) {
      const srcPdf = path.join(workDir, `src-${sha8(item.source_url)}.pdf`);
      console.log(`\n[download] ${item.source_url}`);
      if (!dryRun) {
        sh("curl", ["-L", "--fail", "-sS", "-A", "Mozilla/5.0", item.source_url, "-o", srcPdf]);
      }

      for (const out of item.outputs) {
        const outPdf = path.join(workDir, `out-${sha8(out.r2_path)}.pdf`);
        console.log(`[split] ${out.r2_path} pages=${out.pages}`);
        if (!dryRun) {
          sh("qpdf", [srcPdf, "--pages", ".", out.pages, "--", outPdf]);
        }

        if (dryRun) {
          summary.push({
            r2_path: out.r2_path,
            subject_id: out.subject_id,
            pages: out.pages,
            source_url: item.source_url,
          });
          continue;
        }

        const body = readFileSync(outPdf);
        await uploadToR2(out.r2_path, body, "application/pdf");

        const { error } = await supabase
          .from("kakomon_documents")
          .upsert(
            {
              university_id: item.university_id,
              year: item.year,
              subject: out.subject_id,
              subject_raw: out.subject_raw,
              subject_display: out.subject_display,
              exam_type: out.exam_type,
              exam_type_raw: out.exam_type_raw,
              content_type: out.content_type,
              pdf_storage_path: out.r2_path,
              original_url: item.source_url,
              is_bundled_origin: true,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "pdf_storage_path" },
          );
        if (error) throw new Error(`DB upsert failed (${out.r2_path}): ${error.message}`);

        summary.push({
          r2_path: out.r2_path,
          bytes: body.length,
          subject_id: out.subject_id,
          pages: out.pages,
          source_url: item.source_url,
        });
      }
    }
  } finally {
    // Keep artifacts if dry-run; otherwise cleanup.
    if (!dryRun) rmSync(workDir, { recursive: true, force: true });
  }

  const outSummary = path.resolve(process.cwd(), "manual-split-upload-summary.json");
  writeFileSync(outSummary, JSON.stringify({ generated_at: new Date().toISOString(), summary }, null, 2));
  console.log(`\nWrote: ${outSummary} (rows=${summary.length})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
