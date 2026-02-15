#!/usr/bin/env tsx
/**
 * Retag (Phase 3) topics for existing DB rows.
 *
 * Flow:
 * 1) Fetch kakomon_chunks rows that have split_image_path
 * 2) Download PNG from R2 (split_image_path key)
 * 3) Retag with tagSingleQuestion() using TOPIC_SELECTION_RULES (via cached instruction)
 * 4) Update DB: ONLY topic_tags column
 * 5) Log success/failure counts
 *
 * Usage:
 *   npx -s tsx scripts/retag-topics.ts --dry-run --limit 3 --subject 物理
 *   npx -s tsx scripts/retag-topics.ts --force --subject 物理 --university 九州大学
 */

import { Command } from "commander";
import { createClient } from "@supabase/supabase-js";
import { downloadFromR2, resolveSubjectKey } from "../src/lib/r2";
import { getTopicsForSubject } from "../src/constants/topic-master";
import {
  createTopicContextCache,
  deleteTopicContextCache,
  normalizeTopicSubject,
  tagSingleQuestion,
} from "../src/phases/tag";

type ChunkRow = {
  id: string;
  subject: string;
  split_image_path: string;
  topic_tags?: string[] | null;
  // Optional columns (detected dynamically)
  university?: string | null;
  label?: string | null;
  question_number?: number | null;
  [k: string]: unknown;
};

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

async function detectFirstExistingColumn(params: {
  supabase: ReturnType<typeof createClient>;
  table: string;
  candidates: string[];
}): Promise<string | null> {
  for (const col of params.candidates) {
    const { error } = await params.supabase
      .from(params.table)
      .select(col)
      .limit(1);
    if (!error) return col;
  }
  return null;
}

function looksLikeExpiredCacheError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg.includes("cache") && !msg.includes("cached")) return false;
  return (
    msg.includes("not found")
    || msg.includes("404")
    || msg.includes("expired")
    || msg.includes("invalid")
  );
}

