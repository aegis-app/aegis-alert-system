// ==========================================
// 📝 アクセスログ (認証済みリクエストの記録)
// ==========================================
// 📌 誰 (どのトークン) が・いつ・何を取得したかを後から追えるようにする
// ための記録。1リクエスト1行のテキスト形式で data/access.log に追記する。
// - トークンの値そのものは絶対に書かない (識別は名前のみ)
// - パスはクエリを含まない pathname だけを書く (SSE の ?token= が
//   ログに残らないようにするため)
// - 書き込みは同期追記 (量が少なく、記録の確実さを優先する)。失敗しても
//   サーバー本体は止めない
// - ローテーションは簡易式: 既定 5MB を超えたら access.log.1 へ
//   改名して1世代だけ残す
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

// 📝 アクセスログ1件分
export interface AccessLogEntry {
  // 🔑 認証に使われたトークンの識別子 (owner / クライアント名 / anonymous)
  identity: string;
  method: string;
  // 🌐 クエリを含まないパス (例: /v1/events)
  path: string;
  status: number;
}

// 📏 ローテーションの閾値 (バイト)
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// 📝 アクセスログの追記者
export class AccessLogger {
  private readonly filePath: string;
  private readonly maxBytes: number;

  constructor(filePath: string, maxBytes: number = DEFAULT_MAX_BYTES) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    try {
      // 📁 出力先ディレクトリは先に作っておく (初回起動で data/ が
      // 無い場合に、記録が黙って全て落ちるのを防ぐ)
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      // ⚠️ 作れなくても本体は止めない (追記時に改めて失敗として扱う)
    }
  }

  // 📝 1件追記する。書式: ISO時刻 identity method path status
  log(entry: AccessLogEntry): void {
    const line = `${new Date().toISOString()} ${entry.identity} ${entry.method} ${entry.path} ${entry.status}\n`;
    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.filePath, line, "utf-8");
    } catch {
      // ⚠️ ログの失敗でリクエスト処理やサーバー本体を巻き込まない
    }
  }

  // 🔄 書き込み後に上限を超えるようなら、現行ファイルを .1 へ改名する
  private rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return; // ファイルが無ければローテーション不要
    }
    if (size + incomingBytes <= this.maxBytes) return;
    try {
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // ⚠️ 改名に失敗しても追記自体は続ける
    }
  }
}
