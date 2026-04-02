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
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import boto3
import fitz  # pymupdf
import requests

# === 設定（全て環境変数 or Doppler から。ハードコード禁止） ===
def _env(key: str) -> str:
    val = os.environ.get(key, "")
    if not val:
        # Doppler fallback
        import subprocess
        try:
            val = subprocess.check_output(
                ["doppler", "secrets", "get", "--plain", key, "-p", "sato-juku", "-c", "prd"],
                stderr=subprocess.DEVNULL,
            ).decode().strip()
        except Exception:
            pass
    if not val:
        print(f"FATAL: 環境変数 {key} が未設定（Dopplerにもない）", file=sys.stderr)
        sys.exit(1)
    return val

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
MISTRAL_API_KEY = os.environ.get("MISTRAL_API_KEY", "")
MISTRAL_OCR_MODEL = os.environ.get("MISTRAL_OCR_MODEL", "")
MISTRAL_LARGE_MODEL = os.environ.get("MISTRAL_LARGE_MODEL", "")

R2_ENDPOINT = os.environ.get("R2_ENDPOINT", "")
R2_ACCESS_KEY = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET = os.environ.get("KAKOMON_R2_BUCKET_NAME", os.environ.get("R2_BUCKET_NAME", ""))

OUT_DIR = Path(__file__).parent.parent / "notebooklm"
CACHE_DIR = Path(__file__).parent.parent / "notebooklm-cache"


def ensure_env():
    """起動時に必要な環境変数を全てDopplerから取得"""
    global SUPABASE_URL, SUPABASE_KEY, MISTRAL_API_KEY, MISTRAL_OCR_MODEL, MISTRAL_LARGE_MODEL
    global R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET

    if not MISTRAL_API_KEY:
        MISTRAL_API_KEY = _env("MISTRAL_API_KEY")
    if not MISTRAL_OCR_MODEL:
        MISTRAL_OCR_MODEL = _env("MISTRAL_OCR_MODEL")
    if not MISTRAL_LARGE_MODEL:
        MISTRAL_LARGE_MODEL = _env("MISTRAL_LARGE_MODEL")
    if not SUPABASE_URL:
        SUPABASE_URL = _env("SUPABASE_URL")
    if not SUPABASE_KEY:
        SUPABASE_KEY = _env("SUPABASE_ANON_KEY")
    if not R2_ENDPOINT:
        R2_ENDPOINT = _env("R2_ENDPOINT")
    if not R2_ACCESS_KEY:
        R2_ACCESS_KEY = _env("R2_ACCESS_KEY_ID")
    if not R2_SECRET_KEY:
        R2_SECRET_KEY = _env("R2_SECRET_ACCESS_KEY")
    if not R2_BUCKET:
        R2_BUCKET = _env("KAKOMON_R2_BUCKET_NAME")


def fetch_questions(field: str, limit: int) -> list:
    """Supabaseから問題を取得（分野はPython側でフィルタ）"""
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    url = f"{SUPABASE_URL}/rest/v1/kakomon_questions"
    # 画像ありの全問取得（最大500件）してPython側でフィルタ
    params = {
        "select": "id,question_label,topic_tags,split_image_path,answer_content",
        "split_image_path": "not.is.null",
        "limit": str(max(500, limit)),
        "order": "created_at.desc",
    }
    try:
        resp = requests.get(url, headers=headers, params=params, timeout=30)
    except Exception as e:
        print(f"FATAL: Supabase接続エラー: {e}", file=sys.stderr)
        sys.exit(1)

    if resp.status_code != 200:
        print(f"FATAL: Supabase応答エラー: {resp.status_code} {resp.text[:200]}", file=sys.stderr)
        sys.exit(1)

    data = resp.json()

    if field != "all":
        data = [q for q in data if any(field in t for t in (q.get("topic_tags") or []))]

    return data[:limit]


def download_from_r2(key: str, local_path: str) -> bool:
    """R2から画像をダウンロード。成功=True"""
    if os.path.exists(local_path):
        return True
    try:
        s3 = boto3.client("s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY,
            aws_secret_access_key=R2_SECRET_KEY,
            region_name="auto",
        )
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        s3.download_file(R2_BUCKET, key, local_path)
        return True
    except Exception as e:
        print(f"  WARN: R2ダウンロード失敗 {key}: {e}", file=sys.stderr)
        return False


def ocr_with_figure_desc(image_path: str, api_key: str) -> dict:
    """Mistral OCR + bbox_annotation で図の説明付きOCR"""
    cache_path = str(CACHE_DIR / (Path(image_path).stem + "_ocr.json"))
    if os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            return json.load(f)

    with open(image_path, "rb") as f:
        b64 = base64.standard_b64encode(f.read()).decode()

    for attempt in range(3):
        try:
            resp = requests.post(
                "https://api.mistral.ai/v1/ocr",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": MISTRAL_OCR_MODEL,
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
        except Exception as e:
            print(f"  OCR通信エラー(attempt {attempt+1}): {e}", file=sys.stderr)
            time.sleep(3)
            continue

        if resp.status_code == 200:
            data = resp.json()
            pages = data.get("pages", [])
            if not pages:
                print(f"  WARN: OCR応答にpagesがない", file=sys.stderr)
                break
            page = pages[0]
            result = {
                "text": page.get("markdown", ""),
                "figures": [],
            }
            for img in page.get("images", []):
                ann = img.get("image_annotation")
                if ann:
                    try:
                        if isinstance(ann, str):
                            ann = json.loads(ann)
                        result["figures"].append(ann)
                    except json.JSONDecodeError:
                        pass
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            with open(cache_path, "w") as f:
                json.dump(result, f, ensure_ascii=False)
            return result
        elif resp.status_code in (429, 500, 502, 503):
            time.sleep(5 * (attempt + 1))
        else:
            print(f"  OCR ERROR: {resp.status_code}", file=sys.stderr)
            break

    return {"text": "", "figures": []}


def generate_answer(problem_text: str, api_key: str) -> str:
    """Mistral Largeで解答生成"""
    cache_key = hashlib.md5(problem_text.encode()).hexdigest()[:12]
    cache_path = str(CACHE_DIR / f"answer_{cache_key}.txt")
    if os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            return f.read()

    prompt = f"""この大学入試問題を全問解いてください。途中式を全て示し、各小問の最終答えを明記せよ。

{problem_text}"""

    for attempt in range(3):
        try:
            resp = requests.post(
                "https://api.mistral.ai/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": MISTRAL_LARGE_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 8192,
                },
                timeout=120,
            )
        except Exception as e:
            print(f"  Answer通信エラー(attempt {attempt+1}): {e}", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
            continue

        if resp.status_code == 200:
            answer = resp.json()["choices"][0]["message"]["content"]
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            with open(cache_path, "w", encoding="utf-8") as f:
                f.write(answer)
            return answer
        elif resp.status_code in (429, 500, 502, 503):
            time.sleep(5 * (attempt + 1))
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

    ensure_env()
    api_key = MISTRAL_API_KEY
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
        if not download_from_r2(r2_key, local_path):
            print(f"  SKIP: 画像取得失敗", file=sys.stderr)
            q["_local_image"] = local_path
            q["_ocr"] = {"text": "", "figures": []}
            q["_answer"] = ""
            continue
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
