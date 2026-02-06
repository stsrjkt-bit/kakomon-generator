import { askVisionWithImage } from "../lib/gemini.js";
import {
  pdfPageToImage,
  cropImage,
  concatImagesVertically,
  createA4PdfFromImages,
} from "../lib/pdf.js";
import { callWithRetry } from "./detect.js";
import type { QuestionBoundary, BBox, SplitResult, PageRegion } from "../types.js";

/**
 * ラベル文字列をサニタイズする（プロンプトインジェクション対策）
 * 制御文字やプロンプト操作に使われうる文字列を除去する
 */
export function sanitizeLabel(label: string): string {
  return label
    .replace(/[\x00-\x1f\x7f]/g, "") // 制御文字を除去
    .replace(/```/g, "")              // コードブロック記法を除去
    .slice(0, 50);                    // 長さを制限
}

/**
 * Phase 2: 問題の切り出し
 *
 * 各大問について、該当ページを画像化 → Gemini Vision でBBox検出 → sharpで切り抜き
 * 出力: 問題画像(PNG) + 問題PDF(A4)
 */
export async function splitProblems(
  pdfBuffer: Buffer,
  boundaries: QuestionBoundary[],
): Promise<SplitResult[]> {
  // 必要なページの画像をキャッシュ（Promiseベースで並列対応）
  const pageImageCache = new Map<number, Promise<Buffer>>();

  function getPageImage(pageIndex: number): Promise<Buffer> {
    const cached = pageImageCache.get(pageIndex);
    if (cached) return cached;
    const imagePromise = pdfPageToImage(pdfBuffer, pageIndex);
    pageImageCache.set(pageIndex, imagePromise);
    return imagePromise;
  }

  const results = await Promise.all(
    boundaries.map(async (boundary, i) => {
      const questionNumber = i + 1;
      console.log(`  [Phase 2] 大問${questionNumber}「${boundary.label}」を切り出し中...`);

      const { startPage, endPage } = boundary;
      const pageCount = endPage - startPage + 1;
      const croppedImages: Buffer[] = [];
      const regions: PageRegion[] = [];

      if (pageCount === 1) {
        // 単一ページの大問
        const pageImage = await getPageImage(startPage - 1);
        const bbox = await detectBBoxForQuestion(
          pageImage,
          boundary.label,
          "single",
          boundaries,
          i,
        );
        const cropped = await cropImage(pageImage, bbox);
        croppedImages.push(cropped);
        regions.push({ page: startPage, bbox });
      } else {
        // 複数ページにまたがる大問
        for (let p = startPage; p <= endPage; p++) {
          const pageImage = await getPageImage(p - 1);
          let bbox: BBox;

          if (p === startPage) {
            // 先頭ページ: 該当大問の開始位置から下端まで
            bbox = await detectBBoxForQuestion(
              pageImage,
              boundary.label,
              "first",
              boundaries,
              i,
            );
          } else if (p === endPage) {
            // 最終ページ: 上端から該当大問の終了位置まで
            bbox = await detectBBoxForQuestion(
              pageImage,
              boundary.label,
              "last",
              boundaries,
              i,
            );
          } else {
            // 中間ページ: ページ全体を使用
            const sharp = (await import("sharp")).default;
            const metadata = await sharp(pageImage).metadata();
            bbox = {
              x: 0,
              y: 0,
              width: metadata.width!,
              height: metadata.height!,
            };
          }

          const cropped = await cropImage(pageImage, bbox);
          croppedImages.push(cropped);
          regions.push({ page: p, bbox });
        }
      }

      // 切り抜き画像を結合して1枚のPNG
      const imagePng = await concatImagesVertically(croppedImages);

      // 各ページの切り抜き画像をまとめてA4 PDFを生成
      const pdfResult = await createA4PdfFromImages(croppedImages);

      return {
        label: boundary.label,
        questionNumber,
        imagePng,
        pdfBuffer: pdfResult,
        regions,
      } satisfies SplitResult;
    }),
  );

  return results;
}

/**
 * Gemini Vision で問題領域のBBoxを検出する
 *
 * @param pageImage ページ全体の画像
 * @param label 大問ラベル
 * @param position "single" | "first" | "last" - ページの位置
 * @param allBoundaries 全大問の境界情報
 * @param currentIndex 現在処理中の大問のインデックス
 */
async function detectBBoxForQuestion(
  pageImage: Buffer,
  label: string,
  position: "single" | "first" | "last",
  allBoundaries: QuestionBoundary[],
  currentIndex: number,
): Promise<BBox> {
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(pageImage).metadata();
  const imageWidth = metadata.width!;
  const imageHeight = metadata.height!;

  const safeLabel = sanitizeLabel(label);

  let positionInstruction: string;
  if (position === "single") {
    // 同じページに次の大問がある場合、その大問の直前までが対象
    const nextBoundary = allBoundaries[currentIndex + 1];
    const prevBoundary = currentIndex > 0 ? allBoundaries[currentIndex - 1] : null;
    positionInstruction = `この画像は問題用紙の1ページです。「${safeLabel}」の領域全体を囲む矩形を検出してください。`;
    if (nextBoundary && nextBoundary.startPage === allBoundaries[currentIndex].startPage) {
      const safeNextLabel = sanitizeLabel(nextBoundary.label);
      positionInstruction += `\n「${safeNextLabel}」の領域は含めないでください。「${safeLabel}」の領域のみを対象としてください。`;
    }
    if (prevBoundary && prevBoundary.endPage === allBoundaries[currentIndex].startPage) {
      const safePrevLabel = sanitizeLabel(prevBoundary.label);
      positionInstruction += `\n「${safePrevLabel}」の領域は含めないでください。「${safeLabel}」の領域のみを対象としてください。`;
    }
  } else if (position === "first") {
    positionInstruction = `この画像は「${safeLabel}」が始まるページです。「${safeLabel}」の開始位置からページの下端までの領域を矩形で囲んでください。「${safeLabel}」より前にある別の大問の内容は含めないでください。`;
  } else {
    positionInstruction = `この画像は「${safeLabel}」が終わるページです。ページの上端から「${safeLabel}」の終了位置までの領域を矩形で囲んでください。「${safeLabel}」より後にある別の大問の内容は含めないでください。`;
  }

  const prompt = `${positionInstruction}

画像のサイズは幅${imageWidth}ピクセル、高さ${imageHeight}ピクセルです。

検出した矩形領域のピクセル座標を以下のJSON形式で出力してください。JSONのみを出力し、説明は不要です：
{ "x": 左端のx座標, "y": 上端のy座標, "width": 幅, "height": 高さ }

座標はピクセル単位の整数で指定してください。余白を少し含めて読みやすくしてください。`;

  const response = await callWithRetry(() =>
    askVisionWithImage(prompt, pageImage),
  );

  return parseBBoxResponse(response, imageWidth, imageHeight);
}

/**
 * BBoxレスポンスをパースし、画像サイズ内に収まるよう補正する
 */
function parseBBoxResponse(
  response: string,
  imageWidth: number,
  imageHeight: number,
): BBox {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `Failed to parse BBox response: no JSON object found.\nResponse: ${response}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Failed to parse BBox response: invalid JSON.\nResponse: ${response}`,
    );
  }
  let x = parsed.x as number;
  let y = parsed.y as number;
  let width = parsed.width as number;
  let height = parsed.height as number;

  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    throw new Error(`Invalid BBox: ${JSON.stringify(parsed)}`);
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
    throw new Error(
      `BBox has invalid dimensions after clamping: x=${x}, y=${y}, w=${width}, h=${height}`,
    );
  }

  return { x, y, width, height };
}
