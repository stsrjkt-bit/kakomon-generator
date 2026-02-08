#!/usr/bin/env tsx
/**
 * R2バケットから古いパス形式のファイルを削除するスクリプト
 *
 * 対象:
 *   1. 日本語フォルダ名のファイル（例: 秋田大学/...）
 *   2. split/ フォルダ配下のファイル
 *
 * 使い方:
 *   npx tsx scripts/cleanup-r2-old-paths.ts --dry-run   # 一覧のみ表示
 *   npx tsx scripts/cleanup-r2-old-paths.ts              # 確認後に削除
 */

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
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

/** 文字列に日本語文字（ひらがな・カタカナ・漢字）が含まれるか判定 */
function containsJapanese(s: string): boolean {
  return /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]/.test(
    s,
  );
}

/** 削除対象かどうか判定 */
function isTargetKey(key: string): { match: boolean; reason: string } {
  if (containsJapanese(key)) {
    return { match: true, reason: "日本語パス" };
  }
  if (key.startsWith("split/")) {
    return { match: true, reason: "split/" };
  }
  return { match: false, reason: "" };
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

/** オブジェクトを一括削除（1000件ずつ） */
async function deleteKeys(keys: string[]): Promise<void> {
  const batchSize = 1000;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    console.log(
      `  deleted ${Math.min(i + batchSize, keys.length)}/${keys.length}`,
    );
  }
}

// --- Main ---

async function main() {
  console.log(`Bucket: ${bucketName}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (削除しません)" : "LIVE"}\n`);

  console.log("Listing all objects...");
  const allKeys = await listAllKeys();
  console.log(`Total objects in bucket: ${allKeys.length}\n`);

  const targets: { key: string; reason: string }[] = [];
  for (const key of allKeys) {
    const { match, reason } = isTargetKey(key);
    if (match) targets.push({ key, reason });
  }

  if (targets.length === 0) {
    console.log("削除対象のファイルはありません。");
    return;
  }

  console.log(`削除対象: ${targets.length} files\n`);
  console.log("--- 対象ファイル一覧 ---");
  for (const { key, reason } of targets) {
    console.log(`  [${reason}] ${key}`);
  }
  console.log("------------------------\n");

  if (dryRun) {
    console.log("(--dry-run モードのため削除はスキップします)");
    return;
  }

  const ok = await confirm(
    `上記 ${targets.length} ファイルを削除しますか？ (y/N): `,
  );
  if (!ok) {
    console.log("キャンセルしました。");
    return;
  }

  console.log("\n削除中...");
  await deleteKeys(targets.map((t) => t.key));
  console.log(`\n完了: ${targets.length} ファイルを削除しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
