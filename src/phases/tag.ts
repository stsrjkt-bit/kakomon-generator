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
import { askVisionWithImage, callWithRetry, extractJson, client } from "../lib/gemini.js";
import {
  getTopicsForSubject,
  isValidTopic,
} from "../constants/topic-master.js";
import type { SplitResult, TagResult } from "../types.js";

const modelName = process.env.GEMINI_VISION_MODEL ?? "gemini-3-flash-preview";

/**
 * マスターリスト用のシステムインストラクション（キャッシュ対象）を構築する
 */
function buildCachedInstruction(subject: string, topicListStr: string): string {
  return `あなたは大学入試の${subject}の問題を分析し、トピックタグを付与する専門家です。

【重要なルール】
- 以下のマスターリストに存在するパスのみを使用してください（5階層固定: 科目/分野/単元/サブ単元/トピック）
- マスターリストにないパスは絶対に使わないでください
- 複数のトピックにまたがる場合は複数返してください
- JSON配列のみを返してください。マークダウンのコードブロックは不要です。

【マスターリスト】
${topicListStr}

例: ["${subject}/分野A/単元A/サブ単元A/トピックA","${subject}/分野B/単元B/サブ単元B/トピックB"]`;
}

/**
 * 1つの大問画像に対してトピックタグを付与する
 */
async function tagSingleQuestion(
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
    prompt = `${promptPrefix}この問題の出題分野のトピックタグをJSON配列で返してください。`;
  } else {
    const topicListStr = (topicList ?? []).join("\n");
    prompt = `${promptPrefix}
この問題の出題分野のトピックタグを付けてください。

【重要なルール】
- 以下のマスターリストに存在するパスのみを使用してください（5階層固定: 科目/分野/単元/サブ単元/トピック）
- マスターリストにないパスは絶対に使わないでください
- 複数のトピックにまたがる場合は複数返してください

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
  const topicList = getTopicsForSubject(subject);
  if (topicList.length === 0) {
    console.warn(`  ⚠ 科目「${subject}」のトピックがマスターリストに見つかりません`);
    return splits.map((s) => ({
      label: s.label,
      questionNumber: s.questionNumber,
      topicTags: [],
    }));
  }

  console.log(
    `  🏷️  ${splits.length}個の大問にトピックタグを付与中（${subject}: ${topicList.length}トピック）...`,
  );

  // Explicit Context Caching: マスターリスト+共通プロンプトをキャッシュ
  let cachedContentName: string | undefined;
  try {
    const systemInstruction = buildCachedInstruction(
      subject,
      topicList.join("\n"),
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
        ttl: "300s",
        displayName: `kakomon-topics-${subject}`,
      },
    });
    cachedContentName = cached.name;
    console.log(
      `  📦 キャッシュ作成完了: ${cachedContentName} (${cached.usageMetadata?.totalTokenCount ?? "?"} tokens)`,
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
        subject,
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
        await client.caches.delete({ name: cachedContentName });
        console.log("  📦 Context Cache削除完了");
      } catch (err) {
        console.warn(
          `  ⚠ Context Cache削除に失敗: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
