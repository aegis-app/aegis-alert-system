// ==========================================
// 🌐 気象庁防災情報XML (PULL型) の取り込み
// ==========================================
// 📌 気象庁が公開する Atom フィード (随時 / 地震火山) をポーリングし、
// 未読 entry の本文を取得して Phase 3 の変換器 (convert/jma-xml.ts) で
// 共通フォーマットの下書きへ変換する。本ファイルはフィード取得と
// 既読管理 (状態持ち部品) を担う。
// ⚠️ 既読管理は必須: 気象庁の運用指針では同一 URL への 1日 10GB 超の
// ダウンロードで IP 遮断されるため、entry の <id> で既読を管理し、
// 取得済み電文の本文は二度と取得しない。本文取得に失敗した entry は
// 既読にせず、次回ポーリングで再試行する。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { USER_AGENT } from "../util.js";
import {
  classifyDataCode,
  parseFeedEntries,
  parseFloodTelegram,
  parseLinearRainTelegram,
  parseRecordRainTelegram,
  parseSedimentTelegram,
  parseTornadoTelegram,
  parseVolcanoTelegram,
  type FeedEntry,
} from "../convert/jma-xml.js";
import type { EventDraft, SedimentDraft } from "../types.js";

// 🌐 フィード URL (高頻度版。長期版 *_l は初回取り込みの取りこぼし
// 防止に使えるが、火山の降灰予報だけで数百件あり一斉取得の負荷が
// 大きいため、定常ポーリングでは使わない)
export const JMA_XML_EXTRA_FEED_URL = "https://www.data.jma.go.jp/developer/xml/feed/extra.xml";
export const JMA_XML_EQVOL_FEED_URL = "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml";

// ------------------------------------------
// 📚 既読管理 (entry ID の永続化)
// ------------------------------------------
// 📌 既読集合はメモリ + ファイル (dataFile と同じディレクトリの
// jma-xml-seen.json) に保持する。上限を超えたら古いものから落とす
// (フィードは直近分しか保持しないため、古い ID が再び現れることは
// 実質ない)。保存は store.ts と同じく tmp + rename の原子的書き込み
export const SEEN_LIMIT_DEFAULT = 5000;

// 📚 既読集合 (順序つき。上限で古いものから落とす)
export class JmaXmlSeenStore {
  // 📚 既読 ID の列 (古い順)。上限管理に使う
  private ids: string[] = [];
  // 🔍 既読判定用の集合
  private readonly set = new Set<string>();
  private readonly filePath?: string;
  private readonly limit: number;

  constructor(filePath?: string, limit: number = SEEN_LIMIT_DEFAULT) {
    this.filePath = filePath;
    this.limit = Math.max(100, limit);
  }

  // 💾 ファイルから復元する。壊れたファイルは空として扱い、起動を止めない
  load(): void {
    if (!this.filePath) return;
    try {
      const arr = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(arr)) return;
      for (const v of arr) {
        if (typeof v === "string" && v) this.addInternal(v);
      }
    } catch {
      // ⚠️ ファイルが無いのは初回起動として正常。壊れている場合も
      // 空から始める (再取得は上限つきフィードの範囲に限られる)
    }
  }

  // 🔍 既読かどうか
  has(id: string): boolean {
    return this.set.has(id);
  }

  // 🔢 現在の既読件数
  get size(): number {
    return this.set.size;
  }

  // 📌 既読として記録し、上限を超えた分は古いものから落とす
  markSeen(id: string): void {
    this.addInternal(id);
  }

  // 📌 既読へ追加する (重複は無視し、上限を超えたら古い順に落とす)
  private addInternal(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.ids.push(id);
    while (this.ids.length > this.limit) {
      const old = this.ids.shift()!;
      this.set.delete(old);
    }
  }

  // 💾 現在の既読集合をファイルへ書く。失敗しても取り込みは止めない
  save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.ids), "utf8");
      renameSync(tmp, this.filePath);
    } catch {
      // ⚠️ 永続化に失敗してもメモリ上の既読は効くため、次回保存で回復する
    }
  }
}

// ------------------------------------------
// 🔄 取得ヘルパー (jma.ts と同じ作法: User-Agent + 15秒タイムアウト)
// ------------------------------------------
async function fetchTextDefault(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`気象庁が ${res.status} を返しました (${url})`);
  return res.text();
}

// ------------------------------------------
// 📡 JMA XML ソース (状態を持つサービスクラス)
// ------------------------------------------
// 📌 既読集合を保持し、フィード1回分のポーリングで「新規 entry の本文を
// 取得 → 分類 → 変換」までを行う。イベント型のドメインは drafts に、
// 土砂災害警戒情報は完全集合型のため sedimentDrafts + 取得に成功した
// 都道府県 (スコープ) を分けて返し、ハブが store.applySedimentSnapshot
// へ渡す。気象情報のうち顕著な大雨でないものは、本文取得に成功した
// 時点で既読にし (次回再取得しない)、下書きは作らない
export interface JmaXmlPollResult {
  // 📥 イベント型ドメインの下書き (flood / tornado / record-rain /
  // linear-rain / volcano)
  drafts: EventDraft[];
  // 🏔️ 土砂災害警戒情報の有効集合の下書き
  sedimentDrafts: SedimentDraft[];
  // 🏔️ 土砂: 取得・変換に成功した電文があった都道府県 (差分のスコープ)
  sedimentPrefs: string[];
  // 🔢 本文取得を試みた新規 entry 数
  fetchedEntries: number;
  // ❌ 本文取得・変換に失敗した entry (既読にしていないため再試行される)
  failures: { entryId: string; message: string }[];
}

