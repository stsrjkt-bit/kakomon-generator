import { GoogleGenerativeAI, type GenerateContentResult, type Part } from "@google/generative-ai";

/**
 * レスポンスからテキストを安全に抽出する
 * セーフティブロック時にはエラーをスローする
 */
function extractText(result: GenerateContentResult): string {
  const blockReason = result.response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Gemini blocked the request: ${blockReason}`);
  }
  return result.response.text();
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY environment variable is required");
}

const modelName = process.env.GEMINI_VISION_MODEL ?? "gemini-3-flash-preview";
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: modelName });

/**
 * 画像バッファ (PNG/JPEG) を Gemini Vision に送り、テキスト応答を得る
 */
export async function askVisionWithImage(
  prompt: string,
  imageBuffer: Buffer,
  mimeType: "image/png" | "image/jpeg" = "image/png",
): Promise<string> {
  const imagePart: Part = {
    inlineData: {
      data: imageBuffer.toString("base64"),
      mimeType,
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  return extractText(result);
}

/**
 * 複数画像を Gemini Vision に送り、テキスト応答を得る
 */
export async function askVisionWithImages(
  prompt: string,
  images: { buffer: Buffer; mimeType: "image/png" | "image/jpeg" }[],
): Promise<string> {
  const parts: Part[] = images.map((img) => ({
    inlineData: {
      data: img.buffer.toString("base64"),
      mimeType: img.mimeType,
    },
  }));

  const result = await model.generateContent([prompt, ...parts]);
  return extractText(result);
}

/**
 * PDFバッファを Gemini に送り、テキスト応答を得る
 */
export async function askVisionWithPdf(
  prompt: string,
  pdfBuffer: Buffer,
): Promise<string> {
  const pdfPart: Part = {
    inlineData: {
      data: pdfBuffer.toString("base64"),
      mimeType: "application/pdf",
    },
  };

  const result = await model.generateContent([prompt, pdfPart]);
  return extractText(result);
}
