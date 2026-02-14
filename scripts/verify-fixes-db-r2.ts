#!/usr/bin/env tsx
/**
 * Verify DB+R2 consistency for a fixes file (add + expected split outputs).
 *
 * Usage:
 *   npx tsx scripts/verify-fixes-db-r2.ts --add-fixes path/to/fixes-add.json --split-fixes path/to/fixes-split.json
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

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

const addPath = getArg("--add-fixes");
const splitPath = getArg("--split-fixes");
if (!addPath || !splitPath) {
  console.error("Error: --add-fixes and --split-fixes are required");
  process.exit(1);
}

const sbUrl = process.env.SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!sbUrl || !sbKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const supabase = createClient(sbUrl, sbKey);

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME ?? "kakomon";
if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required");
  process.exit(1);
}

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

function generateR2Path(params: {
  university_id: string;
  year: number;
  subject_id: string;
  subject_variant: string | null;
  exam_type: string;
  exam_variant: string | null;
  content_type: string;
}): string {
  // This uses the collector path format, which includes optional subject_variant/exam_variant
  // (differs from some helpers in src/lib/r2.ts which predate exam variants).
  const subjectPart = params.subject_variant
    ? `${params.subject_id}_${params.subject_variant}`
    : params.subject_id;
  const examPart = params.exam_variant
    ? `${params.exam_type}_${params.exam_variant}`
    : params.exam_type;
  return `${params.university_id}/${params.year}/${subjectPart}/${examPart}/${params.content_type}.pdf`;
}

async function fetchAllDocsByUniversityYears(params: {
  universityIds: string[];
  years: number[];
}): Promise<any[]> {
  const pageSize = 1000;
  let from = 0;
  const out: any[] = [];
  for (;;) {
    const to = from + pageSize - 1;
    // Note: Supabase/PostgREST responses are commonly capped; paginate defensively.
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase
      .from("kakomon_documents")
      .select(
        "pdf_storage_path, university_id, year, subject, subject_raw, subject_display, exam_type, content_type, is_bundled_origin",
      )
      .in("university_id", params.universityIds)
      .in("year", params.years)
      .order("pdf_storage_path", { ascending: true })
      .range(from, to);
    if (error) throw new Error(`DB select failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function headKey(key: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const add = JSON.parse(readFileSync(addPath, "utf8")) as FixEntry[];
  const split = JSON.parse(readFileSync(splitPath, "utf8")) as FixEntry[];

  const expectedKeys: string[] = [];
  const expectedUniversities = new Set<string>();
  const expectedYears = new Set<number>();
  for (const e of add) {
    if (e.action !== "add") continue;
    expectedKeys.push(e.r2_path);
    expectedUniversities.add(e.university_id);
    expectedYears.add(e.year);
  }
  for (const e of split) {
    if (e.action !== "split") continue;
    for (const sid of e.bundled_subjects ?? []) {
      expectedKeys.push(
        generateR2Path({
          university_id: e.university_id,
          year: e.year,
          subject_id: sid,
          subject_variant: null,
          exam_type: e.exam_type,
          exam_variant: e.exam_variant,
          content_type: e.content_type,
        }),
      );
    }
    expectedUniversities.add(e.university_id);
    expectedYears.add(e.year);
  }

  // Uniqueness
  const uniq = new Set(expectedKeys);
  if (uniq.size !== expectedKeys.length) {
    throw new Error(`Expected key list has duplicates: ${expectedKeys.length} vs uniq ${uniq.size}`);
  }
  console.log(`Expected objects: ${expectedKeys.length}`);

  // DB check
  // Avoid huge `in(pdf_storage_path, ...)` query strings; fetch by university/year instead.
  const docs = await fetchAllDocsByUniversityYears({
    universityIds: [...expectedUniversities],
    years: [...expectedYears],
  });
  const got = new Set(
    (docs ?? [])
      .map((d) => d.pdf_storage_path as string)
      .filter((p) => uniq.has(p)),
  );
  const missingDb = [...uniq].filter((k) => !got.has(k));
  if (missingDb.length) {
    console.log("Missing in DB:");
    for (const k of missingDb.slice(0, 50)) console.log(`- ${k}`);
    if (missingDb.length > 50) console.log(`... (${missingDb.length - 50} more)`);
    throw new Error(`DB missing ${missingDb.length} rows`);
  }
  console.log(`DB OK: ${got.size}/${uniq.size}`);

  // R2 check (sequential to avoid rate issues)
  const missingR2: string[] = [];
  let ok = 0;
  for (const k of uniq) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await headKey(k);
    if (!exists) missingR2.push(k);
    else ok++;
  }
  if (missingR2.length) {
    console.log("Missing in R2:");
    for (const k of missingR2.slice(0, 50)) console.log(`- ${k}`);
    if (missingR2.length > 50) console.log(`... (${missingR2.length - 50} more)`);
    throw new Error(`R2 missing ${missingR2.length} objects`);
  }
  console.log(`R2 OK: ${ok}/${uniq.size}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