// 📦 JMA XML ソースの生成オプション
export interface JmaXmlSourceOptions {
  // 💾 既読ファイルのパス (省略時はメモリのみ)
  seenFilePath?: string;
  // 📚 既読集合の上限
  seenLimit?: number;
  // 🧪 テスト用に取得関数を差し替え可能にする
  fetchText?: (url: string) => Promise<string>;
}

// 📦 空のポーリング結果 (pollAll の統合の初期値)
const emptyPollResult = (): JmaXmlPollResult => ({
  drafts: [],
  sedimentDrafts: [],
  sedimentPrefs: [],
  fetchedEntries: 0,
  failures: [],
});

// 📡 気象庁防災情報XML のソース (既読集合の状態を持つ)
export class JmaXmlSource {
  // 📚 既読管理 (永続化つき)
  private readonly seen: JmaXmlSeenStore;
  private readonly fetchText: (url: string) => Promise<string>;

  constructor(options: JmaXmlSourceOptions = {}) {
    this.seen = new JmaXmlSeenStore(options.seenFilePath, options.seenLimit);
    this.seen.load();
    this.fetchText = options.fetchText ?? fetchTextDefault;
  }

  // 📚 現在の既読件数 (テスト・状態確認用)
  get seenCount(): number {
    return this.seen.size;
  }

  // 🔄 フィード1つをポーリングする。フィード自体の取得に失敗した場合は
  // 例外を投げ、呼び出し側 (ハブ) が健康状態へ記録する。本文の取得に
  // 失敗した entry は既読にせず failures に記録する
  async pollFeed(feedUrl: string): Promise<JmaXmlPollResult> {
    const feedXml = await this.fetchText(feedUrl);
    const entries = parseFeedEntries(feedXml);
    const result = emptyPollResult();
    // 📌 対象コードの未読 entry だけを、古い順に処理する。同一発表の
    // 続報 (例: 竜巻の VPHW50 → VPHW51) は新しい方が後に勝つ必要が
    // あるため、フィードの新しい順ではなく発表順に取り込む
    const targets = entries
      .filter((e) => classifyDataCode(e.code) !== null && !this.seen.has(e.id))
      .sort((a, b) => (a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : 0));
    let seenChanged = false;
    for (const entry of targets) {
      result.fetchedEntries += 1;
      let xml: string;
      try {
        xml = await this.fetchText(entry.url);
      } catch (err) {
        // ❌ 本文取得に失敗した entry は既読にしない (次回再試行する)
        result.failures.push({
          entryId: entry.id,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // ✅ 本文が取れた時点で既読にする。対象外と判明した気象情報
      // (顕著な大雨でないもの) も再取得しないため、変換結果によらず
      // ここで既読化する。変換が例外になった場合も本文自体は取得
      // できているため既読とし、失敗として数だけ failures に残す
      this.seen.markSeen(entry.id);
      seenChanged = true;
      try {
        this.convertInto(entry, xml, result);
      } catch (err) {
        result.failures.push({
          entryId: entry.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (seenChanged) this.seen.save();
    return result;
  }

  // 🔄 複数フィードをポーリングして結果を統合する。1フィードの取得
  // 失敗は全体を止めず、呼び出し側が健康状態をフィード別に持つため、
  // ハブは通常 pollFeed をフィードごとに呼ぶ。こちらはテスト等の
  // 一括用途
  async pollAll(feedUrls: string[]): Promise<JmaXmlPollResult> {
    const merged = emptyPollResult();
    for (const url of feedUrls) {
      const r = await this.pollFeed(url);
      merged.drafts.push(...r.drafts);
      merged.sedimentDrafts.push(...r.sedimentDrafts);
      for (const p of r.sedimentPrefs) {
        if (!merged.sedimentPrefs.includes(p)) merged.sedimentPrefs.push(p);
      }
      merged.fetchedEntries += r.fetchedEntries;
      merged.failures.push(...r.failures);
    }
    return merged;
  }

  // 🔀 取得済み電文を分類に応じて変換し、結果へ振り分ける
  private convertInto(entry: FeedEntry, xml: string, result: JmaXmlPollResult): void {
    const cls = classifyDataCode(entry.code);
    switch (cls) {
      case "flood": {
        const d = parseFloodTelegram(xml);
        if (d) result.drafts.push(d);
        break;
      }
      case "sediment": {
        const s = parseSedimentTelegram(xml);
        if (s) {
          result.sedimentDrafts.push(...s.drafts);
          if (!result.sedimentPrefs.includes(s.prefName)) result.sedimentPrefs.push(s.prefName);
        }
        break;
      }
      case "tornado": {
        const d = parseTornadoTelegram(xml, entry.code);
        if (d) result.drafts.push(d);
        break;
      }
      case "record-rain": {
        const d = parseRecordRainTelegram(xml);
        if (d) result.drafts.push(d);
        break;
      }
      case "linear-rain-candidate": {
        // 📌 顕著な大雨に関する情報だけが下書きになる。それ以外は
        // 取り込まない (既読化は pollFeed 側で済んでいる)
        const d = parseLinearRainTelegram(xml);
        if (d) result.drafts.push(d);
        break;
      }
      case "volcano": {
        const d = parseVolcanoTelegram(xml, entry.code);
        if (d) result.drafts.push(d);
        break;
      }
      default:
        break;
    }
  }
}
