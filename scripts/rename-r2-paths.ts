#!/usr/bin/env tsx
/**
 * R2バケット内の既存ファイルを旧フラット形式から新フォルダ形式にリネームするスクリプト
 *
 * 旧形式: {universityId}/{year}/{subjectKey}_{examType}_{file}.ext
 *   例: akita/2025/physics_zenki_problem.pdf
 *       akita/2025/physics_zenki_q1.png
 *
 * 新形式: {universityId}/{year}/{subjectKey}/{examType}/{file}.ext
 *   例: akita/2025/physics/zenki/problem.pdf
 *       akita/2025/physics/zenki/q1.png
 *
 * 使い方:
 *   npx tsx scripts/rename-r2-paths.ts --dry-run   # 一覧のみ表示
 *   npx tsx scripts/rename-r2-paths.ts              # 確認後にリネーム
 */

import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import * as readline from "readline";

// --- Config ---

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME ?? "kakomon";

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error(
    "Error: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required",
  );
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

const dryRun = process.argv.includes("--dry-run");

// --- Helpers ---

/**
 * 旧フラット形式のキーを新フォルダ形式に変換する
 * 旧: {uid}/{year}/{subjectKey}_{examType}_{file}.ext
 * 新: {uid}/{year}/{subjectKey}/{examType}/{file}.ext
 *
 * 既にフォルダ形式（4階層以上）のキーはnullを返す
 */
function convertKey(key: string): string | null {
  // パスを分解: uid/year/rest
  const parts = key.split("/");

  // 既にフォルダ形式（4階層以上: uid/year/subject/examType/file）なら変換不要
  if (parts.length >= 4) return null;

  // 3階層（uid/year/flatfile）のみ対象
  if (parts.length !== 3) return null;

  const [uid, year, flatFile] = parts;

  // flatFile を最初の2つの _ で分割: subjectKey_examType_rest
  const firstUnderscore = flatFile.indexOf("_");
  if (firstUnderscore === -1) return null;

  const subjectKey = flatFile.substring(0, firstUnderscore);
  const afterSubject = flatFile.substring(firstUnderscore + 1);

  const secondUnderscore = afterSubject.indexOf("_");
  if (secondUnderscore === -1) return null;

  const examType = afterSubject.substring(0, secondUnderscore);
  const file = afterSubject.substring(secondUnderscore + 1);

  if (!subjectKey || !examType || !file) return null;

  return `${uid}/${year}/${subjectKey}/${examType}/${file}`;
}

/** R2バケット内の全オブジェクトキーを取得 */
async function listAllKeys(): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated
      ? res.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return keys;
}

/** ユーザーに確認を求める */
function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/** コピー→削除でリネーム */
async function renameKey(oldKey: string, newKey: string): Promise<void> {
  // コピー
  await client.send(
    new CopyObjectCommand({
      Bucket: bucketName,
      CopySource: `${bucketName}/${oldKey}`,
      Key: newKey,
    }),
  );
  // 旧キーを削除
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: oldKey,
    }),
  );
}

// --- Main ---

async function main() {
  console.log(`Bucket: ${bucketName}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (変更しません)" : "LIVE"}\n`);

  console.log("Listing all objects...");
  const allKeys = await listAllKeys();
  console.log(`Total objects in bucket: ${allKeys.length}\n`);

  const renames: { oldKey: string; newKey: string }[] = [];
  for (const key of allKeys) {
    const newKey = convertKey(key);
    if (newKey) {
      renames.push({ oldKey: key, newKey });
    }
  }

  if (renames.length === 0) {
    console.log("リネーム対象のファイルはありません。全て新形式です。");
    return;
  }

  console.log(`リネーム対象: ${renames.length} files\n`);
  console.log("--- リネーム一覧 ---");
  for (const { oldKey, newKey } of renames) {
    console.log(`  ${oldKey}`);
    console.log(`    → ${newKey}`);
  }
  console.log("--------------------\n");

  if (dryRun) {
    console.log("(--dry-run モードのためリネームはスキップします)");
    return;
  }

  const ok = await confirm(
    `上記 ${renames.length} ファイルをリネームしますか？ (y/N): `,
  );
  if (!ok) {
    console.log("キャンセルしました。");
    return;
  }

  console.log("\nリネーム中...");
  for (let i = 0; i < renames.length; i++) {
    const { oldKey, newKey } = renames[i];
    await renameKey(oldKey, newKey);
    if ((i + 1) % 50 === 0 || i === renames.length - 1) {
      console.log(`  ${i + 1}/${renames.length}`);
    }
  }
  console.log(`\n完了: ${renames.length} ファイルをリネームしました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
