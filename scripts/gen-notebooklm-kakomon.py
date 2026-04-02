#!/usr/bin/env python3
"""
過去問 → NotebookLM用PDF生成パイプライン

使い方:
  python3 scripts/gen-notebooklm-kakomon.py --field ベクトル
  python3 scripts/gen-notebooklm-kakomon.py --field 電磁気
  python3 scripts/gen-notebooklm-kakomon.py --field all --limit 50

前提:
  - Supabase kakomon_questions テーブルにデータがある
  - R2に問題画像(PNG)がある
  - Doppler sato-juku/prd に MISTRAL_API_KEY がある
  - pip install pymupdf boto3 requests

処理フロー:
  1. Supabaseから指定分野の問題を取得
  2. R2から問題画像をダウンロード
  3. Mistral OCR + bbox_annotation で図付きテキスト化
  4. Mistral Large で解答生成
  5. 問題画像+テキスト層（問題+図説明+解答）でPDF生成
  6. 出力: notebooklm/ ディレクトリにPDF
"""

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

import boto3
import fitz  # pymupdf
import requests

# === 設定 ===
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "https://ftuosfdudttlkaaoqgep.supabase.co")
SUPABASE_KEY = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_Ym-gXWKdIL0WEnYSmg_RRQ_jlwNQ8Dz")
MISTRAL_API_KEY = os.environ.get("MISTRAL_API_KEY", "")

R2_ENDPOINT = "https://c26cfd50b1e62f2658d36b274d619776.r2.cloudflarestorage.com"
R2_ACCESS_KEY = os.environ.get("R2_ACCESS_KEY_ID", "73dd779f12cbcae012f03e90dc1feb88")
R2_SECRET_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "716117f255b4db0b18aa6ffa2c288444272bb18cb6399d573b34fc9c84a5cb1d")
R2_BUCKET = "kakomon-pdfs"

OUT_DIR = Path(__file__).parent.parent / "notebooklm"
CACHE_DIR = Path(__file__).parent.parent / "notebooklm-cache"


def get_mistral_key():
    if MISTRAL_API_KEY:
        return MISTRAL_API_KEY
    # Doppler fallback
    import subprocess
    return subprocess.check_output(
        ["doppler", "secrets", "get", "--plain", "MISTRAL_API_KEY", "-p", "sato-juku", "-c", "prd"]
    ).decode().strip()


def fetch_questions(field: str, limit: int) -> list:
    """Supabaseから問題を取得"""
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    url = f"{SUPABASE_URL}/rest/v1/kakomon_questions"
    params = {
        "select": "id,question_label,topic_tags,split_image_path,answer_content",
        "split_image_path": "not.is.null",
        "limit": str(limit),
        "order": "created_at.desc",
    }
    if field != "all":
        params["topic_tags"] = f"cs.{json.dumps([field])}"  # contains

    resp = requests.get(url, headers=headers, params=params)
    if resp.status_code != 200:
        # フィールド検索がダメならlike検索
        del params["topic_tags"]
        resp = requests.get(url, headers=headers, params=params)
        data = resp.json()
        if field != "all":
            data = [q for q in data if any(field in t for t in q.get("topic_tags", []))]
        return data
    return resp.json()


def download_from_r2(key: str, local_path: str):
    """R2から画像をダウンロード"""
    if os.path.exists(local_path):
        return
    s3 = boto3.client("s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        region_name="auto",
    )
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    s3.download_file(R2_BUCKET, key, local_path)


def ocr_with_figure_desc(image_path: str, api_key: str) -> dict:
    """Mistral OCR + bbox_annotation で図の説明付きOCR"""
    cache_path = str(CACHE_DIR / (Path(image_path).stem + "_ocr.json"))
    if os.path.exists(cache_path):
        return json.load(open(cache_path))

    with open(image_path, "rb") as f:
        b64 = base64.standard_b64encode(f.read()).decode()

    for attempt in range(3):
        resp = requests.post(
            "https://api.mistral.ai/v1/ocr",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": "mistral-ocr-latest",
                "document": {"type": "image_url", "image_url": f"data:image/png;base64,{b64}"},
                "include_image_base64": False,
                "bbox_annotation_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "figure_desc",
                        "schema": {
                            "type": "object",
                            "properties": {
                                "figure_type": {"type": "string"},
                                "description": {"type": "string"},
                            },
                            "required": ["figure_type", "description"],
                        },
                    },
                },
            },
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            page = data["pages"][0]
            result = {
                "text": page.get("markdown", ""),
                "figures": [],
            }
            for img in page.get("images", []):
                ann = img.get("image_annotation")
                if ann:
                    if isinstance(ann, str):
                        ann = json.loads(ann)
                    result["figures"].append(ann)
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            json.dump(result, open(cache_path, "w"), ensure_ascii=False)
            return result
        elif resp.status_code == 429:
            time.sleep(5)
        else:
            print(f"  OCR ERROR: {resp.status_code}", file=sys.stderr)
            break

    return {"text": "", "figures": []}


