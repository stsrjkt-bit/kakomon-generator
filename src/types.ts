/** 試験種別 */
export type ExamType = "zenki" | "kouki" | "center" | "kyotsu";

/** CLIオプション */
export interface CliOptions {
  problem: string;
  answer: string;
  subject: string;
  university: string;
  year: number;
  examType: ExamType;
  outDir?: string;
}

/** Phase1: 境界検出の結果 */
export interface QuestionBoundary {
  /** 大問ラベル（例: "第1問", "問1"） */
  label: string;
  /** 開始ページ（1始まり） */
  startPage: number;
  /** 終了ページ（1始まり） */
  endPage: number;
}

/** BBox: ページ内の矩形領域（ピクセル座標） */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 割合ベースのページ内領域（0.0〜1.0） */
export interface RegionRatio {
  /** ページ番号（1始まり） */
  page: number;
  y_start_ratio: number;
  y_end_ratio: number;
  x_start_ratio: number;
  x_end_ratio: number;
}

/** Phase1+2統合: 大問の検出結果（境界情報+各ページの座標を一括で返す） */
export interface DetectedQuestion {
  /** 大問ラベル（例: "第1問", "問1"） */
  label: string;
  /** 各ページでの領域（複数ページにまたがる大問は複数要素） */
  regions: RegionRatio[];
}

/** Phase2: 1ページ内の大問領域 */
export interface PageRegion {
  page: number;
  bbox: BBox;
}

/** Phase2: 問題切り出し結果 */
export interface SplitResult {
  label: string;
  questionNumber: number;
  /** 切り出した問題画像 (PNG バッファ) */
  imagePng: Buffer;
  /** 切り出した問題PDF (A4 バッファ) */
  pdfBuffer: Buffer;
  /** 各ページの切り出し領域 */
  regions: PageRegion[];
}

/** Phase3: トピック付け結果 */
export interface TagResult {
  label: string;
  questionNumber: number;
  /** 5階層固定のトピックタグ配列 */
  topicTags: string[];
}

/** Phase4: 解答切り出し結果 */
export interface AnswerSplitResult {
  label: string;
  questionNumber: number;
  /** 切り出した解答PDF (A4 バッファ) */
  pdfBuffer: Buffer;
}

/** 最終出力: 大問1つ分の完全なデータ */
export interface QuestionOutput {
  label: string;
  questionNumber: number;
  boundary: QuestionBoundary;
  split: SplitResult;
  tags: TagResult;
  answer: AnswerSplitResult;
}

/** DB: kakomon_universities */
export interface DbUniversity {
  id: string;
  name: string;
}

/** DB: kakomon_documents */
export interface DbDocument {
  id: string;
  university_id: string;
  year: number;
  subject: string;
  exam_type: ExamType;
  content_type: "problem" | "answer";
  pdf_storage_path: string;
}

/** DB: kakomon_questions */
export interface DbQuestion {
  id: string;
  document_id: string;
  question_number: number;
  question_label: string;
  start_page: number;
  end_page: number;
  topic_tags: string[];
  split_pdf_path: string;
  split_image_path: string;
  answer_split_pdf_path: string;
}
