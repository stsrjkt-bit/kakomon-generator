# pdf-splitter Decision Guide (Human-in-the-loop)

このスキルは「Geminiに全ページ分類をさせ、**人間(Codex)が境界を目視検証・必要なら修正してから**分割を確定する」ためのガイド。

## 基本方針

- **最初に `analyze` を走らせる**: 表紙のページ範囲やフッター番号は信用しない。
- **境界は必ず目視確認する**: `review` で境界付近のページをPNG化して確認する。
- **必要なら分類JSONを手で直す**: 1ページのズレが全科目のPDFを破壊する。
- `split --classification <edited.json>` で **Gemini再実行なし**で分割を確定する。

## 分類JSONの読み方

`pages[]` は 1始まりの物理ページ番号。重要なのは:

- `type`: `cover` / `problem` / `answer_sheet` / `blank` / `other`
- `subject`: `physics` / `chemistry` / `biology` / `earth_science` / `null`
- `note`: 見出し・問題番号などの根拠

見るべきポイント:

- `blank` が混じる箇所（ズレ原因）
- `subject` が切り替わる直前直後のページ
- `answer_sheet` が「科目直後」か「巻末まとめ」か

## 目視確認のやり方

1. `review` で境界候補(+/-1ページ)と白紙/解答用紙をPNGにして確認。
2. それでも不安な場合は、境界の前後を追加でPNG化する。
   - 例: `review` の出力に含まれないページ番号を手でレンダする場合は `pymupdf` で追加生成してよい（スキル本体の修正ではなく、その場の調査として）。

## 分類JSONの修正ルール

やることは単純で、`pages[]` の該当ページの `type` / `subject` を直す。

- 科目の先頭ページが誤って `cover` 扱い: `type="problem"` に直す
- 白紙が `other` 扱い: `type="blank"`, `subject=null` に直す
- 科目が1ページだけ誤分類: そのページの `subject` を直す
- 解答用紙が科目不明: 目視で科目を判定して `subject` を直す

編集後は `split --classification edited.json` を使うこと（`split` が勝手にGemini再実行しないように）。

## 代表パターン

- パターンA: 科目ごとに「問題」セクションが連続している
  - `problem_pages` が連番になるはず。飛びがあれば `blank/cover` の見落としを疑う。
- パターンB: 解答用紙が巻末にまとまる
  - `answer_sheet` が後ろに固まる。科目に正しく紐づいているか要確認。
- パターンC: 「理科(共通)」表紙が各科目の前に入る
  - `cover` が科目間に挟まる。`split` が「problemだけ抽出」なので、表紙を含めたい場合は設計を変える必要がある（現状は問題ページ主体で切る）。

## 分割後のingest

pdf-splitter は ingest を行わない。分割結果を `manual-split-plan.json` に記載し、
`scripts/manual-split-upload.ts` でR2アップロード+DB upsertを実行する。

詳細は `~/.claude/skills/kakomon-university-rebuild.md` の Phase B5 / Phase E を参照。

