import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required",
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
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
  university: string,
  year: number,
  subject: string,
  examType: string,
  questionNumber: number,
): string {
  return `${university}/${year}/${subject}/${examType}/q${questionNumber}.png`;
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
  return `${university}/${year}/${subject}/${examType}/q${questionNumber}.pdf`;
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
  return `${university}/${year}/${subject}/${examType}/a${questionNumber}.pdf`;
}
