/**
 * Phase 1+2 統合: 境界検出 + 領域座標の一括取得
 *
 * 問題PDFをまるごとGemini Visionに1回渡して、
 * 各大問のラベルと全ページにわたる領域座標（割合ベース）を一括取得する。
 *
 * GeminiにはPDFバイナリを直接渡す。画像に変換して渡すことは絶対にしない。
 */

import { askVisionWithPdf, callWithRetry, extractJson } from "../lib/gemini.js";
import { ThinkingLevel } from "@google/genai";
import type { DetectedQuestion } from "../types.js";

/**
 * 問題PDFから全大問の境界と領域座標を一括検出する
 *
 * 1回の askVisionWithPdf 呼び出しで、各大問のラベルと
 * 各ページでの座標（割合ベース 0.0〜1.0）を取得する。
 */
export async function detectQuestions(
  problemPdfBuffer: Buffer,
): Promise<DetectedQuestion[]> {
  const prompt = `この大学入試の問題PDFを見て、各大問の位置を検出してください。

各大問について、以下の情報をJSON配列で返してください:
- label: 大問のラベル（PDFに記載されている通り。例: "第1問", "問1", "1" など）
- regions: その大問が記載されている領域の配列。各要素は以下のフィールドを持つ:
  - page: ページ番号（1始まり）
  - y_start_ratio: 領域の上端の位置（ページ上端を0.0、下端を1.0とした割合）
  - y_end_ratio: 領域の下端の位置（同上）
  - x_start_ratio: 領域の左端の位置（ページ左端を0.0、右端を1.0とした割合）
  - x_end_ratio: 領域の右端の位置（同上）

注意:
- 1つの大問が複数ページにまたがる場合は、regionsにページごとの要素を追加してください。
- 割合は0.0〜1.0の範囲で、小数点以下2桁程度の精度で返してください。
- ヘッダー・フッター・ページ番号は含めないでください。
- 大問の本文・小問・図・表をすべて含む領域を指定してください。
- JSON配列のみを返してください。マークダウンのコードブロックは不要です。

例:
[{"label":"第1問","regions":[{"page":1,"y_start_ratio":0.05,"y_end_ratio":0.48,"x_start_ratio":0.02,"x_end_ratio":0.98}]},{"label":"第2問","regions":[{"page":1,"y_start_ratio":0.52,"y_end_ratio":1.0,"x_start_ratio":0.02,"x_end_ratio":0.98},{"page":2,"y_start_ratio":0.0,"y_end_ratio":0.65,"x_start_ratio":0.02,"x_end_ratio":0.98}]}]`;

  console.log(
    `  📄 問題PDF (${(problemPdfBuffer.length / 1024).toFixed(0)} KB) をGeminiに送信して大問の境界+座標を一括検出中...`,
  );

  const raw = await callWithRetry(() =>
    askVisionWithPdf(prompt, problemPdfBuffer, ThinkingLevel.HIGH),
  );

  const parsed: DetectedQuestion[] = extractJson(raw);

  for (const q of parsed) {
    const pages = q.regions.map((r) => r.page);
    console.log(
      `  📌 ${q.label}: ${q.regions.length}領域 (p${Math.min(...pages)}-${Math.max(...pages)})`,
    );
  }

  return parsed;
}
