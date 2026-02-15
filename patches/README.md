# Patches

This repo sometimes needs workflow changes in Codex skills under `~/.codex/skills/...`.
In this environment we cannot directly edit those files, so we keep the proposed edits here as patch files.

## kakomon-general-pdf-ingest

- Patch file: `patches/skill-kakomon-general-pdf-ingest-improvements.diff`
- Intent:
  - Enforce "one university at a time" execution gating.
  - Add environment preflight (Node 20+, npm cache workaround).
  - Prefer scoped deletion by `(university_id, year)` and `<university_id>/<year>/` when the scope is "currently linked years only".
  - Add guardrails (R2 key uniqueness) and mapping hints (prefer official page structure when PDF text extraction is weak).

Apply example:

```bash
git apply patches/skill-kakomon-general-pdf-ingest-improvements.diff
```

