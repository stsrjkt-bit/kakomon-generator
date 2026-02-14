#!/usr/bin/env tsx
/**
 * Register DB rows for split outputs (when split PDFs exist in R2 but DB rows are missing).
 *
 * Input expects a "split fixes" JSON file (array) containing entries like:
 * - { action:"split", url, university_id, year, exam_type, exam_variant, exam_type_raw, content_type, bundled_subjects:[...] }
 *
 * Usage:
 *   npx -s tsx scripts/register-split-db.ts --split-fixes path/to/fixes-split.json --dry-run
 *   npx -s tsx scripts/register-split-db.ts --split-fixes path/to/fixes-split.json --force
 *
 * Optional:
 *   --subject-labels path/to/subject-labels.json
 *     JSON shape: { "physics": {"raw":"物理","display":"物理"}, ... }
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

type FixEntry = {
  url?: string;
  university_id: string;
  year: number;
  exam_type: string;
  exam_variant: string | null;
  exam_type_raw?: string | null;
  content_type: "problem" | "answer";
  bundled_subjects: string[] | null;
  action: "split";
  // Optional: if you ever split into variants, this will be used.
  subject_variant?: string | null;
};

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function generateR2Path(params: {
  university_id: string;
  year: number;
  subject_id: string;
  subject_variant: string | null;
  exam_type: string;
  exam_variant: string | null;
  content_type: string;
}): string {
  const subjectPart = params.subject_variant
    ? `${params.subject_id}_${params.subject_variant}`
    : params.subject_id;
  const examPart = params.exam_variant
    ? `${params.exam_type}_${params.exam_variant}`
    : params.exam_type;
  return `${params.university_id}/${params.year}/${subjectPart}/${examPart}/${params.content_type}.pdf`;
}

function parseEntries(jsonPath: string): FixEntry[] {
  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as unknown;
  const arr = Array.isArray(raw)
    ? raw
    : (raw as any)?.entries ?? (raw as any)?.items ?? (raw as any)?.fixes;
  if (!Array.isArray(arr)) {
    throw new Error(`Invalid JSON shape: expected array (or {entries/items/fixes: array}): ${jsonPath}`);
  }
  const split = (arr as any[]).filter((e) => e?.action === "split");
  return split as FixEntry[];
}

function readSubjectLabels(path: string | null): Record<string, { raw: string; display: string }> {
  const defaults: Record<string, { raw: string; display: string }> = {
    math: { raw: "数学", display: "数学" },
    physics: { raw: "物理", display: "物理" },
    chemistry: { raw: "化学", display: "化学" },
    biology: { raw: "生物", display: "生物" },
    earth_science: { raw: "地学", display: "地学" },
    english: { raw: "英語", display: "英語" },
    japanese_lang: { raw: "国語", display: "国語" },
    essay: { raw: "小論文", display: "小論文" },
    general: { raw: "総合問題", display: "総合問題" },
    world_history: { raw: "世界史", display: "世界史" },
    japanese_history: { raw: "日本史", display: "日本史" },
    geography: { raw: "地理", display: "地理" },
    civics: { raw: "公民", display: "公民" },
    info: { raw: "情報", display: "情報" },
  };
  if (!path) return defaults;

  const parsed = JSON.parse(readFileSync(path, "utf8")) as any;
  const out: Record<string, { raw: string; display: string }> = { ...defaults };
  for (const [k, v] of Object.entries(parsed ?? {})) {
    if (v && typeof (v as any).raw === "string" && typeof (v as any).display === "string") {
      out[k] = { raw: (v as any).raw, display: (v as any).display };
    }
  }
  return out;
}

async function main() {
  const splitFixesPath = getArg("--split-fixes");
  if (!splitFixesPath) {
    console.error("Error: --split-fixes is required");
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  if (!dryRun && !force) {
    console.error("Refusing to run LIVE without --force (use --dry-run first)");
    process.exit(1);
  }

  const labelsPath = getArg("--subject-labels");
  const SUBJECT_LABELS = readSubjectLabels(labelsPath);

  const url = mustGetEnv("SUPABASE_URL");
  const key = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url, key);

  const splitEntries = parseEntries(splitFixesPath);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Split entries: ${splitEntries.length}`);

  let planned = 0;
  for (const e of splitEntries) {
    if (!e.university_id || !e.year || !e.exam_type || !e.content_type) {
      throw new Error(`split entry missing required fields: ${JSON.stringify(e)}`);
    }
    if (!e.bundled_subjects || e.bundled_subjects.length === 0) {
      throw new Error(`bundled_subjects missing/empty for split entry: ${JSON.stringify(e)}`);
    }
    for (const sid of e.bundled_subjects) {
      const lbl = SUBJECT_LABELS[sid] ?? { raw: sid, display: sid };
      const r2Path = generateR2Path({
        university_id: e.university_id,
        year: e.year,
        subject_id: sid,
        subject_variant: e.subject_variant ?? null,
        exam_type: e.exam_type,
        exam_variant: e.exam_variant ?? null,
        content_type: e.content_type,
      });
      planned++;

      const row = {
        university_id: e.university_id,
        year: e.year,
        subject: sid,
        subject_raw: lbl.raw,
        subject_display: lbl.display,
        exam_type: e.exam_type,
        exam_type_raw: e.exam_type_raw ?? "不明",
        content_type: e.content_type,
        pdf_storage_path: r2Path,
        original_url: e.url ?? null,
        is_bundled_origin: true,
        updated_at: new Date().toISOString(),
      };

      if (dryRun) {
        console.log(`- upsert ${r2Path} subject=${sid} (${lbl.raw}) from ${e.url ?? "(no url)"}`);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const { error } = await supabase
        .from("kakomon_documents")
        .upsert(row, { onConflict: "pdf_storage_path" });
      if (error) throw new Error(`upsert failed (${r2Path}): ${error.message}`);
    }
  }

  console.log(`Planned split-output DB rows: ${planned}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

