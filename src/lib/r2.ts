import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

/** 科目名（日本語）→ ASCIIキーのマッピング */
const SUBJECT_KEY_MAP: Record<string, string> = {
  数学: "math",
  物理: "physics",
  化学: "chemistry",
  生物: "biology",
  英語: "english",
  国語: "japanese",
};

/**
 * 科目名（日本語）をASCIIキーに変換する
 * マッピングに存在しない場合はエラー
 */
export function resolveSubjectKey(subject: string): string {
  const key = SUBJECT_KEY_MAP[subject];
  if (!key) {
    const valid = Object.keys(SUBJECT_KEY_MAP).join(", ");
    throw new Error(`Unknown subject: "${subject}" (valid: ${valid})`);
  }
  return key;
}

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

/**
 * 問題画像のR2キーを生成する
 */
export function problemImageKey(
  universityId: string,
  year: number,
  subjectKey: string,
  examType: string,
  questionNumber: number,
): string {
  return `${universityId}/${year}/${subjectKey}/${examType}/q${questionNumber}.png`;
}

/**
 * 問題PDFのR2キーを生成する
 */
export function problemPdfKey(
  universityId: string,
  year: number,
  subjectKey: string,
  examType: string,
  questionNumber: number,
): string {
  return `${universityId}/${year}/${subjectKey}/${examType}/q${questionNumber}.pdf`;
}

/**
 * 解答PDFのR2キーを生成する
 */
export function answerPdfKey(
  universityId: string,
  year: number,
  subjectKey: string,
  examType: string,
  questionNumber: number,
): string {
  return `${universityId}/${year}/${subjectKey}/${examType}/a${questionNumber}.pdf`;
}

/**
 * オリジナルPDFのR2キーを生成する
 */
export function originalPdfKey(
  universityId: string,
  year: number,
  subjectKey: string,
  examType: string,
  contentType: "problem" | "answer",
): string {
  return `${universityId}/${year}/${subjectKey}/${examType}/${contentType}.pdf`;
}
