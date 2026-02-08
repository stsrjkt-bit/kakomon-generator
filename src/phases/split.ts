/**
 * Phase 2: 問題の切り出し
 *
 * detect.ts から受け取った割合ベースの座標情報を使い、
 * 各大問の問題画像(PNG)と問題PDF(A4)を生成する。
 *
 * この phase では Gemini API を一切呼び出さない。
 * ページ画像化は sharp での切り抜きのためだけに行う。
 */

import {
  pdfPageToImage,
  cropImage,
  concatImagesVertically,
  createA4PdfFromImages,
} from "../lib/pdf.js";
import type {
  DetectedQuestion,
  RegionRatio,
  SplitResult,
  BBox,
  PageRegion,
} from "../types.js";
import sharp from "sharp";

/** ページ画像のキャッシュ（同じページを複数回画像化しないため） */
interface PageImageCache {
  imageBuffer: Buffer;
  width: number;
  height: number;
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
  region: RegionRatio,
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
 * Phase 2: 問題の切り出し
 *
 * detect.ts の検出結果を受け取り、各大問の問題画像(PNG)と問題PDF(A4)を生成する。
 * Gemini API は呼び出さない。
 */
export async function splitProblems(
  problemPdfBuffer: Buffer,
  detectedQuestions: DetectedQuestion[],
): Promise<SplitResult[]> {
  console.log(`  ✂️  ${detectedQuestions.length}個の大問を切り出し中...`);

  // ページ画像キャッシュ（全大問で共有）
  const pageCache = new Map<number, PageImageCache>();

  // 使用されるページを事前に画像化
  const usedPages = new Set<number>();
  for (const q of detectedQuestions) {
    for (const r of q.regions) {
      usedPages.add(r.page);
    }
  }
  for (const pageNum of usedPages) {
    await getPageImage(problemPdfBuffer, pageNum, pageCache);
  }

  const results: SplitResult[] = [];

  for (let i = 0; i < detectedQuestions.length; i++) {
    const question = detectedQuestions[i];

    // ページ番号順にソート
    const sortedRegions = [...question.regions].sort(
      (a, b) => a.page - b.page,
    );

    // 各ページの領域を切り出し
    const croppedImages: Buffer[] = [];
    const pageRegions: PageRegion[] = [];

    for (const region of sortedRegions) {
      const pageImage = await getPageImage(
        problemPdfBuffer,
        region.page,
        pageCache,
      );
      const bbox = ratioToBBox(region, pageImage.width, pageImage.height);
      const cropped = await cropImage(pageImage.imageBuffer, bbox);
      croppedImages.push(cropped);
      pageRegions.push({ page: region.page, bbox });
    }

    // 切り出し画像を縦に結合して1枚のPNG画像にする
    const imagePng = await concatImagesVertically(croppedImages);

    // 切り出し画像群からA4 PDFを生成
    const pdfBuffer = await createA4PdfFromImages(croppedImages);

    results.push({
      label: question.label,
      questionNumber: i + 1,
      imagePng,
      pdfBuffer,
      regions: pageRegions,
    });

    console.log(
      `  ✂️  ${question.label}: ${sortedRegions.length}ページ分を切り出し完了`,
    );
  }

  return results;
}
