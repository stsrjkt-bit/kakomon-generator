#!/usr/bin/env tsx
/**
 * Retag (Phase 3) topics for existing DB rows.
 *
 * Flow:
 * 1) Fetch kakomon_questions rows that have split_image_path
 * 2) Download PNG from R2 (split_image_path key)
 * 3) Retag with tagSingleQuestion() using TOPIC_SELECTION_RULES (via cached instruction)
 * 4) Update DB: ONLY topic_tags column
 * 5) Log success/failure counts
 *
 * Usage:
 *   npx -s tsx scripts/retag-topics.ts --dry-run --limit 3 --subject 物理
 *   npx -s tsx scripts/retag-topics.ts --force --subject 物理 --university 九州大学
 */

// Keep scripts runnable via `npx tsx ...` without requiring the user to export env vars.
import "dotenv/config";

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

type QuestionRow = {
  id: string;
  document_id: string;
  split_image_path: string;
  topic_tags?: string[] | null;
  question_label?: string | null;
  question_number?: number | null;
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

async function resolveUniversityIdsByArg(params: {
  supabase: ReturnType<typeof createClient>;
  universityArg: string;
}): Promise<string[]> {
  const ua = params.universityArg.trim();
  if (!ua) return [];

  const { data, error } = await params.supabase
    .from("kakomon_universities")
    .select("id,name")
    .or(`id.eq.${ua},name.ilike.%${ua}%`)
    .limit(1000);

  if (error) throw new Error(`Failed to lookup university "${ua}": ${error.message}`);
  const ids = (data ?? [])
    .map((r) => asString((r as any)?.id))
    .filter((v): v is string => !!v);

  // If the arg matches an id exactly, prefer that single id (avoid partial-name broad match).
  if (ids.includes(ua)) return [ua];

  return Array.from(new Set(ids));
}

function buildDocumentSubjectOrFilter(subjectArg: string): string {
  // NOTE: kakomon_documents.subject may contain either English keys ("physics", "physics_di", ...)
  // or Japanese labels ("物理"). Make both match regardless of input.
  const BASE_SUBJECT_TO_JA: Record<string, string> = {
    math: "数学",
    physics: "物理",
    chemistry: "化学",
    biology: "生物",
    english: "英語",
    japanese: "国語",
  };
  const JA_TO_BASE_SUBJECT: Record<string, string> = Object.fromEntries(
    Object.entries(BASE_SUBJECT_TO_JA).map(([k, v]) => [v, k]),
  );

  // Avoid PostgREST filter injection: restrict input to a safe character set.
  // We only need base subjects / short Japanese subject labels.
  const sanitize = (v: string): string => {
    const s = v
      .trim()
      .normalize("NFKC")
      .replace(/[^0-9A-Za-z_\\-ぁ-んァ-ヶ一-龯ー]/g, "");
    return s;
  };
  const hasJapanese = (v: string): boolean => /[ぁ-んァ-ヶ一-龯]/.test(v);

  const raw = subjectArg.trim();
  const s = sanitize(raw);
  if (!s) return "id.is.null"; // match nothing (invalid subject)

  // Determine "base" (English) and "ja" (Japanese label) so either input matches both.
  // - "物理" -> base "physics", ja "物理"
  // - "physics_di" -> base "physics", ja "物理"
  // - "physics" -> base "physics", ja "物理"
  let base: string | null = null;
  let ja: string | null = null;

  if (JA_TO_BASE_SUBJECT[s]) {
    base = JA_TO_BASE_SUBJECT[s];
    ja = s;
  } else {
    // Prefer explicit mapping for known bases; otherwise accept "<base>_<variant>".
    const maybeBase = s.toLowerCase().split("_")[0] ?? "";
    if (BASE_SUBJECT_TO_JA[maybeBase]) base = maybeBase;
    if (!base) {
      try {
        // Fallback to existing resolver for additional aliases.
        base = resolveSubjectKey(raw).split("_")[0] ?? null;
      } catch {
        base = null;
      }
    }
    ja = base ? (BASE_SUBJECT_TO_JA[base] ?? null) : null;
  }

  const parts: string[] = [];
  // Match both "physics%" style and exact Japanese label in subject column.
  if (base) parts.push(`subject.ilike.${sanitize(base)}%`);
  if (ja) parts.push(`subject.eq.${sanitize(ja)}`);
  // Also match exact input (covers unknown subjects stored as-is in `subject`).
  parts.push(`subject.eq.${s}`);

  // subject_raw/subject_display are expected to be Japanese; only use Japanese needles here.
  if (ja) {
    const n = sanitize(ja);
    parts.push(`subject_raw.ilike.%${n}%`);
    parts.push(`subject_display.ilike.%${n}%`);
  }
  if (hasJapanese(s) && s !== ja) {
    parts.push(`subject_raw.ilike.%${s}%`);
    parts.push(`subject_display.ilike.%${s}%`);
  }

  return Array.from(new Set(parts)).join(",");
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
  // Limit processing (Gemini calls + DB updates), not matching/fetch size.
  const limit = Number.isFinite(opts.limit as number) ? Math.max(0, opts.limit as number) : null;

  if (!dryRun && !force) {
    console.error("Refusing to run LIVE without --force (use --dry-run first)");
    process.exit(1);
  }

  const url = mustGetEnv("SUPABASE_URL");
  const key = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url, key);

  const TABLE = "kakomon_questions";

  const questionSelectCols = [
    "id",
    "document_id",
    "split_image_path",
    "topic_tags",
    "question_label",
    "question_number",
  ];

  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Table: ${TABLE}`);
  console.log(`Columns: ${questionSelectCols.join(", ")}`);
  if (opts.subject) console.log(`Filter subject: ${opts.subject}`);
  if (opts.university) console.log(`Filter university: ${opts.university}`);
  if (limit !== null) console.log(`Limit: ${limit}`);

  // kakomon_questions does NOT have subject/university columns in this environment.
  // Filter them via kakomon_documents (linked by document_id).
  let filteredDocIds: string[] | null = null;
  let subjectByDocId: Map<string, string> | null = null;
  if (opts.subject || opts.university) {
    let q = supabase
      .from("kakomon_documents")
      .select("id,subject")
      .eq("content_type", "problem");

    if (opts.subject) {
      q = q.or(buildDocumentSubjectOrFilter(opts.subject));
    }

    if (opts.university) {
      const uniIds = await resolveUniversityIdsByArg({
        supabase,
        universityArg: opts.university,
      });
      if (uniIds.length === 0) {
        throw new Error(`No university matched: ${opts.university}`);
      }
      q = q.in("university_id", uniIds);
    }

    const docs: { id: string; subject: string }[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await q.range(offset, offset + pageSize - 1);
      if (error) throw new Error(`Failed to fetch kakomon_documents: ${error.message}`);
      const batch = (data ?? []) as any[];
      if (batch.length === 0) break;
      for (const d of batch) {
        const id = asString(d?.id);
        const subject = asString(d?.subject);
        if (id && subject) docs.push({ id, subject });
      }
      if (batch.length < pageSize) break;
    }

    filteredDocIds = docs.map((d) => d.id);
    subjectByDocId = new Map(docs.map((d) => [d.id, d.subject]));
    console.log(`Filtered documents: ${filteredDocIds.length}`);
  }

  const matchedRows: QuestionRow[] = [];
  const qPageSize = 200;

  const fetchQuestionsPage = async (params: {
    documentIds?: string[] | null;
    offset: number;
    limitCount: number;
  }): Promise<QuestionRow[]> => {
    let q = supabase
      .from(TABLE)
      .select(questionSelectCols.join(","))
      .not("split_image_path", "is", null)
      .neq("split_image_path", "");

    if (params.documentIds && params.documentIds.length > 0) {
      q = q.in("document_id", params.documentIds);
    }

    const { data, error } = await q.range(params.offset, params.offset + params.limitCount - 1);
    if (error) throw new Error(`Failed to fetch from ${TABLE}: ${error.message}`);
    return (data ?? []) as unknown as QuestionRow[];
  };

  if (filteredDocIds && filteredDocIds.length === 0) {
    console.log("Fetched rows: 0");
    return;
  }

  if (filteredDocIds) {
    // Chunk document IDs to keep `in()` reasonable.
    const docChunkSize = 100;
    for (let i = 0; i < filteredDocIds.length; i += docChunkSize) {
      const docChunk = filteredDocIds.slice(i, i + docChunkSize);
      for (let offset = 0; ; offset += qPageSize) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await fetchQuestionsPage({ documentIds: docChunk, offset, limitCount: qPageSize });
        if (batch.length === 0) break;
        matchedRows.push(...batch);
        if (batch.length < qPageSize) break;
      }
    }
  } else {
    // No doc-based filters: scan all questions with split_image_path.
    for (let offset = 0; ; offset += qPageSize) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await fetchQuestionsPage({ offset, limitCount: qPageSize });
      if (batch.length === 0) break;
      matchedRows.push(...batch);
      if (batch.length < qPageSize) break;
    }
  }

  console.log(`Fetched rows: ${matchedRows.length}`);
  if (limit !== null) console.log(`Processing limit: ${limit}`);
  if (matchedRows.length === 0) return;

  const rows = limit !== null ? matchedRows.slice(0, limit) : matchedRows;

  // Resolve subject per row via kakomon_documents (document_id -> subject).
  // If we already fetched document rows for filtering, reuse that mapping.
  if (!subjectByDocId) {
    const docIds = Array.from(
      new Set(
        rows
          .map((r) => r.document_id)
          .filter((v) => typeof v === "string" && v.length > 0),
      ),
    );
    subjectByDocId = new Map<string, string>();
    const chunkSize = 200;
    for (let i = 0; i < docIds.length; i += chunkSize) {
      const chunk = docIds.slice(i, i + chunkSize);
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await supabase
        .from("kakomon_documents")
        .select("id,subject")
        .in("id", chunk);
      if (error) throw new Error(`Failed to fetch kakomon_documents for subject map: ${error.message}`);
      for (const d of (data ?? []) as any[]) {
        const id = asString(d?.id);
        const subject = asString(d?.subject);
        if (id && subject) subjectByDocId.set(id, subject);
      }
    }
  }

  // Group by document subject and build/delete cache per group (same pattern as tagQuestions()).
  const bySubject = new Map<string, QuestionRow[]>();
  for (const r of rows) {
    const s = subjectByDocId.get(r.document_id) ?? "unknown";
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
    const topicSet = new Set(topicList);

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
        const id = String(r.id);
        const splitImagePath = asString(r.split_image_path);
        if (!splitImagePath) {
          console.warn(`  ⚠ skip id=${id}: split_image_path empty`);
          continue;
        }

        const label =
          asString(r.question_label) ?? `id:${id}`;
        const questionNumber =
          asNumber(r.question_number) ?? (i + 1);
        const oldTags = Array.isArray(r.topic_tags)
          ? (r.topic_tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [];

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

          const unknownTags = newTags.filter((t) => !topicSet.has(t));
          if (unknownTags.length > 0) {
            throw new Error(`Unknown topic tag(s) (not in master): ${JSON.stringify(unknownTags)}`);
          }

          if (dryRun) {
            console.log(
              `    DRY RUN topic_tags: old(${oldTags.length})=${JSON.stringify(oldTags)} -> new(${newTags.length})=${JSON.stringify(newTags)}`,
            );
            ok++;
            continue;
          }

          // LIVE: update ONLY topic_tags
          // eslint-disable-next-line no-await-in-loop
          const { error } = await supabase
            .from(TABLE)
            .update({ topic_tags: newTags })
            .eq("id", id);
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
  console.log(`Matched: ${matchedRows.length}`);
  if (limit !== null) console.log(`Processing pool: ${rows.length}`);
  console.log(`Processed: ${processed}`);
  console.log(`OK: ${ok}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped(no topic master): ${skippedNoTopics}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
