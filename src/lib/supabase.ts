import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ExamType } from "../types.js";

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  supabaseClient = createClient(url, key);
  return supabaseClient;
}

/**
 * 大学を名前で検索し、IDを返す（存在しない場合はエラー）
 */
export async function upsertUniversity(name: string): Promise<string> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kakomon_universities")
    .select("id")
    .eq("name", name)
    .single();

  if (error) throw new Error(`University not found: "${name}" (${error.message})`);
  if (!data) throw new Error(`University not found: "${name}"`);
  return data.id as string;
}

const isForceMode = process.argv.includes("--force");

/**
 * ドキュメント（問題 or 解答）レコードを作成し、IDを返す
 * 既存レコードがある場合:
 *   --force なし → エラーで停止
 *   --force あり → 関連クエスチョンを削除してからドキュメントを削除し、新規登録
 */
export async function createDocument(params: {
  universityId: string;
  year: number;
  subject: string;
  examType: ExamType;
  contentType: "problem" | "answer";
  pdfStoragePath: string;
}): Promise<string> {
  const supabase = getSupabaseClient();

  // 既存レコードの確認
  const { data: existing } = await supabase
    .from("kakomon_documents")
    .select("id")
    .eq("university_id", params.universityId)
    .eq("year", params.year)
    .eq("subject", params.subject)
    .eq("exam_type", params.examType)
    .eq("content_type", params.contentType)
    .maybeSingle();

  if (existing) {
    if (!isForceMode) {
      throw new Error(
        `既に登録済みです (${params.universityId}/${params.year}/${params.subject}/${params.examType}/${params.contentType})。上書きするには --force を付けてください`,
      );
    }
    // --force: 関連クエスチョンを削除してからドキュメントを削除
    await supabase
      .from("kakomon_questions")
      .delete()
      .eq("document_id", existing.id);
    await supabase
      .from("kakomon_documents")
      .delete()
      .eq("id", existing.id);
    console.log(`  DB: 既存データを削除 (${params.contentType}: ${existing.id})`);
  }

  const { data, error } = await supabase
    .from("kakomon_documents")
    .insert({
      university_id: params.universityId,
      year: params.year,
      subject: params.subject,
      exam_type: params.examType,
      content_type: params.contentType,
      pdf_storage_path: params.pdfStoragePath,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create document: ${error.message}`);
  if (!data) throw new Error("Failed to create document: no data returned");
  return data.id as string;
}

/**
 * 問題レコードを作成する
 */
export async function createQuestion(params: {
  documentId: string;
  questionNumber: number;
  questionLabel: string;
  startPage: number;
  endPage: number;
  topicTags: string[];
  splitPdfPath: string;
  splitImagePath: string;
  answerSplitPdfPath: string | null;
}): Promise<string> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("kakomon_questions")
    .insert({
      document_id: params.documentId,
      question_number: params.questionNumber,
      question_label: params.questionLabel,
      start_page: params.startPage,
      end_page: params.endPage,
      topic_tags: params.topicTags,
      split_pdf_path: params.splitPdfPath,
      split_image_path: params.splitImagePath,
      answer_split_pdf_path: params.answerSplitPdfPath,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create question: ${error.message}`);
  if (!data) throw new Error("Failed to create question: no data returned");
  return data.id as string;
}
