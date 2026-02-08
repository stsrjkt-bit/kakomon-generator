import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

let r2Client: S3Client | null = null;

function getR2Client(): S3Client {
  if (r2Client) return r2Client;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required",
    );
  }

  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return r2Client;
}

const bucketName = process.env.R2_BUCKET_NAME ?? "kakomon";

/**
 * R2にファイルをアップロードし、ストレージパスを返す
 */
export async function uploadToR2(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const client = getR2Client();

  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  return key;
}

/** パスセグメントをサニタイズする（"/" を "_" に置換） */
function sanitize(segment: string): string {
  return segment.replace(/\//g, "_");
}

/**
 * 問題画像のR2キーを生成する
 */
export function problemImageKey(
  university: string,
  year: number,
  subject: string,
  examType: string,
  questionNumber: number,
): string {
  return `${sanitize(university)}/${year}/${sanitize(subject)}/${sanitize(examType)}/q${questionNumber}.png`;
}

/**
 * 問題PDFのR2キーを生成する
 */
export function problemPdfKey(
  university: string,
  year: number,
  subject: string,
  examType: string,
  questionNumber: number,
): string {
  return `${sanitize(university)}/${year}/${sanitize(subject)}/${sanitize(examType)}/q${questionNumber}.pdf`;
}

/**
 * 解答PDFのR2キーを生成する
 */
export function answerPdfKey(
  university: string,
  year: number,
  subject: string,
  examType: string,
  questionNumber: number,
): string {
  return `${sanitize(university)}/${year}/${sanitize(subject)}/${sanitize(examType)}/a${questionNumber}.pdf`;
}

/**
 * オリジナルPDFのR2キーを生成する
 */
export function originalPdfKey(
  university: string,
  year: number,
  subject: string,
  examType: string,
  contentType: "problem" | "answer",
): string {
  return `${sanitize(university)}/${year}/${sanitize(subject)}/${sanitize(examType)}/${contentType}.pdf`;
}
