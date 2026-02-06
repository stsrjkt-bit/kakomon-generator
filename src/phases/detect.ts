import { askVisionWithPdf } from "../lib/gemini.js";
import type { QuestionBoundary } from "../types.js";

/**
 * Phase 1: 境界検出
 *
 * 問題PDF全体をバイナリのまま Gemini Vision に渡し、
 * 大問ごとの { label, startPage, endPage } を検出する。
 */
export async function detectBoundaries(
  pdfBuffer: Buffer,
): Promise<QuestionBoundary[]> {
  const prompt = `あなたは日本の大学入試の問題PDFを分析するアシスタントです。
このPDFに含まれる大問（独立した問題のまとまり）を検出してください。

大問のラベルパターンは以下のようなものがあります：
- 「第1問」「第2問」…
- 「問1」「問2」…
- 「[1]」「[2]」…
- 「1.」「2.」…
- 「Ⅰ」「Ⅱ」「Ⅲ」…
- 「I」「II」「III」…
- 「1」「2」「3」…（大きい番号のみ）

注意事項：
- 大問の中の小問（(1), (2), (a), (b) など）は独立した大問として数えないでください
- 各大問が何ページ目から何ページ目にまたがっているかを特定してください
- ページ番号は1始まりです
- 複数ページにまたがる大問もあります（例: 第1問が1ページ目から2ページ目まで）

以下のJSON形式で出力してください。JSONのみを出力し、説明は不要です：
[
  { "label": "第1問", "start_page": 1, "end_page": 1 },
  { "label": "第2問", "start_page": 2, "end_page": 3 }
]`;

  const response = await callWithRetry(() =>
    askVisionWithPdf(prompt, pdfBuffer),
  );

  return parseBoundaryResponse(response);
}

/**
 * Gemini のレスポンスを QuestionBoundary[] にパースする
 */
function parseBoundaryResponse(response: string): QuestionBoundary[] {
  // JSON部分を抽出（コードブロックで囲まれている場合にも対応）
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(
      `Failed to parse boundary detection response: no JSON array found.\nResponse: ${response}`,
    );
  }

  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) {
    throw new Error("Boundary detection response is not an array");
  }

  const boundaries: QuestionBoundary[] = parsed.map(
    (item: Record<string, unknown>, index: number) => {
      const label = item.label as string;
      const startPage = item.start_page as number;
      const endPage = item.end_page as number;

      if (!label || typeof startPage !== "number" || typeof endPage !== "number") {
        throw new Error(
          `Invalid boundary at index ${index}: ${JSON.stringify(item)}`,
        );
      }
      if (startPage < 1 || endPage < startPage) {
        throw new Error(
          `Invalid page range at index ${index}: start=${startPage}, end=${endPage}`,
        );
      }

      return { label, startPage, endPage };
    },
  );

  if (boundaries.length === 0) {
    throw new Error("No question boundaries detected");
  }

  return boundaries;
}

/**
 * 429エラー（レートリミット）に対してexponential backoffでリトライする
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 5,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const isRateLimit =
        error instanceof Error &&
        (error.message.includes("429") ||
          error.message.includes("RESOURCE_EXHAUSTED") ||
          error.message.includes("rate limit"));

      if (!isRateLimit || attempt === maxRetries) {
        throw error;
      }

      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
      console.warn(
        `  Rate limited (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay / 1000}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}
