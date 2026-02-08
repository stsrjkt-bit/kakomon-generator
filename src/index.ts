/**
 * kakomon-generator CLIエントリポイント
 *
 * 処理フロー:
 *   Phase 1+2a: detectQuestions — 問題PDF → Gemini で境界+座標を一括検出
 *   Phase 2b:   splitProblems  — 検出結果 → 画像切り出し+PDF生成（Gemini不使用）
 *   Phase 3:    tagQuestions   — 切り出し画像 → Gemini でトピック付け
 *   Phase 4:    splitAnswers   — 解答PDF → Gemini で解答領域一括検出+切り出し
 */

import fs from "node:fs/promises";
import path from "node:path";

import { detectQuestions } from "./phases/detect.js";
import { splitProblems } from "./phases/split.js";
import { tagQuestions } from "./phases/tag.js";
import { splitAnswers } from "./phases/answer.js";
import {
  uploadToR2,
  originalPdfKey,
  problemImageKey,
  problemPdfKey,
  answerPdfKey,
  resolveSubjectKey,
} from "./lib/r2.js";
import {
  upsertUniversity,
  createDocument,
  createQuestion,
} from "./lib/supabase.js";
import type {
  DetectedQuestion,
  QuestionBoundary,
  CliOptions,
} from "./types.js";

/**
 * DetectedQuestion[] から QuestionBoundary[] に変換する
 * Phase 4 (splitAnswers) が従来の QuestionBoundary 形式を必要とするため
 */
function toBoundaries(detected: DetectedQuestion[]): QuestionBoundary[] {
  return detected.map((q) => {
    const pages = q.regions.map((r) => r.page);
    return {
      label: q.label,
      startPage: Math.min(...pages),
      endPage: Math.max(...pages),
    };
  });
}

