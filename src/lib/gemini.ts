import { GoogleGenAI, type GenerateContentResponse, type Part, ThinkingLevel } from "@google/genai";

// ─── クライアント初期化 ──────────────────────────────

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY environment variable is required");
}

const modelName = process.env.GEMINI_VISION_MODEL ?? "gemini-3-flash-preview";

export const client = new GoogleGenAI({ apiKey });

// ─── usageMetadata ログ出力 ──────────────────────────

function logUsage(response: GenerateContentResponse): void {
  const usage = response.usageMetadata;
  if (usage) {
    console.log(
      `  [usage] prompt=${usage.promptTokenCount} completion=${usage.candidatesTokenCount} total=${usage.totalTokenCount} cached=${usage.cachedContentTokenCount ?? 0}`,
    );
  }
}

/**
 * レスポンスからテキストを安全に抽出する
 */
function extractText(response: GenerateContentResponse): string {
  logUsage(response);

  const text = response.text;
  if (text === undefined) {
    throw new Error("Gemini returned no text response");
  }
  return text;
}

// ─── Vision API 関数群（シグネチャ変更なし） ──────────

/**
 * 画像バッファ (PNG/JPEG) を Gemini Vision に送り、テキスト応答を得る
 */
export async function askVisionWithImage(
  prompt: string,
  imageBuffer: Buffer,
  mimeType: "image/png" | "image/jpeg" = "image/png",
  cachedContent?: string,
  thinkingLevel?: ThinkingLevel,
): Promise<string> {
  const imagePart: Part = {
    inlineData: {
      data: imageBuffer.toString("base64"),
      mimeType,
    },
  };

  const response = await client.models.generateContent({
    model: modelName,
    contents: [{ role: "user", parts: [{ text: prompt }, imagePart] }],
    config: {
      // cachedContent使用時はtools等をキャッシュ側に含める必要がある
      ...(cachedContent
        ? { cachedContent }
        : { tools: [{ codeExecution: {} }] }),
      ...(thinkingLevel && {
        thinkingConfig: { thinkingLevel },
      }),
    },
  });

  return extractText(response);
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

  const response = await client.models.generateContent({
    model: modelName,
    contents: [{ role: "user", parts: [{ text: prompt }, ...parts] }],
    config: {
      tools: [{ codeExecution: {} }],
    },
  });

  return extractText(response);
}

/**
 * PDFバッファを Gemini に送り、テキスト応答を得る
 * thinkingLevel を指定すると thinkingConfig が有効になる
 */
export async function askVisionWithPdf(
  prompt: string,
  pdfBuffer: Buffer,
  thinkingLevel?: ThinkingLevel,
): Promise<string> {
  const pdfPart: Part = {
    inlineData: {
      data: pdfBuffer.toString("base64"),
      mimeType: "application/pdf",
    },
  };

  const response = await client.models.generateContent({
    model: modelName,
    contents: [{ role: "user", parts: [{ text: prompt }, pdfPart] }],
    config: {
      tools: [{ codeExecution: {} }],
      ...(thinkingLevel && {
        thinkingConfig: { thinkingLevel },
      }),
    },
  });

  return extractText(response);
}

// ─── ユーティリティ ──────────────────────────────────

/**
 * GeminiレスポンスからJSON部分を抽出してパースする
 * codeExecution有効時はPythonコード出力が混在するため、
 * 最初の有効なJSON配列またはオブジェクトを探して抽出する
 */
export function extractJson<T>(raw: string): T {
  // 1. マークダウンコードブロック内のJSONを試す
  const codeBlockMatch = raw.match(/```json\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch { /* fall through */ }
  }

  // 2. コードブロックを除去した上でそのままパースを試す
  const stripped = raw
    .replace(/```[\s\S]*?```/g, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch { /* fall through */ }

  // 3. 最初の [ ... ] または { ... } を探してパースする
  const jsonMatch = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch { /* fall through */ }
  }

  throw new Error(
    `Failed to extract JSON from Gemini response: ${raw.slice(0, 300)}`,
  );
}

/**
 * API呼び出しをリトライ付きで実行する
 * 429 (Rate Limit) や 5xx エラー時に指数バックオフでリトライする
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;

      const status = (err as { status?: number }).status;
      const isRetryable =
        status === 429 || (status !== undefined && status >= 500);

      if (!isRetryable) throw err;

      const delay = Math.min(1000 * 2 ** attempt, 16000);
      console.warn(
        `  ⚠ Gemini API error (status=${status}), retrying in ${delay}ms (${attempt + 1}/${maxRetries})...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
