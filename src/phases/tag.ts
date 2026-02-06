import { askVisionWithImage } from "../lib/gemini.js";
import { TOPIC_MASTER, getTopicsForSubject, isValidTopic } from "../constants/topic-master.js";
import { callWithRetry } from "./detect.js";
import type { SplitResult, TagResult } from "../types.js";

/** マスターリストに存在する科目一覧を取得する */
function getValidSubjects(): Set<string> {
  const subjects = new Set<string>();
  for (const topic of TOPIC_MASTER) {
    const slash = topic.indexOf("/");
    if (slash > 0) {
      subjects.add(topic.slice(0, slash));
    }
  }
  return subjects;
}

/**
 * Phase 3: トピック付け
 *
 * 切り出した問題画像(PNG) を Gemini Vision に渡し、
 * topic-master.ts のマスターリストに存在する5階層トピックタグを付与する。
 */
export async function tagQuestions(
  splits: SplitResult[],
  subject: string,
): Promise<TagResult[]> {
  // 科目名をマスターリストに対してバリデーション
  const validSubjects = getValidSubjects();
  if (!validSubjects.has(subject)) {
    console.warn(
      `  警告: 科目「${subject}」はマスターリストに存在しません。有効な科目: ${[...validSubjects].join(", ")}`,
    );
  }

  const subjectTopics = getTopicsForSubject(subject);

  if (subjectTopics.length === 0) {
    console.warn(`  警告: 科目「${subject}」のトピックがマスターリストに見つかりません`);
  }

  const results = await Promise.all(
    splits.map(async (split) => {
      console.log(
        `  [Phase 3] 大問${split.questionNumber}「${split.label}」にトピックを付与中...`,
      );

      const tags = await detectTopics(split.imagePng, subject, subjectTopics);

      return {
        label: split.label,
        questionNumber: split.questionNumber,
        topicTags: tags,
      };
    }),
  );

  return results;
}

/**
 * 問題画像からトピックタグを検出する
 */
async function detectTopics(
  imagePng: Buffer,
  subject: string,
  subjectTopics: string[],
): Promise<string[]> {
  // マスターリストが大きすぎる場合は分割して渡す
  // Geminiのコンテキストに収まるよう、科目のトピック一覧のみを渡す
  const topicList = subjectTopics.join("\n");

  const prompt = `あなたは日本の大学入試問題の分類専門家です。
以下の問題画像を見て、この問題が扱っているトピックを特定してください。

## 制約
- トピックは必ず以下のマスターリストから選んでください
- マスターリストにないトピックは絶対に出力しないでください
- 各トピックは5階層（科目/分野/単元/サブ単元/トピック）の形式です
- 1つの大問に複数のトピックが含まれる場合は全て列挙してください
- 科目は「${subject}」です

## マスターリスト（${subject}）
${topicList}

## 出力形式
以下のJSON配列形式で出力してください。JSONのみを出力し、説明は不要です：
["${subject}/分野/単元/サブ単元/トピック1", "${subject}/分野/単元/サブ単元/トピック2"]`;

  const response = await callWithRetry(() =>
    askVisionWithImage(prompt, imagePng),
  );

  return parseAndValidateTopics(response);
}

/**
 * トピックレスポンスをパースし、マスターリストに存在するもののみ返す
 */
function parseAndValidateTopics(response: string): string[] {
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn(
      `  警告: トピックレスポンスからJSON配列を抽出できませんでした。空のタグリストを返します。`,
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn(
      `  警告: トピックレスポンスのJSONパースに失敗しました。空のタグリストを返します。`,
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn(`  警告: トピックレスポンスが配列ではありません。空のタグリストを返します。`);
    return [];
  }

  const validTopics: string[] = [];
  const invalidTopics: string[] = [];

  for (const topic of parsed) {
    if (typeof topic !== "string") continue;

    if (isValidTopic(topic)) {
      validTopics.push(topic);
    } else {
      invalidTopics.push(topic);
    }
  }

  if (invalidTopics.length > 0) {
    console.warn(
      `  警告: マスターリストに存在しないトピックを除外しました: ${invalidTopics.join(", ")}`,
    );
  }

  return validTopics;
}
