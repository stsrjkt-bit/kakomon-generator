import { GoogleGenerativeAI, type Part } from "@google/generative-ai";

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
  const response = result.response;
  return response.text();
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
  const response = result.response;
  return response.text();
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
  const response = result.response;
  return response.text();
}
