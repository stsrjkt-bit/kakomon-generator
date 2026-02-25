/**
 * kakomon-manager のトピックマスターリスト（ツリー形式）を読み込み、
 * kakomon-generator のフラット配列形式に変換して上書きする。
 *
 * 使い方:
 *   npx tsx scripts/sync-topic-master.ts
 *   npx tsx scripts/sync-topic-master.ts --dry-run   # 差分のみ表示
 *
 * 正本: kakomon-manager/lib/constants/topic-master.ts
 * 生成物: kakomon-generator/src/constants/topic-master.ts
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// kakomon-manager の topic-master を動的インポート
const MANAGER_ROOT = path.resolve(__dirname, "../../kakomon-manager");
const MANAGER_TOPIC_MASTER = path.join(MANAGER_ROOT, "lib/constants/topic-master.ts");

if (!fs.existsSync(MANAGER_TOPIC_MASTER)) {
  console.error(`❌ kakomon-manager が見つかりません: ${MANAGER_TOPIC_MASTER}`);
  console.error("   kakomon-manager リポジトリが ../kakomon-manager に存在することを確認してください");
  process.exit(1);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // kakomon-manager の getAllTopicFullPaths() を使用
  // tsx は TypeScript を直接インポートできる
  const managerModule = await import(MANAGER_TOPIC_MASTER);
  const getAllTopicFullPaths: () => string[] = managerModule.getAllTopicFullPaths;

  if (typeof getAllTopicFullPaths !== "function") {
    console.error("❌ kakomon-manager の getAllTopicFullPaths() が見つかりません");
    process.exit(1);
  }

  const allPaths = getAllTopicFullPaths();
  console.log(`📋 kakomon-manager から ${allPaths.length} トピックを取得`);

  // 科目ごとにグループ化（コメントセクション用）
  const bySubject = new Map<string, string[]>();
  for (const p of allPaths) {
    const subject = p.split("/")[0];
    if (!bySubject.has(subject)) {
      bySubject.set(subject, []);
    }
    bySubject.get(subject)!.push(p);
  }

  // フラット配列ファイルを生成
  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * トピックマスターリスト（kakomon-manager から自動同期）`);
  lines.push(` *`);
  lines.push(` * 形式: "科目/分野/単元/サブ単元/トピック"`);
  lines.push(` *`);
  lines.push(` * ⚠ このファイルは自動生成です。直接編集しないでください。`);
  lines.push(` * ⚠ タグの追加・修正は kakomon-manager 側で行い、以下のコマンドで同期:`);
  lines.push(` *   npx tsx scripts/sync-topic-master.ts`);
  lines.push(` *`);
  lines.push(` * Phase3（トピック付け）で使用する。`);
  lines.push(` * ここに存在しないパスは出力してはならない。`);
  lines.push(` *`);
  lines.push(` * ※ トピック名に "/" を含むものがある（例: "1/6公式"）。`);
  lines.push(` *   パスの分割は先頭4つの "/" で行い、残りはトピック名として扱うこと。`);
  lines.push(` */`);
  lines.push(`export const TOPIC_MASTER: readonly string[] = [`);

  for (const [subject, paths] of bySubject) {
    lines.push(`  // ============================================================`);
    lines.push(`  // ${subject}`);
    lines.push(`  // ============================================================`);
    for (const p of paths) {
      lines.push(`  ${JSON.stringify(p)},`);
    }
  }

  lines.push(`] as const;`);
  lines.push(``);
  lines.push(`/** トピックパスの高速検索用Set */`);
  lines.push(`export const TOPIC_MASTER_SET: ReadonlySet<string> = new Set(TOPIC_MASTER);`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * 指定パスがマスターリストに存在するか検証する`);
  lines.push(` * ※ トピック名に "/" を含む場合があるため、完全一致で検索する`);
  lines.push(` */`);
  lines.push(`export function isValidTopic(path: string): boolean {`);
  lines.push(`  return TOPIC_MASTER_SET.has(path);`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/** 指定科目のトピック一覧を取得する */`);
  lines.push(`export function getTopicsForSubject(subject: string): string[] {`);
  lines.push(`  const prefix = subject + "/";`);
  lines.push(`  return TOPIC_MASTER.filter((t) => t.startsWith(prefix));`);
  lines.push(`}`);
  lines.push(``);

  const content = lines.join("\n");
  const outPath = path.resolve(__dirname, "../src/constants/topic-master.ts");

  // 差分チェック
  const currentContent = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf-8") : "";
  if (content === currentContent) {
    console.log("✅ 差分なし（既に同期済み）");
    return;
  }

  // 差分の表示
  const currentTopics = new Set(
    currentContent.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)).filter((s) => s.includes("/")) ?? [],
  );
  const newTopics = new Set(allPaths);

  const added = allPaths.filter((p) => !currentTopics.has(p));
  const removed = [...currentTopics].filter((p) => !newTopics.has(p) && p.includes("/") && !p.startsWith("科目/"));

  if (added.length > 0) {
    console.log(`\n➕ 追加 (${added.length}件):`);
    for (const a of added) console.log(`  + ${a}`);
  }
  if (removed.length > 0) {
    console.log(`\n➖ 削除 (${removed.length}件):`);
    for (const r of removed) console.log(`  - ${r}`);
  }

  if (dryRun) {
    console.log(`\n🔍 dry-run: ${allPaths.length} トピック → ${outPath}`);
    console.log("   実行するには --dry-run を外してください");
    return;
  }

  fs.writeFileSync(outPath, content, "utf-8");
  console.log(`\n✅ 同期完了: ${allPaths.length} トピック → ${outPath}`);
}

main().catch((err) => {
  console.error("❌ エラー:", err);
  process.exit(1);
});
