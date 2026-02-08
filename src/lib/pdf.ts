import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BBox } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * PDFバッファから指定ページを画像 (PNG) に変換する
 * pdftoppm を使用（canvas ネイティブモジュール不要）
 */
export async function pdfPageToImage(
  pdfBuffer: Buffer,
  pageIndex: number,
): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf2img-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outPrefix = path.join(tmpDir, "page");
  const pageNum = pageIndex + 1; // pdftoppm は1始まり

  try {
    await fs.writeFile(pdfPath, pdfBuffer);
    await execFileAsync("pdftoppm", [
      "-png",
      "-r", "288", // 288 DPI (≈ scale 2x at 144 base)
      "-f", String(pageNum),
      "-l", String(pageNum),
      pdfPath,
      outPrefix,
    ]);

    // pdftoppm の出力ファイル名を探す（page-01.png, page-001.png 等）
    const files = await fs.readdir(tmpDir);
    const pngFile = files.find((f) => f.startsWith("page") && f.endsWith(".png"));
    if (!pngFile) {
      throw new Error(`pdftoppm produced no output for page ${pageNum}`);
    }

    return await fs.readFile(path.join(tmpDir, pngFile));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * PDFバッファの全ページを画像 (PNG) に変換する
 */
export async function pdfAllPagesToImages(
  pdfBuffer: Buffer,
): Promise<Buffer[]> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf2img-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outPrefix = path.join(tmpDir, "page");

  try {
    await fs.writeFile(pdfPath, pdfBuffer);
    await execFileAsync("pdftoppm", [
      "-png",
      "-r", "288",
      pdfPath,
      outPrefix,
    ]);

    const files = (await fs.readdir(tmpDir))
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();

    const images: Buffer[] = [];
    for (const f of files) {
      images.push(await fs.readFile(path.join(tmpDir, f)));
    }
    return images;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 画像バッファから BBox 領域を切り抜く
 */
export async function cropImage(
  imageBuffer: Buffer,
  bbox: BBox,
): Promise<Buffer> {
  return sharp(imageBuffer)
    .extract({
      left: Math.round(bbox.x),
      top: Math.round(bbox.y),
      width: Math.round(bbox.width),
      height: Math.round(bbox.height),
    })
    .png()
    .toBuffer();
}

/**
 * 複数の切り抜き画像を縦方向に結合する（複数ページにまたがる大問用）
 */
export async function concatImagesVertically(
  imageBuffers: Buffer[],
): Promise<Buffer> {
  if (imageBuffers.length === 0) {
    throw new Error("No images to concatenate");
  }
  if (imageBuffers.length === 1) {
    return imageBuffers[0];
  }

  const metadataList = await Promise.all(
    imageBuffers.map((buf) => sharp(buf).metadata()),
  );

  for (const m of metadataList) {
    if (!m.width || !m.height) {
      throw new Error("Image metadata missing width or height");
    }
  }

  const maxWidth = Math.max(
    ...metadataList.map((m) => m.width!),
  );
  const totalHeight = metadataList.reduce(
    (sum, m) => sum + m.height!,
    0,
  );

  // 各画像を上から順に配置
  let yOffset = 0;
  const compositeInputs = imageBuffers.map((buf, i) => {
    const input = { input: buf, left: 0, top: yOffset };
    yOffset += metadataList[i].height!;
    return input;
  });

  return sharp({
    create: {
      width: maxWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(compositeInputs)
    .png()
    .toBuffer();
}

/**
 * 切り抜き画像群からA4サイズのPDFを生成する
 * 各画像を1ページとしてA4に収める
 */
export async function createA4PdfFromImages(
  imageBuffers: Buffer[],
): Promise<Buffer> {
  const A4_WIDTH = 595.28;
  const A4_HEIGHT = 841.89;
  const MARGIN = 36; // 0.5inch margin

  const pdfDoc = await PDFDocument.create();
  const usableWidth = A4_WIDTH - MARGIN * 2;
  const usableHeight = A4_HEIGHT - MARGIN * 2;

  for (const imgBuf of imageBuffers) {
    const metadata = await sharp(imgBuf).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Image metadata missing width or height");
    }
    const imgWidth = metadata.width;
    const imgHeight = metadata.height;

    // A4の使用可能領域に収まるようスケーリング
    const scale = Math.min(
      usableWidth / imgWidth,
      usableHeight / imgHeight,
      1, // 元サイズより大きくしない
    );

    const drawWidth = imgWidth * scale;
    const drawHeight = imgHeight * scale;

    const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);

    const pngImage = await pdfDoc.embedPng(imgBuf);
    page.drawImage(pngImage, {
      x: MARGIN + (usableWidth - drawWidth) / 2,
      y: A4_HEIGHT - MARGIN - drawHeight, // PDF座標は左下原点
      width: drawWidth,
      height: drawHeight,
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * PDFのページ数を取得する
 */
export async function getPdfPageCount(pdfBuffer: Buffer): Promise<number> {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  return pdfDoc.getPageCount();
}
