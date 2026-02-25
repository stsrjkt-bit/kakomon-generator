/**
 * Phase 3: トピック付け
 *
 * 切り出した大問画像(PNG)をGemini Visionに送り、
 * マスターリストに存在する5階層トピックタグを付与する。
 *
 * 大問単体の画像を見せて判定する（全体PDFからではない）。
 * thinkingLevel: HIGH で深く考えてトピック判定する。
 *
 * Explicit Context Caching を使い、マスターリスト+共通プロンプトを
 * キャッシュして入力トークンコストを削減する。
 */

import { ThinkingLevel } from "@google/genai";
import { askVisionWithImage, callWithRetry, extractJson, getClient } from "../lib/gemini.js";
import {
  getTopicsForSubject,
  isValidTopic,
} from "../constants/topic-master.js";
import type { SplitResult, TagResult } from "../types.js";

if (!process.env.GEMINI_VISION_MODEL) {
  throw new Error("GEMINI_VISION_MODEL environment variable is required (do not hardcode model names)");
}
const modelName: string = process.env.GEMINI_VISION_MODEL;

const BASE_SUBJECT_TO_JA: Record<string, string> = {
  math: "数学",
  physics: "物理",
  chemistry: "化学",
  biology: "生物",
  english: "英語",
  japanese: "国語",
};


function buildTopicSelectionRules(_subject: string): string {
  return `【トピック選択ルール - 厳守】
タグは少なく正確に。以下の手順で選択すること。

■ Step 1: まず問題の本質を一言で説明する
「この問題は何の問題か？」を一言で説明してください。

■ Step 2: Step 1 の説明に直接対応するトピックのみ選ぶ
Step 1 の説明に登場するキーワードに対応するトピックだけをマスターリストから選ぶ。
Step 1 に登場しないテーマのトピックは選ばない。

■ 核心テーマ vs 補助的手法
○ 核心 = その大問固有のテーマ。これがなければ別の問題になる
× 補助 = 多くの問題で汎用的に使う計算道具。なくても問題の個性は変わらない
判断:「この問題を知らない人に『何の問題？』と聞かれて答える内容」に含まれるか？
  → 含まれる → タグを付ける
  → 含まれない → タグを付けない

■ その他のルール
- 同じサブ単元（第4階層）のトピックは最も代表的なもの1つだけ選ぶ
- 1つの大問につきトピックは1〜4個を目安とする（多くても5個まで）`;
}

/**
 * 科目キーをトピックマスター用の正規科目名に寄せる。
 * 例: physics_di / physics_sys_sci_info -> 物理
 */
export function normalizeTopicSubject(subject: string): string {
  if (getTopicsForSubject(subject).length > 0) return subject;

  const base = subject.split("_")[0];
  const normalized = BASE_SUBJECT_TO_JA[base];
  return normalized ?? subject;
}

/**
 * マスターリスト用のシステムインストラクション（キャッシュ対象）を構築する
 */
function buildCachedInstruction(subject: string, topicListStr: string): string {
  return `あなたは大学入試の${subject}の問題を分析し、トピックタグを付与する専門家です。

【重要なルール】
- 以下のマスターリストに存在するパスのみを使用してください（5階層固定: 科目/分野/単元/サブ単元/トピック）
- マスターリストにないパスは絶対に使わないでください
- 複数のトピックにまたがる場合は複数返してください

${buildTopicSelectionRules(subject)}

- JSON配列のみを返してください。マークダウンのコードブロックは不要です。

【マスターリスト】
${topicListStr}

例: ["${subject}/分野A/単元A/サブ単元A/トピックA","${subject}/分野B/単元B/サブ単元B/トピックB"]`;
}

export async function createTopicContextCache(params: {
  /** displayName末尾に使う（例: "physics_di" や "物理"） */
  cacheNameSuffix: string;
  /** マスターリストの科目名（例: "物理"） */
  topicSubject: string;
  /** 5階層フルパスのトピック配列 */
  topicList: string[];
  /** Cache TTL (e.g. "300s") */
  ttl?: string;
}): Promise<{ name: string; totalTokenCount?: number }> {
  const client = getClient();
  const systemInstruction = buildCachedInstruction(
    params.topicSubject,
    params.topicList.join("\n"),
  );

  console.log("  📦 マスターリストをContext Cacheに登録中...");
  const cached = await client.caches.create({
    model: modelName,
    config: {
      contents: [
        {
          role: "user",
          parts: [{ text: systemInstruction }],
        },
      ],
      tools: [{ codeExecution: {} }],
      ttl: params.ttl ?? "300s",
      displayName: `kakomon-topics-${params.cacheNameSuffix}`,
    },
  });
  if (!cached.name) {
    throw new Error("Context Cache create returned no name");
  }
  return {
    name: cached.name,
    totalTokenCount: cached.usageMetadata?.totalTokenCount,
  };
}

