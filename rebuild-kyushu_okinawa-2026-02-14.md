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
