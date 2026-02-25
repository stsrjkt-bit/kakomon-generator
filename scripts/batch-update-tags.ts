#!/usr/bin/env tsx
/**
 * Batch update topic_tags for kakomon_questions from a JSON file.
 *
 * Usage:
 *   ./scripts/with-env.sh npx tsx scripts/batch-update-tags.ts tags.json
 *   ./scripts/with-env.sh npx tsx scripts/batch-update-tags.ts tags.json --dry-run
 *
 * JSON format:
 *   [
 *     {
 *       "question_id": "87a8629c-d00a-4f67-986f-fc9d3eb750b7",
 *       "question_label": "2023 理系 Q1",
 *       "topic_tags": [
 *         "数学/数学Ⅲ/極限/数列の極限/はさみうちの原理"
 *       ]
 *     }
 *   ]
 *
 * Validation:
 *   - Each tag is checked against the topic master list (isValidTopic).
 *   - Rows with ANY invalid tag are skipped (others continue).
 *   - --dry-run prints what would be updated without touching the DB.
 */

import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { isValidTopic } from "../src/constants/topic-master.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));

if (positional.length < 1) {
  console.error(
    "Usage: ./scripts/with-env.sh npx tsx scripts/batch-update-tags.ts <tags.json> [--dry-run]"
  );
  process.exit(1);
}

const jsonPath = path.resolve(positional[0]);

// ---------------------------------------------------------------------------
// Env / Supabase
// ---------------------------------------------------------------------------

const sbUrl = process.env.SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!sbUrl || !sbKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const supabase = createClient(sbUrl, sbKey);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TagEntry {
  question_id: string;
  question_label?: string;
  topic_tags: string[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Read JSON
  if (!fs.existsSync(jsonPath)) {
    console.error(`File not found: ${jsonPath}`);
    process.exit(1);
  }
  let entries: TagEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as TagEntry[];
  } catch (err: any) {
    console.error(`Failed to parse JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(entries)) {
    console.error("JSON must be an array");
    process.exit(1);
  }

  console.log(`Loaded ${entries.length} entries from ${jsonPath}`);
  if (dryRun) console.log("Mode: DRY RUN (no DB changes)\n");
  else console.log("Mode: LIVE\n");

  // 2. Validate + process
  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (const entry of entries) {
    const label = entry.question_label ?? entry.question_id.slice(0, 8);

    // Basic shape check
    if (!entry.question_id || typeof entry.question_id !== "string") {
      console.error(`  SKIP [${label}]: missing or invalid question_id`);
      skipCount++;
      continue;
    }
    if (!Array.isArray(entry.topic_tags)) {
      console.error(`  SKIP [${label}]: topic_tags must be an array`);
      skipCount++;
      continue;
    }

    // Validate each tag against master list
    const invalidTags = entry.topic_tags.filter((t) => !isValidTopic(t));
    if (invalidTags.length > 0) {
      console.error(`  SKIP [${label}]: invalid tag(s):`);
      for (const t of invalidTags) console.error(`    - ${t}`);
      skipCount++;
      continue;
    }

    // Dry-run: just print
    if (dryRun) {
      console.log(`  WOULD UPDATE [${label}] (${entry.question_id})`);
      for (const t of entry.topic_tags) console.log(`    + ${t}`);
      successCount++;
      continue;
    }

    // Live: PATCH via Supabase
    const { error } = await supabase
      .from("kakomon_questions")
      .update({ topic_tags: entry.topic_tags })
      .eq("id", entry.question_id);

    if (error) {
      console.error(`  FAIL [${label}] (${entry.question_id}): ${error.message}`);
      failCount++;
    } else {
      console.log(`  OK [${label}] (${entry.question_id}): ${entry.topic_tags.length} tag(s)`);
      successCount++;
    }
  }

  // 3. Summary
  console.log(`\n--- Summary ---`);
  if (dryRun) {
    console.log(`  Would update : ${successCount}`);
  } else {
    console.log(`  Success      : ${successCount}`);
    console.log(`  Failed       : ${failCount}`);
  }
  console.log(`  Skipped      : ${skipCount}`);
  console.log(`  Total entries: ${entries.length}`);

  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
