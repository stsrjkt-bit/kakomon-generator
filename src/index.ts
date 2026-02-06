#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Command } from "commander";

import { detectBoundaries } from "./phases/detect.js";
import { splitProblems } from "./phases/split.js";
import { tagQuestions } from "./phases/tag.js";
import { splitAnswers } from "./phases/answer.js";

import {
  uploadToR2,
  problemImageKey,
  problemPdfKey,
  answerPdfKey,
} from "./lib/r2.js";
import {
  upsertUniversity,
  createDocument,
  createQuestion,
} from "./lib/supabase.js";

import type { ExamType, AnswerSplitResult } from "./types.js";

/**
 * ストレージパスセグメントをサニタイズする（パストラバーサル対策）
 * ".." や "/" を除去し、安全なファイルパスセグメントにする
 */
function sanitizePathSegment(segment: string): string {
  return segment
    .replace(/\.\./g, "")
    .replace(/[/\\]/g, "_")
    .replace(/[^\p{L}\p{N}_\-. ]/gu, "")
    .trim() || "unknown";
}

const program = new Command();

program
  .name("kakomon-generate")
  .description(
    "大学入試の過去問PDFから大問ごとに問題画像・問題PDF・解答PDF・トピックタグを生成する",
  )
  .requiredOption("--problem <path>", "問題PDFのパス")
  .option("--answer <path>", "解答PDFのパス（省略時はPhase 4をスキップ）")
  .requiredOption("--subject <subject>", "科目名（例: 数学）")
  .requiredOption("--university <name>", "大学名（例: 東京大学）")
  .requiredOption("--year <year>", "出題年度", parseInt)
  .option(
    "--exam-type <type>",
    "試験種別（zenki / kouki / center / kyotsu）省略可",
  )
  .option("--out-dir <dir>", "ローカル出力ディレクトリ（dry-run時のみ使用）", "./output")
  .option("--dry-run", "アップロード・DB書き込みせず結果だけ表示", false)
  .action(run);

program.parse();

async function run(opts: {
  problem: string;
  answer?: string;
  subject: string;
  university: string;
  year: number;
  examType?: string;
  outDir: string;
  dryRun: boolean;
}): Promise<void> {
  const validExamTypes: ExamType[] = ["zenki", "kouki", "center", "kyotsu"];
  let examType: ExamType | null = null;
  if (opts.examType) {
    if (!validExamTypes.includes(opts.examType as ExamType)) {
      console.error(
        `エラー: 無効な試験種別「${opts.examType}」。有効な値: ${validExamTypes.join(", ")}`,
      );
      process.exit(1);
    }
    examType = opts.examType as ExamType;
  }

  // ========================================
  // 入力ファイルの読み込み
  // ========================================
  console.log("入力ファイルを読み込み中...");
  const problemPath = resolve(opts.problem);
  const problemPdf = await readFile(problemPath);

  let answerPdf: Buffer | null = null;
  if (opts.answer) {
    const answerPath = resolve(opts.answer);
    answerPdf = await readFile(answerPath);
  }

  // ========================================
  // Phase 1: 境界検出
  // ========================================
  console.log("\n[Phase 1] 境界検出中...");
  const boundaries = await detectBoundaries(problemPdf);

  console.log(`  検出された大問: ${boundaries.length}件`);
  for (const b of boundaries) {
    console.log(
      `    ${b.label}: ページ ${b.startPage}${b.startPage !== b.endPage ? `〜${b.endPage}` : ""}`,
    );
  }

  // ========================================
  // Phase 2: 問題の切り出し
  // ========================================
  console.log("\n[Phase 2] 問題の切り出し中...");
  const splits = await splitProblems(problemPdf, boundaries);

  for (const s of splits) {
    console.log(
      `  ✓ 大問${s.questionNumber}「${s.label}」: PNG ${formatBytes(s.imagePng.length)}, PDF ${formatBytes(s.pdfBuffer.length)}`,
    );
  }

  // ========================================
  // Phase 3: トピック付け
  // ========================================
  console.log("\n[Phase 3] トピック付け中...");
  const tags = await tagQuestions(splits, opts.subject);

  for (const t of tags) {
    console.log(`  ✓ 大問${t.questionNumber}「${t.label}」:`);
    if (t.topicTags.length === 0) {
      console.log(`    (トピックなし)`);
    } else {
      for (const tag of t.topicTags) {
        console.log(`    - ${tag}`);
      }
    }
  }

  // ========================================
  // Phase 4: 解答の切り出し
  // ========================================
  let answerSplits: AnswerSplitResult[] = [];
  if (answerPdf) {
    console.log("\n[Phase 4] 解答の切り出し中...");
    answerSplits = await splitAnswers(answerPdf, boundaries);

    for (const a of answerSplits) {
      console.log(
        `  ✓ 大問${a.questionNumber}「${a.label}」: PDF ${formatBytes(a.pdfBuffer.length)}`,
      );
    }
  } else {
    console.log("\n[Phase 4] 解答PDFが指定されていないためスキップ");
  }

  // ========================================
  // 結果の出力
  // ========================================
  if (opts.dryRun) {
    await handleDryRun(opts, splits, tags, answerSplits);
  } else {
    await handleUpload(opts, examType, problemPdf, answerPdf, splits, tags, answerSplits);
  }

  console.log("\n完了!");
}

