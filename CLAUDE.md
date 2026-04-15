# kakomon-generator

## 共通方針

- 個人共通の AI 開発標準は `~/ai-dev-playbook/STACK_POLICY.md` と `~/ai-dev-playbook/HOST_RULES.md` を参照
- このファイルは `kakomon-generator` 固有の仕様と制約だけを定義する
- 共通方針と衝突する場合は、このファイルのプロジェクト固有ルールを優先する

## これは何か
大学入試の過去問PDFから、大問ごとに以下の4点セットを生成するCLIツール。
これ以外は一切作らない。

1. **問題画像** (PNG) - 大問を切り抜いた画像
2. **問題PDF** (A4) - 大問を切り抜いたPDF
3. **解答PDF** (A4) - 対応する解答を切り抜いたPDF
4. **トピックタグ** - その大問の出題分野（5階層固定）
   - 形式: `科目/分野/単元/サブ単元/トピック`
   - 例: `数学/数学Ⅰ/数と式/式の計算/対称式・交代式の値`
   - 必ず5階層。3階層や4階層は許容しない
   - topic-master.ts のマスターリストに存在するパスのみ使用する

## 使い方（完成形イメージ）

```bash
npx kakomon-generate \
  --problem ./問題.pdf \
  --answer ./解答.pdf \
  --subject 数学 \
  --university "○○大学" \
  --year 2024 \
  --exam-type zenki
```

## 処理フロー（厳守）

### Phase 1: 境界検出
  問題PDF全体 → Gemini Vision
  出力: 大問ごとの { label, start_page, end_page }

### Phase 2: 問題の切り出し
  ページ画像 → Gemini Vision でBBox検出 → sharpで切り抜き
  出力: 問題画像(PNG) + 問題PDF(A4)
  ※ 複数ページにまたがる大問にも対応すること
    - 各ページから該当大問の領域を切り出し
    - 結合して1つの問題画像(PNG) + 複数ページ問題PDF(A4) を生成

### Phase 3: トピック付け
  切り出した問題画像 → Gemini Vision
  出力: topic_tags[]（5階層固定）
  ※ 大問単体の画像を見せて判定する（全体PDFからではない）
  ※ マスターリストに存在するパスのみ出力する

### Phase 4: 解答の切り出し
  解答PDFの各ページ → Gemini Vision でBBox検出 → 切り抜き
  出力: 解答PDF(A4)
  ※ 複数ページにまたがる解答にも対応すること

### なぜこの順序か
- PDFをテキスト化（OCR）しない。Gemini VisionがPDF/画像を直接読めるので不要
- トピック付けは切り出し後に行う。大問単体の画像を見せたほうが精度が高い
- テキスト系の中間生産物（full_text, content, embedding）は一切生成しない

## 絶対にやらないこと
- OCR / テキスト化（PDFをテキストに変換しない）
- full_text, content, embedding などテキスト系フィールドの生成
- 類似問題検索
- Web UI（これはCLIツール）
- ダッシュボード・統計画面
- ユーザー管理・認証
- 上記以外の「あると便利そう」な機能の追加

## 技術スタック
- 言語: TypeScript (Node.js)
- CLI: commander または yargs
- AI: Google Gemini Vision API (@google/generative-ai)
- PDF→画像: pdf-to-img
- 画像処理: sharp
- PDF生成: pdf-lib
- ストレージ: Cloudflare R2 (@aws-sdk/client-s3)
- DB: Supabase (PostgreSQL)

## プロジェクト構成

```
src/
├── index.ts              # CLIエントリポイント
├── phases/
│   ├── detect.ts         # Phase1: 境界検出
│   ├── split.ts          # Phase2: 問題切り出し（画像+PDF）
│   ├── tag.ts            # Phase3: トピック付け
│   └── answer.ts         # Phase4: 解答切り出し
├── lib/
│   ├── gemini.ts         # Gemini Visionクライアント
│   ├── r2.ts             # R2アップロード
│   ├── supabase.ts       # DB書き込み
│   └── pdf.ts            # PDF→画像変換、切り抜き、A4 PDF生成
├── constants/
│   └── topic-master.ts   # トピックマスターリスト（全科目5階層統一）
└── types.ts              # 型定義
```

## DBスキーマ（最小限）

### kakomon_universities
id, name

### kakomon_documents
id, university_id, year, subject, exam_type
content_type (problem / answer)
pdf_storage_path

### kakomon_questions
id, document_id, question_number, question_label
start_page, end_page
topic_tags (TEXT[]) — 5階層フルパスの配列
split_pdf_path, split_image_path, answer_split_pdf_path

テキスト系カラム（full_text, content, embedding）は作らない。

## トピックマスターリスト

kakomon-manager リポジトリの lib/constants/topic-master.ts をベースに、
全科目を5階層（科目/分野/単元/サブ単元/トピック）に統一したものを使う。
旺文社マスターリスト準拠の階層構造。

## 環境変数

```
GEMINI_API_KEY=
GEMINI_VISION_MODEL=  # 必須。モデル名は絶対にハードコードしない
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

## LLMモデル名のルール（厳守）

- モデル名（Gemini等）をソースコードにハードコードしてはならない
- 必ず環境変数から読み出し、未設定時はエラーで停止する
- フォールバックのデフォルト値も禁止（`?? "gemini-xxx"` のようなパターンは不可）
- 理由: LLMのモデル名は頻繁に変わり、ハードコードすると古いモデル名がエラーの原因になる
