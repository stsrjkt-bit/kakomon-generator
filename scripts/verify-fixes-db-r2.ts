#!/usr/bin/env tsx
/**
 * Verify DB+R2 consistency for fixes (add entries + split plan outputs).
 *
 * Usage:
 *   npx tsx scripts/verify-fixes-db-r2.ts --add-fixes path/to/fixes-add.json --split-plan path/to/manual-split-plan.json
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const addPath = getArg("--add-fixes");
const splitPlanPath = getArg("--split-plan");
if (!addPath) {
  console.error("Error: --add-fixes is required");
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

async function fetchAllDocsByUniversityYears(params: {
  universityIds: string[];
  years: number[];
}): Promise<any[]> {
  const pageSize = 1000;
  let from = 0;
  const out: any[] = [];
  for (;;) {
    const to = from + pageSize - 1;
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
  const add = JSON.parse(readFileSync(addPath, "utf8")) as Array<{
    action: string;
    r2_path: string;
    university_id: string;
    year: number;
  }>;

  const expectedKeys: string[] = [];
  const expectedUniversities = new Set<string>();
  const expectedYears = new Set<number>();

  // From fixes-add.json: r2_path is explicit
  for (const e of add) {
    if (e.action !== "add") continue;
    expectedKeys.push(e.r2_path);
    expectedUniversities.add(e.university_id);
    expectedYears.add(e.year);
  }

  // From manual-split-plan.json: r2_path is explicit per output
  if (splitPlanPath) {
    const plan = JSON.parse(readFileSync(splitPlanPath, "utf8")) as {
      items: Array<{
        university_id: string;
        year: number;
        outputs: Array<{ r2_path: string }>;
      }>;
    };
    for (const item of plan.items) {
      for (const out of item.outputs) {
        expectedKeys.push(out.r2_path);
      }
      expectedUniversities.add(item.university_id);
      expectedYears.add(item.year);
    }
  }

  // Uniqueness
  const uniq = new Set(expectedKeys);
  if (uniq.size !== expectedKeys.length) {
    throw new Error(`Expected key list has duplicates: ${expectedKeys.length} vs uniq ${uniq.size}`);
  }
  console.log(`Expected objects: ${expectedKeys.length}`);

  // DB check
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
