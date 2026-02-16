#!/usr/bin/env tsx
/**
 * Strict rebuild helper: delete documents/questions for (university_id, year) pairs
 * derived from fixes files (add + split).
 *
 * This is safer than deleting by university_id only when the scope is "currently linked years only".
 *
 * Usage:
 *   npx tsx scripts/reset-universities-by-fixes.ts --add-fixes path/to/fixes-add.json --split-fixes path/to/fixes-split.json --dry-run
 *   npx tsx scripts/reset-universities-by-fixes.ts --add-fixes path/to/fixes-add.json --split-fixes path/to/fixes-split.json --force
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

type FixEntry = {
  university_id: string;
  year: number;
  action: "add" | "split";
};

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

const addPath = getArg("--add-fixes");
const splitPath = getArg("--split-fixes");
if (!addPath || !splitPath) {
  console.error("Error: --add-fixes and --split-fixes are required");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
if (!dryRun && !force) {
  console.error("Refusing to run LIVE without --force (use --dry-run first)");
  process.exit(1);
}

const supabase = createClient(url, key);

function uniqPairs(entries: FixEntry[]): Array<{ university_id: string; year: number }> {
  const set = new Set<string>();
  for (const e of entries) set.add(`${e.university_id}|${e.year}`);
  return [...set]
    .map((s) => {
      const [university_id, yearRaw] = s.split("|");
      return { university_id, year: parseInt(yearRaw, 10) };
    })
    .sort((a, b) => a.university_id.localeCompare(b.university_id) || a.year - b.year);
}

async function fetchAllDocIdsByPairs(pairs: Array<{ university_id: string; year: number }>): Promise<string[]> {
  const pageSize = 1000;
  const out: string[] = [];

  // Query per pair to keep PostgREST filters simple and predictable.
  for (const p of pairs) {
    let from = 0;
    for (;;) {
      const to = from + pageSize - 1;
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await supabase
        .from("kakomon_documents")
        .select("id")
        .eq("university_id", p.university_id)
        .eq("year", p.year)
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw new Error(`select kakomon_documents failed: ${error.message}`);
      const ids = (data ?? []).map((d: any) => d.id as string).filter(Boolean);
      out.push(...ids);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
  }

  return out;
}

async function chunked<T>(arr: T[], size: number): Promise<T[][]> {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const add = JSON.parse(readFileSync(addPath, "utf8")) as FixEntry[];
  const split = JSON.parse(readFileSync(splitPath, "utf8")) as FixEntry[];

  const pairs = uniqPairs([...add, ...split]);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Pairs (university_id, year): ${pairs.length}`);
  for (const p of pairs) console.log(`- ${p.university_id}\t${p.year}`);

  const docIds = await fetchAllDocIdsByPairs(pairs);
  console.log(`Documents to delete: ${docIds.length}`);
  if (dryRun) return;
  if (docIds.length === 0) return;

  // Delete questions first (FK constraint)
  const docIdChunks = await chunked(docIds, 100);
  let qChunkOps = 0;
  for (const c of docIdChunks) {
    if (c.length === 0) continue;
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.from("kakomon_questions").delete().in("document_id", c);
    if (error) throw new Error(`delete kakomon_questions failed: ${error.message}`);
    qChunkOps += 1;
  }
  console.log(`Deleted kakomon_questions rows for doc chunks: chunks=${qChunkOps}`);

  // Delete documents
  let dDeleted = 0;
  for (const c of docIdChunks) {
    if (c.length === 0) continue;
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.from("kakomon_documents").delete().in("id", c);
    if (error) throw new Error(`delete kakomon_documents failed: ${error.message}`);
    dDeleted += c.length;
  }
  console.log(`Deleted documents: ${dDeleted}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