async function main() {
  const program = new Command();
  program
    .option("--subject <subject>", "科目で絞り込み（例: 物理）")
    .option("--university <university>", "大学名（またはID）で絞り込み（任意）")
    .option("--dry-run", "DB更新せずに結果だけ表示")
    .option("--force", "LIVE更新を実行する（--dry-run無しの場合に必須）")
    .option("--limit <n>", "処理件数の上限（テスト用）", (v) => Number(v))
    .parse(process.argv);

  const opts = program.opts<{
    subject?: string;
    university?: string;
    dryRun?: boolean;
    force?: boolean;
    limit?: number;
  }>();

  const dryRun = !!opts.dryRun;
  const force = !!opts.force;
  const limit = Number.isFinite(opts.limit as number) ? Math.max(0, opts.limit as number) : null;

  if (!dryRun && !force) {
    console.error("Refusing to run LIVE without --force (use --dry-run first)");
    process.exit(1);
  }

  const url = mustGetEnv("SUPABASE_URL");
  const key = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url, key);

  const TABLE = "kakomon_chunks";

  // Detect columns to support slight schema differences across environments.
  const [
    idCol,
    subjectCol,
    splitImageCol,
    topicTagsCol,
    universityCol,
    labelCol,
    questionNumberCol,
  ] = await Promise.all([
    detectFirstExistingColumn({ supabase, table: TABLE, candidates: ["id"] }),
    detectFirstExistingColumn({ supabase, table: TABLE, candidates: ["subject"] }),
    detectFirstExistingColumn({ supabase, table: TABLE, candidates: ["split_image_path"] }),
    detectFirstExistingColumn({ supabase, table: TABLE, candidates: ["topic_tags"] }),
    detectFirstExistingColumn({
      supabase,
      table: TABLE,
      candidates: ["university", "university_name", "university_id"],
    }),
    detectFirstExistingColumn({
      supabase,
      table: TABLE,
      candidates: ["label", "question_label", "chunk_label"],
    }),
    detectFirstExistingColumn({
      supabase,
      table: TABLE,
      candidates: ["question_number", "questionNumber"],
    }),
  ]);

  if (!idCol || !subjectCol || !splitImageCol || !topicTagsCol) {
    throw new Error(
      `Required columns missing in ${TABLE}: id=${idCol}, subject=${subjectCol}, split_image_path=${splitImageCol}, topic_tags=${topicTagsCol}`,
    );
  }

  if (opts.university && !universityCol) {
    throw new Error(`--university was provided but no university column was found in ${TABLE}`);
  }

  const selectCols = [
    idCol,
    subjectCol,
    splitImageCol,
    topicTagsCol,
    ...(universityCol ? [universityCol] : []),
    ...(labelCol ? [labelCol] : []),
    ...(questionNumberCol ? [questionNumberCol] : []),
  ];

  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Table: ${TABLE}`);
  console.log(`Columns: ${selectCols.join(", ")}`);
  if (opts.subject) console.log(`Filter subject: ${opts.subject}`);
  if (opts.university) console.log(`Filter university: ${opts.university} (col: ${universityCol})`);
  if (limit !== null) console.log(`Limit: ${limit}`);

  const rows: ChunkRow[] = [];
  const pageSize = 200;
  let offset = 0;
  while (true) {
    let q = supabase
      .from(TABLE)
      .select(selectCols.join(","))
      .not(splitImageCol, "is", null)
      .neq(splitImageCol, "");

    if (opts.subject) {
      // Accept either raw subject or its ASCII key if resolvable (e.g. "物理" -> "physics").
      let subjectKey: string | null = null;
      try {
        subjectKey = resolveSubjectKey(opts.subject);
      } catch {
        subjectKey = null;
      }
      if (subjectKey && subjectKey !== opts.subject) {
        q = q.in(subjectCol, [opts.subject, subjectKey]);
      } else {
        q = q.eq(subjectCol, opts.subject);
      }
    }

    if (opts.university && universityCol) {
      if (universityCol.endsWith("_id")) {
        q = q.eq(universityCol, opts.university);
      } else {
        q = q.ilike(universityCol, `%${opts.university}%`);
      }
    }

    if (limit !== null) {
      const remaining = limit - rows.length;
      if (remaining <= 0) break;
      q = q.range(offset, offset + Math.min(pageSize, remaining) - 1);
    } else {
      q = q.range(offset, offset + pageSize - 1);
    }

    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await q;
    if (error) throw new Error(`Failed to fetch from ${TABLE}: ${error.message}`);
    const batch = (data ?? []) as unknown as ChunkRow[];
    if (batch.length === 0) break;

    rows.push(...batch);
    offset += pageSize;

    if (limit !== null && rows.length >= limit) break;
  }

  console.log(`Fetched rows: ${rows.length}`);
  if (rows.length === 0) return;

  // Group by subject (as stored in DB) and build/delete cache per group (same pattern as tagQuestions()).
  const bySubject = new Map<string, ChunkRow[]>();
  for (const r of rows) {
    const s = asString((r as any)[subjectCol]) ?? "unknown";
    const arr = bySubject.get(s) ?? [];
    arr.push(r);
    bySubject.set(s, arr);
  }

  let processed = 0;
  let ok = 0;
  let failed = 0;
  let skippedNoTopics = 0;

  for (const [subjectRaw, group] of bySubject.entries()) {
    const topicSubject = normalizeTopicSubject(subjectRaw);
    const topicList = getTopicsForSubject(topicSubject);
    if (topicList.length === 0) {
      console.warn(`⚠ No topic master found for subject="${subjectRaw}" (normalized: "${topicSubject}"); skipping ${group.length} rows`);
      skippedNoTopics += group.length;
      continue;
    }

    console.log(`\n== Subject: ${subjectRaw} (normalized: ${topicSubject}) rows=${group.length} topics=${topicList.length} ==`);

    let cachedContentName: string | undefined;
    try {
      const cached = await createTopicContextCache({
        cacheNameSuffix: subjectRaw,
        topicSubject,
        topicList,
        // This script can process thousands of rows; avoid cache expiry mid-batch.
        ttl: "3600s",
      });
      cachedContentName = cached.name;
      console.log(`  📦 Cache: ${cachedContentName} (${cached.totalTokenCount ?? "?"} tokens)`);
    } catch (err) {
      console.warn(
        `  ⚠ Context Cache作成に失敗、キャッシュなしで続行: ${err instanceof Error ? err.message : err}`,
      );
      cachedContentName = undefined;
    }

    try {
      for (let i = 0; i < group.length; i++) {
        const r = group[i];
        const id = String((r as any)[idCol]);
        const splitImagePath = asString((r as any)[splitImageCol]);
        if (!splitImagePath) {
          console.warn(`  ⚠ skip id=${id}: split_image_path empty`);
          continue;
        }

        const label =
          (labelCol ? asString((r as any)[labelCol]) : null) ??
          `id:${id}`;
        const questionNumber =
          (questionNumberCol ? asNumber((r as any)[questionNumberCol]) : null) ??
          (i + 1);

        processed++;
        console.log(`  🏷️  [${processed}/${rows.length}] ${label} (${id})`);

        try {
          // eslint-disable-next-line no-await-in-loop
          const png = await downloadFromR2(splitImagePath);
          let newTags: string[];
          try {
            // eslint-disable-next-line no-await-in-loop
            newTags = await tagSingleQuestion(
              png,
              label,
              topicSubject,
              cachedContentName,
              topicList,
            );
          } catch (err) {
            // If cache expired mid-batch, refresh once and retry.
            if (cachedContentName && looksLikeExpiredCacheError(err)) {
              console.warn("    ⚠ Cache may be expired; recreating cache and retrying once...");
              try {
                // eslint-disable-next-line no-await-in-loop
                const cached = await createTopicContextCache({
                  cacheNameSuffix: subjectRaw,
                  topicSubject,
                  topicList,
                  ttl: "3600s",
                });
                cachedContentName = cached.name;
                console.log(`    📦 Cache refreshed: ${cachedContentName}`);
              } catch (refreshErr) {
                console.warn(
                  `    ⚠ Cache refresh failed: ${refreshErr instanceof Error ? refreshErr.message : refreshErr}`,
                );
              }
              // eslint-disable-next-line no-await-in-loop
              newTags = await tagSingleQuestion(
                png,
                label,
                topicSubject,
                cachedContentName,
                topicList,
              );
            } else {
              throw err;
            }
          }

          if (dryRun) {
            console.log(`    DRY RUN topic_tags(${newTags.length}): ${JSON.stringify(newTags)}`);
            ok++;
            continue;
          }

          // LIVE: update ONLY topic_tags
          // eslint-disable-next-line no-await-in-loop
          const { error } = await supabase
            .from(TABLE)
            .update({ [topicTagsCol]: newTags })
            .eq(idCol, id);
          if (error) throw new Error(error.message);

          console.log(`    UPDATED topic_tags(${newTags.length}) q=${questionNumber}`);
          ok++;
        } catch (err) {
          failed++;
          console.warn(`    ⚠ FAILED id=${id}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
      }
    } finally {
      if (cachedContentName) {
        try {
          await deleteTopicContextCache(cachedContentName);
          console.log("  📦 Context Cache削除完了");
        } catch (err) {
          console.warn(
            `  ⚠ Context Cache削除に失敗: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }

  console.log("\n== Summary ==");
  console.log(`Fetched: ${rows.length}`);
  console.log(`Processed: ${processed}`);
  console.log(`OK: ${ok}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped(no topic master): ${skippedNoTopics}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
