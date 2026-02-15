# Kyushu/Okinawa Universities Rebuild (Strict Manual) - 2026-02-14

Scope: 一般選抜/学部入試の「問題PDF」「解答/解答例PDF」を公式ページから大学ごとに直接確認し、PDF本文を確認した上で fixes を作って `kakomon-collector` で ingest する。

Targets (kakomon_universities):
- kitakyushu: 北九州市立大学 / https://www.kitakyu-u.ac.jp/entrance-exam/faculty/past-exam/
- kyutech: 九州工業大学 / https://www.kyutech.ac.jp/examination/gs-past-examination.html
- saga: 佐賀大学 / https://www.sao.saga-u.ac.jp/kakomon_gakubu.html
- nagasaki: 長崎大学 / https://www.nagasaki-u.ac.jp/nyugaku/admission/profile/
- kumamoto: 熊本大学 / https://www.kumamoto-u.ac.jp/nyuushi/gakubunyushi/kakomon
- miyazaki: 宮崎大学 / https://www.miyazaki-u.ac.jp/exam/admission/nyushi-kaitou.html
- kagoshima: 鹿児島大学 / https://www.kagoshima-u.ac.jp/exam/kakomon.html
- fukuoka_edu: 福岡教育大学 / https://www.fukuoka-edu.ac.jp/admissions/past_exam.html
- ryukyu: 琉球大学 / https://www.u-ryukyu.ac.jp/admissions/passed/

Notes:
- Destructive step (zero rebuild) will delete DB rows in `kakomon_documents` where university_id in targets, and delete R2 keys with prefix `<university_id>/`. Must confirm year range/scope before doing this.
- Also report per-university whether the official page uses "セル結合型" (same PDF URL reused across multiple subjects/rows).

## Execution Rule (One University At A Time)

To avoid "hours of work with zero shipped results", this rebuild must be executed **one university at a time**:

- Pick exactly 1 university.
- Complete end-to-end for that university:
  - official link discovery (current page contents only)
  - PDF content inspection (manual verification)
  - fixes creation
  - DB deletion (scoped to current linked years only)
  - R2 deletion (scoped to current linked years only)
  - `kakomon-collector fix --apply`
  - DB+R2 verification
- Write a short report for that university (what was ingested, counts, any anomalies).
- **Do not start the next university until the report is written.**

## ABC Lane Classification (Do This Before Ingest)

Rationale: Don't let a few "hard" bundled/scan PDFs force exception-heavy workflows on easy universities. Classify first, finish lane A first, then proceed to B, and defer C.

Lane definitions (per-university):
- A (Fast path): No bundled PDFs. Subject PDFs are already separated per subject/exam/content. Ingest is "add only".
- B (Bundled but contiguous): Bundled PDFs exist, but can be split by contiguous page ranges (e.g. cover/table of contents shows "Physics p1-16, Chemistry p17-30"). This can stay within `kakomon-general-pdf-ingest` if splitting succeeds and is verified.
- C (Hard / defer): Bundled PDFs that require non-contiguous page picking (e.g. pages interleaved by subject), year-to-year structure drift, or scan-first PDFs where reliable auto split is unlikely. Do not expand `kakomon-general-pdf-ingest` to handle this; defer to a separate workflow.

Minimal classification signals:
- Same PDF URL reused across multiple subjects/rows: suspect bundled => B or C.
- Anchor/labels like `理科（物理、化学、生物、地学）` or `物理・数学`: bundled => B or C.
- Bundled PDF cover has per-subject page ranges: likely B.
- Pages alternate subjects / no clean contiguous ranges / structure varies by year: C.

## Reclassification / Skip Rule (B -> C During Work)

While processing lane A/B universities, it is allowed to drop a university to lane C and skip the remaining work for that university if reality is harder than expected.

Also allow upgrading difficulty from lane A when discoveries contradict the initial classification.

Lane changes allowed during work (per-university):
- `A -> B`: Bundling exists but appears solvable via contiguous page-range splitting. Stop and defer the university to the lane B phase.
- `A -> C`: Bundling is hard / non-contiguous / unstable / scan-first. Stop and defer to a separate workflow (lane C).
- `B -> C`: Splitting is not safely achievable with contiguous ranges or verification is too unreliable. Stop and defer to a separate workflow (lane C).

When to drop to lane C:
- Bundled PDFs require non-contiguous page picking (subjects interleaved), so contiguous ranges can't isolate a subject cleanly.
- Structure drifts across years (split rules can't be reused reliably year-to-year).
- Scan-first PDFs where headings/text extraction are too unreliable to verify boundaries safely.
- Any case where continuing would require exception-heavy logic beyond this strict workflow's intent.

How to drop:
- Stop processing that university immediately (do not attempt partial ingest).
- Record the reason with at least one PDF URL and a short note describing what was observed.
- Continue with the next university in the planned order (finish all lane A first, then lane B).

### Classification Result (Links + First-Page Visual Check)

Legend:
- `cell_merge`: Official page reuses the same PDF URL across multiple rows/subjects (セル結合型の疑い/実質セル結合).
- `evidence`: One representative PDF URL inspected (first pages rendered and visually checked).

Lane A (結合なし / add only):
- `saga` (佐賀大学): `cell_merge: yes (limited)`
  - evidence: `https://www.sao.saga-u.ac.jp/PDF/R6/2024KKYOSHOI.pdf` (小論文の出題意図PDF。リンク上は同一PDFが複数行コンテキストに出現)
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
  - evidence: `https://www.kyutech.ac.jp/archives/015/202405/R6_05sur40.pdf`
  - note: 表紙で `数学, 理科（物理・化学）` の同冊子が明示され、ページ範囲テーブルあり（連続分割可）。
- `nagasaki` (長崎大学): `cell_merge: no`
  - evidence: `https://www.nagasaki-u.ac.jp/nyugaku/admission/profile/file/R03rika.pdf`
  - note: 表紙で `物理/化学/生物/地学` のページ範囲が明示（連続分割可）。
- `ryukyu` (琉球大学): `cell_merge: yes`
  - evidence: `https://www.u-ryukyu.ac.jp/wp-content/uploads/2025/05/r7_4_zenki_rika.pdf`
  - note: 表紙で `物理/化学/生物/地学` のページ範囲が明示（連続分割可）。同一PDFが複数行コンテキストに出現するものがある（実質セル結合）。

Lane C (例外多 / 後回し):
- `kitakyushu` (北九州市立大学): `cell_merge: no (tentative)`
  - evidence: `https://www.kitakyu-u.ac.jp/uploads/2019kouki%20kaitou%20kougakubu%20%20kikai%20%20buturisuugaku.pdf`
  - note: 昨日時点の運用判断で「例外が多く、連続ページ分割だけでは安全に運用できない」ため C 扱いとして後回し。
