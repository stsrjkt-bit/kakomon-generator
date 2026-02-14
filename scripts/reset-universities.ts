#!/usr/bin/env tsx
/**
 * Strict rebuild helper: delete all documents/questions for given university IDs.
 *
 * Usage:
 *   npx tsx scripts/reset-universities.ts --university-ids kyutech,miyazaki,kumamoto --dry-run
 *   npx tsx scripts/reset-universities.ts --university-ids kyutech,miyazaki,kumamoto --force
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const idsRaw = getArg("--university-ids") ?? "";
const universityIds = idsRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (universityIds.length === 0) {
  console.error("Error: --university-ids is required");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
if (!dryRun && !force) {
  console.error("Refusing to run LIVE without --force (use --dry-run first)");
  process.exit(1);
}

const supabase = createClient(url, key);

async function chunked<T>(arr: T[], size: number): Promise<T[][]> {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Targets: ${universityIds.join(", ")}`);

  const { data: docs, error: docsErr } = await supabase
    .from("kakomon_documents")
    .select("id, university_id, pdf_storage_path")
    .in("university_id", universityIds);

  if (docsErr) throw new Error(`select kakomon_documents failed: ${docsErr.message}`);
  const docIds = (docs ?? []).map((d) => d.id as string);
  console.log(`Documents to delete: ${docIds.length}`);

  if (dryRun) return;

  // Delete questions first (FK constraint)
  const docIdChunks = await chunked(docIds, 100);
  let qChunkOps = 0;
  for (const c of docIdChunks) {
    if (c.length === 0) continue;
    const { error } = await supabase
      .from("kakomon_questions")
      .delete()
      .in("document_id", c);
    if (error) throw new Error(`delete kakomon_questions failed: ${error.message}`);
    qChunkOps += 1;
  }
  console.log(`Deleted kakomon_questions rows for doc chunks: chunks=${qChunkOps}`);

  // Delete documents
  let dDeleted = 0;
  for (const c of docIdChunks) {
    if (c.length === 0) continue;
    const { error } = await supabase
      .from("kakomon_documents")
      .delete()
      .in("id", c);
    if (error) throw new Error(`delete kakomon_documents failed: ${error.message}`);
    dDeleted += c.length;
  }
  console.log(`Deleted documents: ${dDeleted}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