async function main(options: CliOptions): Promise<void> {
  const outDir = options.outDir;
  if (outDir) {
    await fs.mkdir(outDir, { recursive: true });
  }

  // PDF読み込み
  const problemPdf = Buffer.from(await fs.readFile(options.problem));
  const answerPdf = Buffer.from(await fs.readFile(options.answer));

  console.log(`問題PDF: ${options.problem} (${(problemPdf.length / 1024).toFixed(0)} KB)`);
  console.log(`解答PDF: ${options.answer} (${(answerPdf.length / 1024).toFixed(0)} KB)`);
  console.log(`科目: ${options.subject}  大学: ${options.university}  年度: ${options.year}`);
  console.log("");

  // Phase 1+2a: 境界検出+座標の一括取得（1回のGemini API呼び出し）
  console.log("-- Phase 1: 境界検出+座標取得 ---------------------");
  const detectedQuestions = await detectQuestions(problemPdf);
  console.log(`  検出された大問: ${detectedQuestions.length}件\n`);

  // Phase 2b: 問題の切り出し（Gemini不使用、画像処理のみ）
  console.log("-- Phase 2: 問題切り出し -------------------------");
  const splitResults = await splitProblems(problemPdf, detectedQuestions);
  console.log(`  切り出し完了: ${splitResults.length}件\n`);

  // Phase 3: トピック付け（切り出し画像 → Gemini Vision）
  console.log("-- Phase 3: トピック付け -------------------------");
  const tagResults = await tagQuestions(splitResults, options.subject);
  console.log(`  タグ付け完了: ${tagResults.length}件\n`);

  // Phase 4: 解答の切り出し
  console.log("-- Phase 4: 解答切り出し -------------------------");
  const boundaries = toBoundaries(detectedQuestions);
  const answerResults = await splitAnswers(answerPdf, boundaries);
  console.log(`  切り出し完了: ${answerResults.length}件\n`);

  // ローカル出力（--out-dir 指定時のみ）
  if (outDir) {
    console.log("-- ローカル出力 ----------------------------------");
    for (const split of splitResults) {
      const baseName = `${options.year}_${options.examType}_${options.subject}_Q${split.questionNumber}`;
      const imgPath = path.join(outDir, `${baseName}.png`);
      const pdfPath = path.join(outDir, `${baseName}.pdf`);

      await fs.writeFile(imgPath, split.imagePng);
      await fs.writeFile(pdfPath, split.pdfBuffer);
      console.log(`  ${split.label}: ${imgPath}, ${pdfPath}`);
    }

    for (const ans of answerResults) {
      const baseName = `${options.year}_${options.examType}_${options.subject}_A${ans.questionNumber}`;
      const pdfPath = path.join(outDir, `${baseName}.pdf`);

      await fs.writeFile(pdfPath, ans.pdfBuffer);
      console.log(`  ${ans.label} 解答: ${pdfPath}`);
    }

    const tagsJson = tagResults.map((t) => ({
      label: t.label,
      questionNumber: t.questionNumber,
      topicTags: t.topicTags,
    }));
    const tagsPath = path.join(outDir, "tags.json");
    await fs.writeFile(tagsPath, JSON.stringify(tagsJson, null, 2));
    console.log(`  タグ: ${tagsPath}\n`);
  }

  // Phase 5: R2アップロード + Supabase DB書き込み
  console.log("-- Phase 5: R2アップロード + DB書き込み ------------");

  const { university, year, subject, examType } = options;

  // 大学ID・科目キーをASCIIに解決
  const universityId = await upsertUniversity(university);
  const subjectKey = resolveSubjectKey(subject);
  console.log(`  大学ID: ${universityId}, 科目キー: ${subjectKey}`);

  // オリジナルPDFをR2にアップロード
  const problemOrigKey = originalPdfKey(universityId, year, subjectKey, examType, "problem");
  const answerOrigKey = originalPdfKey(universityId, year, subjectKey, examType, "answer");
  await Promise.all([
    uploadToR2(problemOrigKey, problemPdf, "application/pdf"),
    uploadToR2(answerOrigKey, answerPdf, "application/pdf"),
  ]);
  console.log(`  R2: ${problemOrigKey}`);
  console.log(`  R2: ${answerOrigKey}`);

  // 大問ごとのファイルをR2にアップロード
  for (const split of splitResults) {
    const qn = split.questionNumber;
    const imgKey = problemImageKey(universityId, year, subjectKey, examType, qn);
    const pdfKey = problemPdfKey(universityId, year, subjectKey, examType, qn);
    await Promise.all([
      uploadToR2(imgKey, split.imagePng, "image/png"),
      uploadToR2(pdfKey, split.pdfBuffer, "application/pdf"),
    ]);
    console.log(`  R2: ${imgKey}, ${pdfKey}`);
  }

  for (const ans of answerResults) {
    const aKey = answerPdfKey(universityId, year, subjectKey, examType, ans.questionNumber);
    await uploadToR2(aKey, ans.pdfBuffer, "application/pdf");
    console.log(`  R2: ${aKey}`);
  }

  console.log(`  DB: university=${universityId}`);

  const [problemDocId, answerDocId] = await Promise.all([
    createDocument({
      universityId,
      year,
      subject,
      examType,
      contentType: "problem",
      pdfStoragePath: problemOrigKey,
    }),
    createDocument({
      universityId,
      year,
      subject,
      examType,
      contentType: "answer",
      pdfStoragePath: answerOrigKey,
    }),
  ]);
  console.log(`  DB: problemDoc=${problemDocId}, answerDoc=${answerDocId}`);

  const boundaryMap = new Map(boundaries.map((b, i) => [i + 1, b]));

  for (const split of splitResults) {
    const qn = split.questionNumber;
    const tags = tagResults.find((t) => t.questionNumber === qn);
    const boundary = boundaryMap.get(qn);

    const questionId = await createQuestion({
      documentId: problemDocId,
      questionNumber: qn,
      questionLabel: split.label,
      startPage: boundary?.startPage ?? 1,
      endPage: boundary?.endPage ?? 1,
      topicTags: tags?.topicTags ?? [],
      splitPdfPath: problemPdfKey(universityId, year, subjectKey, examType, qn),
      splitImagePath: problemImageKey(universityId, year, subjectKey, examType, qn),
      answerSplitPdfPath: answerPdfKey(universityId, year, subjectKey, examType, qn),
    });
    console.log(`  DB: Q${qn} ${split.label} → ${questionId}`);
  }

  console.log("\n完了");
}

// CLI引数パース（commander 導入まではシンプルな実装）
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const problem = getArg("problem");
const answer = getArg("answer");
const subject = getArg("subject");
const university = getArg("university");
const year = getArg("year");
const examType = getArg("exam-type");

if (!problem || !answer || !subject || !university || !year || !examType) {
  console.error(
    "Usage: npx kakomon-generate --problem <pdf> --answer <pdf> --subject <subject> --university <name> --year <year> --exam-type <type>",
  );
  process.exit(1);
}

main({
  problem,
  answer,
  subject,
  university,
  year: Number(year),
  examType: examType as CliOptions["examType"],
  outDir: getArg("out-dir"),
}).catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
