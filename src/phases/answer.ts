/**
 * Phase 4: 解答の切り出し
 *
 * 解答PDFをまるごとGemini Visionに渡して全ページ分の解答領域を一括検出し、
 * 各大問の解答を切り出してA4 PDFを生成する。
 *
 * PDFを画像化してGeminiに渡すことは絶対にしない。
 * GeminiにはPDFバイナリを直接渡す。
 * ページ画像化はBBox変換と切り抜きのためだけに行う。
 */

import { askVisionWithPdf, callWithRetry, extractJson } from "../lib/gemini.js";
import { ThinkingLevel } from "@google/genai";
import {
  pdfPageToImage,
  cropImage,
  createA4PdfFromImages,
} from "../lib/pdf.js";
import type {
  QuestionBoundary,
  AnswerSplitResult,
  BBox,
} from "../types.js";
import sharp from "sharp";

/** Geminiから返されるページ内の解答領域（割合ベース） */
interface AnswerRegionRatio {
  label: string;
  /** ページ番号（1始まり） */
  page: number;
  y_start_ratio: number;
  y_end_ratio: number;
  x_start_ratio: number;
  x_end_ratio: number;
}

/** ページ画像のキャッシュ（同じページを複数回画像化しないため） */
interface PageImageCache {
  imageBuffer: Buffer;
  width: number;
  height: number;
}

/**
 * 解答PDFをまるごとGeminiに渡して全大問の解答領域を一括検出する
 */
async function detectAnswerRegions(
  answerPdfBuffer: Buffer,
  boundaries: QuestionBoundary[],
): Promise<AnswerRegionRatio[]> {
  const questionList = boundaries
    .map((b) => `"${b.label}"`)
    .join(", ");

  const prompt = `この大学入試の解答PDFを見て、各大問の解答が記載されている領域を検出してください。

検出対象の大問: ${questionList}

各大問の解答領域について、以下の情報をJSON配列で返してください:
- label: 大問のラベル（上記の大問ラベルと完全一致させること）
- page: その解答が記載されているページ番号（1始まり）
- y_start_ratio: 解答領域の上端の位置（ページ上端を0.0、下端を1.0とした割合）
- y_end_ratio: 解答領域の下端の位置（同上）
- x_start_ratio: 解答領域の左端の位置（ページ左端を0.0、右端を1.0とした割合）
- x_end_ratio: 解答領域の右端の位置（同上）

注意:
- 1つの大問の解答が複数ページにまたがる場合は、ページごとに別の要素として返してください。
- 割合は0.0〜1.0の範囲で、小数点以下2桁程度の精度で返してください。
- ヘッダー・フッター・ページ番号は含めないでください。
- JSON配列のみを返してください。マークダウンのコードブロックは不要です。

例:
[{"label":"第1問","page":1,"y_start_ratio":0.0,"y_end_ratio":0.45,"x_start_ratio":0.0,"x_end_ratio":1.0},{"label":"第2問","page":1,"y_start_ratio":0.45,"y_end_ratio":1.0,"x_start_ratio":0.0,"x_end_ratio":1.0},{"label":"第3問","page":2,"y_start_ratio":0.0,"y_end_ratio":0.5,"x_start_ratio":0.0,"x_end_ratio":1.0}]`;

  const raw = await callWithRetry(() =>
    askVisionWithPdf(prompt, answerPdfBuffer, ThinkingLevel.HIGH),
  );

  const parsed: AnswerRegionRatio[] = extractJson(raw);
  return parsed;
}

/**
 * ページ画像を取得し、サイズ情報をキャッシュから返す
 */
async function getPageImage(
  pdfBuffer: Buffer,
  pageNumber: number,
  cache: Map<number, PageImageCache>,
): Promise<PageImageCache> {
  const cached = cache.get(pageNumber);
  if (cached) return cached;

  // pageNumber は1始まり、pdfPageToImage は0始まりのインデックス
  const imageBuffer = await pdfPageToImage(pdfBuffer, pageNumber - 1);
  const metadata = await sharp(imageBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Page ${pageNumber} image metadata missing dimensions`);
  }

  const entry: PageImageCache = {
    imageBuffer,
    width: metadata.width,
    height: metadata.height,
  };
  cache.set(pageNumber, entry);
  return entry;
}

/**
 * 割合ベースの領域をピクセル座標のBBoxに変換する
 */
function ratioToBBox(
  region: AnswerRegionRatio,
  pageWidth: number,
  pageHeight: number,
): BBox {
  const x = Math.round(region.x_start_ratio * pageWidth);
  const y = Math.round(region.y_start_ratio * pageHeight);
  const width = Math.round(
    (region.x_end_ratio - region.x_start_ratio) * pageWidth,
  );
  const height = Math.round(
    (region.y_end_ratio - region.y_start_ratio) * pageHeight,
  );

  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.max(1, Math.min(width, pageWidth - x)),
    height: Math.max(1, Math.min(height, pageHeight - y)),
  };
}

/**
 * Phase 4: 解答の切り出し
 *
 * 解答PDFと大問境界情報を受け取り、各大問の解答をA4 PDFとして切り出す。
 */
export async function splitAnswers(
  answerPdfBuffer: Buffer,
  boundaries: QuestionBoundary[],
): Promise<AnswerSplitResult[]> {
  console.log(
    `  📄 解答PDF (${(answerPdfBuffer.length / 1024).toFixed(0)} KB) をGeminiに送信して解答領域を一括検出中...`,
  );

  // 1. 解答PDFをまるごとGeminiに渡して全大問の解答領域を一括取得
  const regions = await detectAnswerRegions(answerPdfBuffer, boundaries);
  console.log(`  📄 ${regions.length}個の解答領域を検出`);

  // 2. 必要なページを画像化してピクセルサイズを取得（キャッシュ付き）
  const pageCache = new Map<number, PageImageCache>();
  const usedPages = [...new Set(regions.map((r) => r.page))];
  for (const pageNum of usedPages) {
    await getPageImage(answerPdfBuffer, pageNum, pageCache);
  }

  // 3. 大問ごとにグループ化して切り出し
  const results: AnswerSplitResult[] = [];

  for (const boundary of boundaries) {
    const questionRegions = regions.filter(
      (r) => r.label === boundary.label,
    );

    if (questionRegions.length === 0) {
      console.warn(`  ⚠ ${boundary.label} の解答領域が見つかりませんでした`);
      continue;
    }

    // ページ番号順にソート
    questionRegions.sort((a, b) => a.page - b.page);

    // 各ページの領域を切り出し
    const croppedImages: Buffer[] = [];
    for (const region of questionRegions) {
      const pageImage = await getPageImage(
        answerPdfBuffer,
        region.page,
        pageCache,
      );
      const bbox = ratioToBBox(region, pageImage.width, pageImage.height);
      const cropped = await cropImage(pageImage.imageBuffer, bbox);
      croppedImages.push(cropped);
    }

    // 切り出し画像からA4 PDFを生成
    const pdfBuffer = await createA4PdfFromImages(croppedImages);

    const questionNumber = boundaries.indexOf(boundary) + 1;
    results.push({
      label: boundary.label,
      questionNumber,
      pdfBuffer,
    });

    console.log(
      `  ✂️  ${boundary.label}: ${questionRegions.length}ページ分の解答を切り出し`,
    );
  }

  return results;
}
