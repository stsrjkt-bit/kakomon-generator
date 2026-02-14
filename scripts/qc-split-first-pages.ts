#!/usr/bin/env tsx
/**
 * QC helper: download split outputs from R2 and render 1st-page PNGs for manual review.
 *
 * Input expects a "split fixes" JSON file (array) containing entries like:
 * - { action:"split", university_id, year, exam_type, exam_variant, content_type, bundled_subjects:[...] }
 *
 * Usage:
 *   npx -s tsx scripts/qc-split-first-pages.ts --split-fixes path/to/fixes-split.json --out-dir /tmp/split-qc
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

type SplitFixEntry = {
  university_id: string;
  year: number;
  exam_type: string;
  exam_variant: string | null;
  content_type: "problem" | "answer";
  bundled_subjects: string[] | null;
  action: "split";
  // Optional: if you ever split into variants, this will be used.
  subject_variant?: string | null;
};

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function cmdExists(cmd: string): boolean {
  const r = spawnSync("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1`]);
  return r.status === 0;
}

function generateR2Path(params: {
  university_id: string;
  year: number;
  subject_id: string;
  subject_variant: string | null;
  exam_type: string;
  exam_variant: string | null;
  content_type: string;
}): string {
  const subjectPart = params.subject_variant
    ? `${params.subject_id}_${params.subject_variant}`
    : params.subject_id;
  const examPart = params.exam_variant
    ? `${params.exam_type}_${params.exam_variant}`
    : params.exam_type;
  return `${params.university_id}/${params.year}/${subjectPart}/${examPart}/${params.content_type}.pdf`;
}

async function streamToBuffer(body: any): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function pdftoppmFirstPage(pdfPath: string, outStem: string) {
  const r = spawnSync("pdftoppm", ["-f", "1", "-l", "1", "-png", pdfPath, outStem], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`pdftoppm failed: ${r.stderr || r.stdout}`);
  }
}

function parseEntries(jsonPath: string): SplitFixEntry[] {
  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as unknown;
  const arr = Array.isArray(raw)
    ? raw
    : (raw as any)?.entries ?? (raw as any)?.items ?? (raw as any)?.fixes;
  if (!Array.isArray(arr)) {
    throw new Error(`Invalid JSON shape: expected array (or {entries/items/fixes: array}): ${jsonPath}`);
  }
  const split = (arr as any[]).filter((e) => e?.action === "split");
  return split as SplitFixEntry[];
}

async function main() {
  const splitFixesPath = getArg("--split-fixes");
  const outDir = getArg("--out-dir") ?? "/tmp/split-qc";
  if (!splitFixesPath) {
    console.error("Error: --split-fixes is required");
    process.exit(1);
  }

  if (!cmdExists("pdftoppm")) {
    console.error("Error: pdftoppm not found (install poppler utils)");
    process.exit(1);
  }

  const accountId = mustGetEnv("R2_ACCOUNT_ID");
  const accessKeyId = mustGetEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = mustGetEnv("R2_SECRET_ACCESS_KEY");
  const bucketName = process.env.R2_BUCKET_NAME ?? "kakomon";

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  mkdirSync(outDir, { recursive: true });
  const splitEntries = parseEntries(splitFixesPath);

  const keys: string[] = [];
  for (const e of splitEntries) {
    if (!e.university_id || !e.year || !e.exam_type || !e.content_type) {
      throw new Error(`split entry missing required fields: ${JSON.stringify(e)}`);
    }
    if (!e.bundled_subjects || e.bundled_subjects.length === 0) {
      throw new Error(`bundled_subjects missing/empty for split entry: ${JSON.stringify(e)}`);
    }
    for (const sid of e.bundled_subjects) {
      keys.push(
        generateR2Path({
          university_id: e.university_id,
          year: e.year,
          subject_id: sid,
          subject_variant: e.subject_variant ?? null,
          exam_type: e.exam_type,
          exam_variant: e.exam_variant ?? null,
          content_type: e.content_type,
        }),
      );
    }
  }

  console.log(`Split entries: ${splitEntries.length}`);
  console.log(`Keys: ${keys.length}`);

  for (const key of keys) {
    const base = safeName(key.replace(/\//g, "__"));
    const pdfPath = join(outDir, `${base}.pdf`);
    const outStem = join(outDir, `${base}`);
    const pngPath = `${outStem}-1.png`;

    let buf: Buffer;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
      // eslint-disable-next-line no-await-in-loop
      buf = await streamToBuffer((res as any).Body);
    } catch {
      console.warn(`SKIP missing key: ${key}`);
      continue;
    }

    writeFileSync(pdfPath, buf);
    pdftoppmFirstPage(pdfPath, outStem);
    console.log(`OK ${key} -> ${pngPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