/**
 * dry-run モード: ローカルにファイルを保存
 */
async function handleDryRun(
  opts: { outDir: string; university: string; year: number; subject: string },
  splits: Awaited<ReturnType<typeof splitProblems>>,
  tags: Awaited<ReturnType<typeof tagQuestions>>,
  answerSplits: AnswerSplitResult[],
): Promise<void> {
  console.log("\n[dry-run] ローカルに結果を保存中...");

  const outDir = resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });

  for (const split of splits) {
    const prefix = `q${split.questionNumber}`;
    await writeFile(join(outDir, `${prefix}.png`), split.imagePng);
    await writeFile(join(outDir, `${prefix}.pdf`), split.pdfBuffer);
    console.log(`  保存: ${prefix}.png, ${prefix}.pdf`);
  }

  for (const answer of answerSplits) {
    const filename = `a${answer.questionNumber}.pdf`;
    await writeFile(join(outDir, filename), answer.pdfBuffer);
    console.log(`  保存: ${filename}`);
  }

  // タグ情報をJSONで保存
  const tagSummary = tags.map((t) => ({
    label: t.label,
    questionNumber: t.questionNumber,
    topicTags: t.topicTags,
  }));
  await writeFile(
    join(outDir, "tags.json"),
    JSON.stringify(tagSummary, null, 2),
  );
  console.log("  保存: tags.json");
}

/**
 * 本番モード: R2にアップロード、Supabaseに書き込み
 */
async function handleUpload(
  opts: { university: string; year: number; subject: string },
  examType: ExamType | null,
  problemPdf: Buffer,
  answerPdf: Buffer | null,
  splits: Awaited<ReturnType<typeof splitProblems>>,
  tags: Awaited<ReturnType<typeof tagQuestions>>,
  answerSplits: AnswerSplitResult[],
): Promise<void> {
  console.log("\n[Upload] R2にアップロード、Supabaseに書き込み中...");

  // 大学レコードを取得/作成
  const universityId = await upsertUniversity(opts.university);
  console.log(`  大学ID: ${universityId}`);

  // 問題ドキュメントレコードを作成
  const safeUniversity = sanitizePathSegment(opts.university);
  const safeSubject = sanitizePathSegment(opts.subject);
  const examSegment = examType ?? "general";
  const problemStoragePath = `${safeUniversity}/${opts.year}/${safeSubject}/${examSegment}/problem.pdf`;
  await uploadToR2(problemStoragePath, problemPdf, "application/pdf");
  const problemDocId = await createDocument({
    universityId,
    year: opts.year,
    subject: opts.subject,
    examType,
    contentType: "problem",
    pdfStoragePath: problemStoragePath,
  });
  console.log(`  問題ドキュメントID: ${problemDocId}`);

  // 解答ドキュメントレコードを作成（解答PDFがある場合）
  let answerDocId: string | null = null;
  if (answerPdf) {
    const answerStoragePath = `${safeUniversity}/${opts.year}/${safeSubject}/${examSegment}/answer.pdf`;
    await uploadToR2(answerStoragePath, answerPdf, "application/pdf");
    answerDocId = await createDocument({
      universityId,
      year: opts.year,
      subject: opts.subject,
      examType,
      contentType: "answer",
      pdfStoragePath: answerStoragePath,
    });
    console.log(`  解答ドキュメントID: ${answerDocId}`);
  }

  // 各大問のファイルをアップロード、DBに書き込み
  for (const split of splits) {
    const qn = split.questionNumber;

    // 問題画像をR2にアップロード
    const imgKey = problemImageKey(
      safeUniversity,
      opts.year,
      safeSubject,
      examSegment,
      qn,
    );
    await uploadToR2(imgKey, split.imagePng, "image/png");

    // 問題PDFをR2にアップロード
    const pdfKey = problemPdfKey(
      safeUniversity,
      opts.year,
      safeSubject,
      examSegment,
      qn,
    );
    await uploadToR2(pdfKey, split.pdfBuffer, "application/pdf");

    // 解答PDFをR2にアップロード
    let answerPdfPath = "";
    const answerSplit = answerSplits.find((a) => a.questionNumber === qn);
    if (answerSplit) {
      const aKey = answerPdfKey(
        safeUniversity,
        opts.year,
        safeSubject,
        examSegment,
        qn,
      );
      await uploadToR2(aKey, answerSplit.pdfBuffer, "application/pdf");
      answerPdfPath = aKey;
    }

    // タグを取得
    const tagResult = tags.find((t) => t.questionNumber === qn);
    const topicTags = tagResult?.topicTags ?? [];

    // 境界情報を取得
    const boundary = splits[qn - 1];
    if (boundary.regions.length === 0) {
      throw new Error(
        `Could not determine page range for question ${qn} ("${split.label}"). Regions array is empty.`,
      );
    }

    // DBに書き込み
    const questionId = await createQuestion({
      documentId: problemDocId,
      questionNumber: qn,
      questionLabel: split.label,
      startPage: boundary.regions[0].page,
      endPage: boundary.regions[boundary.regions.length - 1].page,
      topicTags,
      splitPdfPath: pdfKey,
      splitImagePath: imgKey,
      answerSplitPdfPath: answerPdfPath,
    });

    console.log(`  ✓ 大問${qn}「${split.label}」を保存 (ID: ${questionId})`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
