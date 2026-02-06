import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ExamType } from "../types.js";

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, key);
}

/**
 * 大学を取得または作成し、IDを返す
 */
export async function upsertUniversity(name: string): Promise<string> {
  const supabase = getSupabaseClient();

  const { data: existing } = await supabase
    .from("kakomon_universities")
    .select("id")
    .eq("name", name)
    .single();

  if (existing) {
    return existing.id as string;
  }

  const { data, error } = await supabase
    .from("kakomon_universities")
    .insert({ name })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create university: ${error.message}`);
  return data.id as string;
}

/**
 * ドキュメント（問題 or 解答）レコードを作成し、IDを返す
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
  answerSplitPdfPath: string;
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
  return data.id as string;
}
