# Kyushu/Okinawa Universities Rebuild - ABC Planning Notes (2026-02-14)

This file is for **regional planning only**.

Rule:
- Do not use this file while executing a single-university run.
- ABC classification for execution must be confirmed per-university from that university's official page + PDFs only.

## Classification Result (Links + First-Page Visual Check)

Legend:
- `cell_merge`: Official page reuses the same PDF URL across multiple rows/subjects (セル結合型の疑い/実質セル結合).
- `evidence`: One representative PDF URL inspected (first pages rendered and visually checked).

Lane A (結合なし / add only):
- (moved) `saga` (佐賀大学): Bundled PDF discovered in PDF body check (see Lane B)
  - official page: `https://www.sao.saga-u.ac.jp/kakomon_gakubu.html`
  - link list extracted: `https://www.sao.saga-u.ac.jp/PDF/...` が中心だが、ページ内に入試以外のPDFも多数混在するため、ingest 対象は「入試（一般選抜/学部入試）の問題/解答PDF」に限定して本文で都度確認が必須。
  - evidence (first page visual check):
    - `https://www.sao.saga-u.ac.jp/PDF/R6/2024ZE.pdf`（問題: 表紙が単一科目体裁）
    - `https://www.sao.saga-u.ac.jp/PDF/R6/2024ZRIKA.pdf`（問題: 表紙が単一科目体裁）
    - `https://www.sao.saga-u.ac.jp/PDF/R6/2024ZRISU.pdf`（問題/解答は本文確認が必要だが、少なくとも bundled 表記なし）
  - cell_merge evidence:
    - `https://www.sao.saga-u.ac.jp/PDF/R6/2024KKYOSHOI.pdf` がページ内で重複参照（limited）
- `kumamoto` (熊本大学): `cell_merge: no`
  - evidence: `https://www.kumamoto-u.ac.jp/nyuushi/gakubunyushi/kakomon-1/R7/01_r7kou_sugaku_kai.pdf` (単一科目の解答例)
- `miyazaki` (宮崎大学): `cell_merge: no`
  - evidence: `https://www.miyazaki-u.ac.jp/exam/AR701_japanese.pdf` (単一科目)
- `kagoshima` (鹿児島大学): `cell_merge: no`
  - evidence: `https://www.kagoshima-u.ac.jp/exam/2023-401-1.pdf` (単一科目の解答例/出題意図系)
- `fukuoka_edu` (福岡教育大学): `cell_merge: no`
  - evidence: `https://www.fukuoka-edu.ac.jp/admissions/glb0i00000000hf2-att/a1686706313534.pdf` (小論文の表紙)

Lane B (結合あり / 連続ページ分割で対応可):
- `kyutech` (九州工業大学): `cell_merge: no`
  - official page: `https://www.kyutech.ac.jp/examination/gs-past-examination.html`
  - evidence: `https://www.kyutech.ac.jp/archives/015/202405/R6_05sur40.pdf`
  - note: 表紙で `数学, 理科（物理・化学）` の同冊子が明示され、ページ範囲テーブルあり（連続分割可）。
- `saga` (佐賀大学): `cell_merge: yes (limited)`
  - official page: `https://www.sao.saga-u.ac.jp/kakomon_gakubu.html`
  - bundled evidence:
    - `https://www.sao.saga-u.ac.jp/PDF/R6/2024ZIRI.pdf`（前期日程 / 医学部 / 理科（物理・化学）: 同一冊子内に物理→化学の連続ページ構成。連続分割で対応可）
    - `https://www.sao.saga-u.ac.jp/PDF/exam/2025ZIRI.pdf`（前期日程 / 医学部 / 理科（物理・化学）: 同上）
    - `https://www.sao.saga-u.ac.jp/PDF/R5/2023ZIRI.pdf`（前期日程 / 医学部 / 理科（物理・化学）: 同上）
- `nagasaki` (長崎大学): `cell_merge: no`
  - evidence: `https://www.nagasaki-u.ac.jp/nyugaku/admission/profile/file/R03rika.pdf`
  - note: 表紙で `物理/化学/生物/地学` のページ範囲が明示（連続分割可）。
- `ryukyu` (琉球大学): `cell_merge: yes`
  - evidence: `https://www.u-ryukyu.ac.jp/wp-content/uploads/2025/05/r7_4_zenki_rika.pdf`
  - note: 表紙で `物理/化学/生物/地学` のページ範囲が明示（連続分割可）。同一PDFが複数行コンテキストに出現するものがある（実質セル結合）。

Lane C (例外多 / 後回し):
- `kitakyushu` (北九州市立大学): `cell_merge: no (page-level; but bundled-subject labels exist)`
  - official page root: `https://www.kitakyu-u.ac.jp/entrance-exam/faculty/past-exam/`
  - official year pages (as of 2026-02-15):
    - `https://www.kitakyu-u.ac.jp/entrance-exam/faculty/past-exam/20257.html`（2025（令和7）年度入試）
    - `https://www.kitakyu-u.ac.jp/entrance-exam/faculty/past-exam/20246.html`（2024（令和6）年度入試）
  - evidence (first page visual check):
    - `https://www.kitakyu-u.ac.jp/uploads/47123f29795dd88dc3f8658ff512a5d8.pdf`（国際環境工学部 機械システム工学科: 表紙に `物理・数学` の併記）
    - `https://www.kitakyu-u.ac.jp/uploads/8114d329cf1680ef61bc4011e8540488.pdf`（国際環境工学部: 表紙に `理科` の併記。中身が単科目か複数科目かは本文確認が必要）
    - `https://www.kitakyu-u.ac.jp/uploads/2112be7b4a32215765954f032f02fd5a.pdf`（国際環境工学部: 表紙に `理科` の併記。本文確認が必要）
  - note: 公式の行ラベルに複数教科併記（例: `物理・数学`）があり、bundled 由来の split 必要性判断が多数発生しうる。Lane A/B 処理を先に完了させた後、本文確認ベースで安全に split 方針を組むため Lane C に据え置き。

