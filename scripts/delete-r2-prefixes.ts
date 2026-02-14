#!/usr/bin/env tsx
/**
 * Strict rebuild helper: delete all R2 objects under given university prefixes.
 *
 * Usage:
 *   npx tsx scripts/delete-r2-prefixes.ts --university-ids kyutech,miyazaki,kumamoto --dry-run
 *   npx tsx scripts/delete-r2-prefixes.ts --university-ids kyutech,miyazaki,kumamoto --force
 */

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const idsRaw = getArg("--university-ids") ?? "";
const universityIds = idsRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (universityIds.length === 0) {
  console.error("Error: --university-ids is required");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
if (!dryRun && !force) {
  console.error("Refusing to run LIVE without --force (use --dry-run first)");
  process.exit(1);
}

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME ?? "kakomon";

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required");
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

async function listAllKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function deleteKeys(keys: string[]) {
  const batchSize = 1000;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    console.log(`  deleted ${Math.min(i + batchSize, keys.length)}/${keys.length}`);
  }
}

async function main() {
  console.log(`Bucket: ${bucketName}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Targets: ${universityIds.join(", ")}`);

  for (const id of universityIds) {
    const prefix = `${id}/`;
    console.log(`\nListing: ${prefix}`);
    const keys = await listAllKeys(prefix);
    console.log(`  objects: ${keys.length}`);
    if (dryRun) {
      for (const k of keys.slice(0, 20)) console.log(`  - ${k}`);
      if (keys.length > 20) console.log(`  ... (${keys.length - 20} more)`);
      continue;
    }
    if (keys.length === 0) continue;
    console.log(`Deleting: ${prefix}`);
    await deleteKeys(keys);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
