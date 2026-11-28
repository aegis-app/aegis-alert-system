// ==========================================
// 🌡️ 熱中症警戒アラート (環境省 WBGT 電子情報提供サービス) の取り込み
// ==========================================
// 📌 環境省「熱中症予防情報サイト」の暑さ指数 (WBGT) 電子情報提供
// サービスが公開するアラート発表情報 CSV を使う (登録不要・公式)。
// 本データは環境省熱中症予防情報サイトからの提供情報を利用している。
// CSV は参考情報という位置づけで、正式発表は環境省のサイト/報道発表
// が正である。変換は convert/wbgt.ts が担い、本ファイルは候補ファイル
// の取得だけを行う。
// 📌 運用は季節限定 (4月第4水曜〜10月下旬) で、期間外は当日ファイル
// 自体が存在しない。取得できない場合は「発表なし (全解除)」では
// なく「状態不明」として前回状態を保持する (hub.ts 参照)
import { USER_AGENT } from "../util.js";
import { parseWbgtAlertCsv, wbgtCandidateUrls } from "../convert/wbgt.js";
import type { HeatDraft } from "../types.js";

// 🌡️ CSV をテキストで取得する (文字コードは UTF-8。実ファイルの
// Encoding 宣言で確認済み)
async function fetchTextDefault(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`環境省 WBGT が ${res.status} を返しました (${url})`);
  return new TextDecoder("utf-8").decode(await res.arrayBuffer());
}

// 📦 熱中症アラート取得のオプション
export interface HeatFetchOptions {
  // 🧪 テキスト取得関数の差し替え口 (テスト用)
  fetchText?: (url: string) => Promise<string>;
  // 🕐 候補 URL の生成基準時刻 (テスト用)
  now?: Date;
}

// 🌡️ 当日分→前日分の順に候補を試し、最初に取得できた CSV を変換して
// 返す。どの候補も取得できなければ null を返す (季節外など。この場合
// 呼び出し側はスナップショットを適用せず前回状態を保持すること)
export async function fetchHeatSnapshot(options: HeatFetchOptions = {}): Promise<HeatDraft[] | null> {
  const fetchText = options.fetchText ?? fetchTextDefault;
  for (const url of wbgtCandidateUrls(options.now ?? new Date())) {
    try {
      const text = await fetchText(url);
      return parseWbgtAlertCsv(text);
    } catch {
      // 📌 次の候補を試す (404 は「その回の発表ファイルが無い」だけの意味)
    }
  }
  return null;
}