def generate_answer(problem_text: str, api_key: str) -> str:
    """Mistral Largeで解答生成"""
    cache_key = str(hash(problem_text))[:12]
    cache_path = str(CACHE_DIR / f"answer_{cache_key}.txt")
    if os.path.exists(cache_path):
        return open(cache_path).read()

    prompt = f"""この大学入試問題を全問解いてください。途中式を全て示し、各小問の最終答えを明記せよ。

{problem_text}"""

    for attempt in range(3):
        resp = requests.post(
            "https://api.mistral.ai/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": "mistral-large-latest",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 8192,
            },
            timeout=120,
        )
        if resp.status_code == 200:
            answer = resp.json()["choices"][0]["message"]["content"]
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            open(cache_path, "w").write(answer)
            return answer
        elif resp.status_code == 429:
            time.sleep(5)
        else:
            print(f"  Answer ERROR: {resp.status_code}", file=sys.stderr)
            break

    return ""


def build_pdf(questions: list, field: str):
    """問題+解答をセットにしたPDFを生成"""
    doc = fitz.open()

    # CJKフォント検証
    test_doc = fitz.open()
    test_page = test_doc.new_page()
    try:
        test_page.insert_text(fitz.Point(10, 10), "テスト", fontname="japan", fontsize=1, render_mode=3)
        if "テスト" not in test_page.get_text():
            print("FATAL: CJKフォント不可", file=sys.stderr)
            sys.exit(1)
    finally:
        test_doc.close()

    for q in questions:
        image_path = q["_local_image"]
        ocr_data = q["_ocr"]
        answer = q["_answer"]
        label = q.get("question_label", "?")
        tags = q.get("topic_tags", [])
        tag_str = " / ".join(tags[0].split("/")[:3]) if tags else ""

        # 問題テキスト = OCR + 図の説明
        text_parts = [f"【問題】{tag_str} 問{label}"]
        text_parts.append(ocr_data.get("text", ""))
        for fig in ocr_data.get("figures", []):
            text_parts.append(f"【図の説明】{fig.get('figure_type','')}: {fig.get('description','')}")

        # 問題ページ（画像+テキスト層）
        if os.path.exists(image_path):
            img = fitz.Pixmap(image_path)
            w, h = img.width, img.height
            scale = min(842 / w, 595 / h, 1.0)
            pw, ph = w * scale, h * scale
            page = doc.new_page(width=pw, height=ph)
            page.insert_image(fitz.Rect(0, 0, pw, ph), pixmap=img)

            prob_text = "\n".join(text_parts)
            y = 10
            for line in prob_text.split("\n")[:200]:
                if line.strip():
                    try:
                        page.insert_text(fitz.Point(10, y), line.strip()[:500],
                            fontname="japan", fontsize=1, render_mode=3)
                    except Exception:
                        pass
                y += 1.2
                if y > ph - 10:
                    break
            img = None

        # 解答ページ（テキストのみ、画像なし）
        if answer:
            ans_page = doc.new_page(width=595, height=842)  # A4
            ans_text = f"【解答】問{label} {tag_str}\n\n{answer}"
            y = 30
            for line in ans_text.split("\n")[:300]:
                if line.strip():
                    try:
                        ans_page.insert_text(fitz.Point(30, y), line.strip()[:100],
                            fontname="japan", fontsize=8, render_mode=0)
                    except Exception:
                        pass
                y += 12
                if y > 820:
                    break

    # 保存
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = field.replace("/", "_").replace(" ", "_")
    out_path = OUT_DIR / f"kakomon_{slug}.pdf"
    doc.save(str(out_path), deflate=True, garbage=4)
    doc.close()
    print(f"\n✅ {out_path}: {len(questions)}問, {os.path.getsize(out_path) / 1024:.0f}KB")
    return out_path


def main():
    parser = argparse.ArgumentParser(description="過去問 → NotebookLM PDF")
    parser.add_argument("--field", required=True, help="分野名（例: ベクトル, 電磁気, all）")
    parser.add_argument("--limit", type=int, default=50, help="最大問題数")
    parser.add_argument("--skip-answer", action="store_true", help="解答生成をスキップ")
    args = parser.parse_args()

    api_key = get_mistral_key()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Step 1: 問題取得
    print(f"📚 分野: {args.field}, 上限: {args.limit}問")
    questions = fetch_questions(args.field, args.limit)
    print(f"   {len(questions)}問取得")

    if not questions:
        print("問題が見つかりません")
        sys.exit(1)

    # Step 2-4: 各問題を処理
    for i, q in enumerate(questions):
        label = q.get("question_label", "?")
        tags = q.get("topic_tags", [])
        tag_short = tags[0].split("/")[2] if tags and len(tags[0].split("/")) >= 3 else ""
        print(f"[{i+1}/{len(questions)}] 問{label} {tag_short}")

        # R2からダウンロード
        r2_key = q["split_image_path"]
        local_path = str(CACHE_DIR / r2_key.replace("/", "_"))
        download_from_r2(r2_key, local_path)
        q["_local_image"] = local_path

        # OCR + 図説明
        ocr = ocr_with_figure_desc(local_path, api_key)
        q["_ocr"] = ocr
        time.sleep(1)

        # 解答生成
        if args.skip_answer or q.get("answer_content"):
            q["_answer"] = q.get("answer_content", "")
        else:
            prob_text = ocr.get("text", "")
            for fig in ocr.get("figures", []):
                prob_text += f"\n\n[図: {fig.get('figure_type','')}: {fig.get('description','')}]"
            q["_answer"] = generate_answer(prob_text, api_key)
            time.sleep(1)

    # Step 5: PDF生成
    print(f"\nPDF生成中...")
    build_pdf(questions, args.field)


if __name__ == "__main__":
    main()
