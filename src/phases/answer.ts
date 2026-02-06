import { askVisionWithImage } from "../lib/gemini.js";
import {
  pdfPageToImage,
  cropImage,
  concatImagesVertically,
  createA4PdfFromImages,
  getPdfPageCount,
} from "../lib/pdf.js";
import { callWithRetry } from "./detect.js";
import type { QuestionBoundary, BBox, AnswerSplitResult } from "../types.js";

/**
 * Phase 4: 解答の切り出し
 *
 * 解答PDFの各ページを画像化 → Gemini Vision で大問番号ごとのBBox検出
 * Phase 1 で検出した大問番号とマッチする領域を切り抜き
 * 出力: 解答PDF(A4)
 */
export async function splitAnswers(
  answerPdfBuffer: Buffer,
  boundaries: QuestionBoundary[],
): Promise<AnswerSplitResult[]> {
  const totalPages = await getPdfPageCount(answerPdfBuffer);
  const labels = boundaries.map((b) => b.label);

  // 全ページの画像を事前に取得
  const pageImages: Buffer[] = [];
  for (let i = 0; i < totalPages; i++) {
    pageImages.push(await pdfPageToImage(answerPdfBuffer, i));
  }

  // 各ページで大問ごとの領域を検出
  const pageRegions = await detectAnswerRegions(pageImages, labels);

  // 大問ごとに切り抜いて結合
  const results: AnswerSplitResult[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const questionNumber = i + 1;
    console.log(
      `  [Phase 4] 大問${questionNumber}「${boundary.label}」の解答を切り出し中...`,
    );

    const regionsForQuestion = pageRegions
      .filter((r) => r.label === boundary.label)
      .sort((a, b) => a.page - b.page);

    if (regionsForQuestion.length === 0) {
      console.warn(
        `  警告: 大問${questionNumber}「${boundary.label}」の解答領域が見つかりませんでした`,
      );
      // 空のPDFを生成（解答が見つからない場合のフォールバック）
      const sharp = (await import("sharp")).default;
      const placeholder = await sharp({
        create: {
          width: 200,
          height: 100,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      results.push({
        label: boundary.label,
        questionNumber,
        pdfBuffer: await createA4PdfFromImages([placeholder]),
      });
      continue;
    }

    const croppedImages: Buffer[] = [];
    for (const region of regionsForQuestion) {
      const cropped = await cropImage(pageImages[region.page], region.bbox);
      croppedImages.push(cropped);
    }

    // 複数ページの解答は結合してA4 PDFにする
    // 各切り抜き画像をそのままA4の各ページに配置
    const pdfResult = await createA4PdfFromImages(croppedImages);

    results.push({
      label: boundary.label,
      questionNumber,
      pdfBuffer: pdfResult,
    });
  }

  return results;
}

/** ページ内で検出された大問の解答領域 */
interface AnswerRegion {
  label: string;
  page: number; // 0始まりのページインデックス
  bbox: BBox;
}

/**
 * 各ページで大問ごとの解答領域を検出する
 */
async function detectAnswerRegions(
  pageImages: Buffer[],
  labels: string[],
): Promise<AnswerRegion[]> {
  const allRegions: AnswerRegion[] = [];

  for (let pageIndex = 0; pageIndex < pageImages.length; pageIndex++) {
    const pageImage = pageImages[pageIndex];
    const sharp = (await import("sharp")).default;
    const metadata = await sharp(pageImage).metadata();
    const imageWidth = metadata.width!;
    const imageHeight = metadata.height!;

    const labelsStr = labels.map((l) => `「${l}」`).join("、");

    const prompt = `あなたは日本の大学入試の解答PDFを分析するアシスタントです。
この画像は解答用紙の1ページです。

以下の大問の解答が含まれているか確認し、含まれている大問の解答領域をそれぞれ検出してください。
対象の大問: ${labelsStr}

画像のサイズは幅${imageWidth}ピクセル、高さ${imageHeight}ピクセルです。

注意事項：
- このページに含まれていない大問の解答は出力しないでください
- 各大問の解答領域を矩形（BBox）で囲んでください
- 座標はピクセル単位の整数で指定してください
- 余白を少し含めて読みやすくしてください

以下のJSON配列形式で出力してください。JSONのみを出力し、説明は不要です：
[
  { "label": "第1問", "x": 0, "y": 0, "width": 100, "height": 200 }
]

このページにどの大問の解答も含まれていない場合は空の配列 [] を出力してください。`;

    const response = await callWithRetry(() =>
      askVisionWithImage(prompt, pageImage),
    );

    const regions = parseAnswerRegionResponse(
      response,
      pageIndex,
      labels,
      imageWidth,
      imageHeight,
    );
    allRegions.push(...regions);
  }

  return allRegions;
}

/**
 * 解答領域レスポンスをパースする
 */
function parseAnswerRegionResponse(
  response: string,
  pageIndex: number,
  validLabels: string[],
  imageWidth: number,
  imageHeight: number,
): AnswerRegion[] {
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn(`  警告: 解答領域レスポンスのJSONパースに失敗（ページ${pageIndex + 1}）`);
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const regions: AnswerRegion[] = [];

  for (const item of parsed) {
    const record = item as Record<string, unknown>;
    const label = record.label as string;
    let x = record.x as number;
    let y = record.y as number;
    let width = record.width as number;
    let height = record.height as number;

    if (
      !label ||
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number"
    ) {
      continue;
    }

    // 検出されたラベルが有効な大問ラベルに含まれるか確認
    if (!validLabels.includes(label)) {
      continue;
    }

    // 画像サイズ内に収まるよう補正
    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    width = Math.round(width);
    height = Math.round(height);

    if (x + width > imageWidth) {
      width = imageWidth - x;
    }
    if (y + height > imageHeight) {
      height = imageHeight - y;
    }

    if (width <= 0 || height <= 0) {
      continue;
    }

    regions.push({
      label,
      page: pageIndex,
      bbox: { x, y, width, height },
    });
  }

  return regions;
}