export async function deleteTopicContextCache(name: string): Promise<void> {
  const client = getClient();
  await client.caches.delete({ name });
}

/**
 * 1つの大問画像に対してトピックタグを付与する
 */
export async function tagSingleQuestion(
  imagePng: Buffer,
  label: string,
  subject: string,
  cachedContentName?: string,
  topicList?: string[],
): Promise<string[]> {
  // labelはPDF由来の非信頼データのため、プロンプトインジェクション防止にサニタイズ
  const safeLabel = label.replace(/」/g, "");

  // キャッシュ使用時・未使用時で共通のプロンプト前半部分
  const promptPrefix = `この画像は大学入試の${subject}の問題から「${safeLabel}」を切り出したものです。図中の数値や記号が小さい場合はズームして確認し、問題の内容を正確に把握してからトピックを判定してください。`;

  // キャッシュ使用時はシンプルなプロンプト、未使用時はフルプロンプト
  let prompt: string;
  if (cachedContentName) {
    prompt = `${promptPrefix}

まず Step 1 として「この問題は何の問題か」を一言で説明し、
次に Step 2 としてその説明に対応するトピックタグをJSON配列で返してください。`;
  } else {
    const topicListStr = (topicList ?? []).join("\n");
    prompt = `${promptPrefix}
この問題の出題分野のトピックタグを付けてください。

【重要なルール】
- 以下のマスターリストに存在するパスのみを使用してください（5階層固定: 科目/分野/単元/サブ単元/トピック）
- マスターリストにないパスは絶対に使わないでください
- 複数のトピックにまたがる場合は複数返してください

${buildTopicSelectionRules(subject)}

【マスターリスト】
${topicListStr}

JSON配列のみを返してください。マークダウンのコードブロックは不要です。

例: ["${subject}/分野A/単元A/サブ単元A/トピックA","${subject}/分野B/単元B/サブ単元B/トピックB"]`;
  }

  const raw = await callWithRetry(() =>
    askVisionWithImage(prompt, imagePng, "image/png", cachedContentName, ThinkingLevel.HIGH),
  );

  let tags: string[];
  try {
    tags = extractJson(raw);
  } catch {
    console.warn(`  ⚠ ${label} のタグパースに失敗: ${raw.slice(0, 200)}`);
    return [];
  }

  // マスターリストに存在するパスのみを残す
  const validTags = tags.filter((t) => isValidTopic(t));
  const rejected = tags.length - validTags.length;
  if (rejected > 0) {
    const invalidTags = tags.filter((t) => !isValidTopic(t));
    console.warn(
      `  ⚠ ${label}: ${rejected}件のタグをマスターリスト照合で除外: ${invalidTags.join(", ")}`,
    );
  }

  return validTags;
}

/**
 * Phase 3: トピック付け
 *
 * 切り出し済みの大問画像群に対してトピックタグを付与する。
 * Explicit Context Caching でマスターリストをキャッシュし、
 * 入力トークンコストを削減する。
 */
export async function tagQuestions(
  splits: SplitResult[],
  subject: string,
): Promise<TagResult[]> {
  const topicSubject = normalizeTopicSubject(subject);
  const topicList = getTopicsForSubject(topicSubject);
  if (topicList.length === 0) {
    console.warn(`  ⚠ 科目「${subject}」（正規化: ${topicSubject}）のトピックがマスターリストに見つかりません`);
    return splits.map((s) => ({
      label: s.label,
      questionNumber: s.questionNumber,
      topicTags: [],
    }));
  }

  console.log(
    `  🏷️  ${splits.length}個の大問にトピックタグを付与中（${topicSubject}: ${topicList.length}トピック）...`,
  );

  // Explicit Context Caching: マスターリスト+共通プロンプトをキャッシュ
  let cachedContentName: string | undefined;
  try {
    const cached = await createTopicContextCache({
      cacheNameSuffix: subject,
      topicSubject,
      topicList,
    });
    cachedContentName = cached.name;
    console.log(
      `  📦 キャッシュ作成完了: ${cachedContentName} (${cached.totalTokenCount ?? "?"} tokens)`,
    );
  } catch (err) {
    console.warn(
      `  ⚠ Context Cache作成に失敗、キャッシュなしで続行: ${err instanceof Error ? err.message : err}`,
    );
  }

  try {
    const results: TagResult[] = [];

    for (const split of splits) {
      console.log(`  🏷️  ${split.label} タグ付け中...`);
      const topicTags = await tagSingleQuestion(
        split.imagePng,
        split.label,
        topicSubject,
        cachedContentName,
        topicList,
      );

      results.push({
        label: split.label,
        questionNumber: split.questionNumber,
        topicTags,
      });

      console.log(
        `  🏷️  ${split.label}: ${topicTags.length}件のタグを付与`,
      );
    }

    return results;
  } finally {
    // キャッシュの削除（エラー時にも必ず実行）
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
