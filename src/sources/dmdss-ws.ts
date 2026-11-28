// ==========================================
// 🌐 DMDSS (Project DM-D.S.S) WebSocket (EEW・地震・津波のプッシュ受信)
// ==========================================
// 🌐 DMDATA API v2 の WebSocket に常時接続し、気象庁電文 (XML) を
// プッシュで即時受信する。変換は convert/dmdss.ts が担い、同一視キー
// が P2P 経路と一致する (EEW) / ストア側で同一視する (津波) ため、
// 移行期間中に両経路が流れても同じ地震は二重に配信されない。
//
// 📌 接続手順 (公式 API リファレンス / WebSocket v2 ドキュメントで確認):
// 1. POST https://api.dmdata.jp/v2/socket (Socket Start) でチケットを
//    発行する。認証は Authorization: Basic base64("<APIキー>:")。
//    チケットは1回限り・有効期限5分で、接続は1本だけ (単一接続)。
// 2. 応答の websocket.url へサブプロトコル "dmdata.v2" で接続する。
// 3. サーバーから {"type":"ping","pingId":...} が届いたら、同じ pingId
//    で {"type":"pong",...} を返す (120秒以内に返さないと切断される)。
// 4. 電文は {"type":"data", ...} で届く。body のデコードは変換器側。
//
// 📌 契約範囲 (現行契約は EEW（予報）のみ): 購読区分は呼び出し側が
// 設定 (A2S_DMDSS_CLASSIFICATIONS) で絞る。未指定なら組み込み既定
// (eew.forecast + telegram.earthquake) を使う。地震・津波の正は P2P。
// 📌 API キー (環境変数 A2S_DMDSS_API_KEY) が未設定のときは Hub 側で
// このクライアント自体を作らない (取り込みは完全に無効)。
// 📌 外部依存ゼロのため、WebSocket は Node 22 のグローバル WebSocket を
// 使う。再接続・死活監視の規則は Wolfx WS とそろえている。
import {
  decodeDmdssBody,
  parseDmdssEew,
  parseDmdssTsunami,
  DMDSS_TELEGRAM_TYPES,
  DmdssQuakeAccumulator,
  type DmdssDataMessage,
} from "../convert/dmdss.js";
import type { EventDraft } from "../types.js";

// 🎫 Socket Start のエンドポイント
export const DMDSS_SOCKET_START_URL = "https://api.dmdata.jp/v2/socket";
// 📌 購読区分の組み込み既定: 緊急地震速報 (予報。警報も含む) と地震・津波関連
export const DMDSS_CLASSIFICATIONS = ["eew.forecast", "telegram.earthquake"];
// 🏷️ Socket Start で名乗るアプリケーション名
export const DMDSS_APP_NAME = "Aegis Alert System";

// 🧩 グローバル WebSocket の最小インターフェース (WolfxSocket に send を
// 足したもの。ping への pong 返信に必要)
export interface DmdssSocket {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

// 🧩 ソケット生成の差し替え口 (テスト用)
export type DmdssSocketFactory = (url: string) => DmdssSocket;

// 🎫 Socket Start の応答 (接続先 URL のみを使う)
export interface DmdssStartResult {
  // 🌐 発行されたチケットつき WebSocket URL (1回限り)
  url: string;
}

// 🎫 Socket Start の実行 (テスト用に差し替え可能)
export type DmdssStartSocketFn = (
  apiKey: string,
  classifications: string[],
  appName: string,
) => Promise<DmdssStartResult>;

// 🎫 Socket Start の実実装: チケットを発行して接続先 URL を得る
export async function startDmdssSocket(
  apiKey: string,
  classifications: string[],
  appName: string,
): Promise<DmdssStartResult> {
  const auth = Buffer.from(`${apiKey}:`, "utf-8").toString("base64");
  const res = await fetch(DMDSS_SOCKET_START_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ classifications, appName }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => null)) as {
    status?: string;
    websocket?: { url?: string };
    error?: { message?: string; code?: number };
  } | null;
  const url = json?.websocket?.url;
  if (!res.ok || json?.status !== "ok" || !url) {
    const detail = json?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Socket Start に失敗しました: ${detail}`);
  }
  return { url };
}

// 📦 DMDSS WS クライアントの生成オプション
export interface DmdssWsClientOptions {
  // 🔑 DMDATA の API キー (必須。未設定なら Hub がクライアントを作らない)
  apiKey: string;
  // 📋 購読する区分の一覧。未指定・空なら DMDSS_CLASSIFICATIONS を使う。
  // 契約区分に合わせて絞るための指定 (現行契約は eew.forecast のみ)
  classifications?: string[];
  // 🎫 Socket Start の実行方法 (テスト用に差し替え可能)
  startSocket?: DmdssStartSocketFn;
  // 🧪 WebSocket の生成方法 (テスト用に差し替え可能)
  createSocket?: DmdssSocketFactory;
  // ⏳ 再接続までの待機 (ms)。尽きたら最後の値を繰り返す (既定 5秒→10秒→30秒→60秒)
  reconnectDelaysMs?: number[];
  // 🚨 変換できたドラフトの受け渡し先
  onDraft: (draft: EventDraft) => void | Promise<void>;
  // 📡 メッセージ (ping を含む) を受信するたびに呼ばれる (死活・状態表示用)
  onActivity?: () => void;
  // 📡 接続状態が変わるたびに呼ばれる
  onStateChange?: (connected: boolean) => void;
  // 📝 通常ログ (既定は無出力)
  log?: (msg: string) => void;
  // 📝 警告ログ (既定は無出力)
  warn?: (msg: string) => void;
  // 📡 死活監視: この時間メッセージが一切届かなければ半開き接続とみなして
  // 強制再接続する (既定180秒。サーバーは定期的に ping を送るため)
  livenessTimeoutMs?: number;
  // 📡 死活監視の確認間隔 (既定30秒)
  livenessCheckMs?: number;
}

// ⏳ 再接続間隔の既定 (尽きたら最後の値を繰り返す)
const DEFAULT_RECONNECT_DELAYS_MS = [5000, 10000, 30000, 60000];
// 📡 死活監視の既定 (無音の上限 / 確認間隔)
const DEFAULT_LIVENESS_TIMEOUT_MS = 180000;
const DEFAULT_LIVENESS_CHECK_MS = 30000;

// 🔌 Node 22 のグローバル WebSocket からソケットを作る (サブプロトコル
// "dmdata.v2" を指定する)
function defaultSocketFactory(url: string): DmdssSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string, protocols: string) => DmdssSocket })
    .WebSocket;
  if (!Ctor) throw new Error("グローバル WebSocket が利用できません (Node 22 が必要です)");
  return new Ctor(url, "dmdata.v2");
}

// 🌐 DMDSS WebSocket に常時接続して電文をプッシュ受信する
export class DmdssWsClient {
  private socket: DmdssSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  // 🕐 最後にメッセージ (ping を含む) を受信した時刻
  private lastActivityAt = 0;
  // 🔢 連続失敗回数 (再接続間隔の選択に使う)
  private failures = 0;
  private stopped = true;
  // 📦 地震電文の蓄積 (震度速報→震源→震源・震度を1件へ統合する)
  private readonly quakes = new DmdssQuakeAccumulator();
  private readonly startSocket: DmdssStartSocketFn;
  private readonly createSocket: DmdssSocketFactory;
  private readonly delays: number[];
  private readonly log: (msg: string) => void;
  private readonly warn: (msg: string) => void;

  constructor(private options: DmdssWsClientOptions) {
    this.startSocket = options.startSocket ?? startDmdssSocket;
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.delays =
      options.reconnectDelaysMs && options.reconnectDelaysMs.length > 0
        ? options.reconnectDelaysMs
        : DEFAULT_RECONNECT_DELAYS_MS;
    this.log = options.log ?? (() => undefined);
    this.warn = options.warn ?? (() => undefined);
  }

  // 🚀 接続を開始する
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  // 🛑 接続を止める
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopLiveness();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // ⚠️ 終了時の close 失敗は無視する
    }
    this.options.onStateChange?.(false);
  }

  // 🔍 接続中かどうか
  get connected(): boolean {
    return this.socket !== null;
  }

  // 🔌 Socket Start でチケットを発行し、WebSocket へ接続する。
  // チケットは1回限り・単一接続のため、再接続のたびに発行し直す
  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    let url: string;
    try {
      const started = await this.startSocket(
        this.options.apiKey,
        this.options.classifications?.length
          ? this.options.classifications
          : DMDSS_CLASSIFICATIONS,
        DMDSS_APP_NAME,
      );
      url = started.url;
    } catch (err) {
      this.warn(
        `DMDSS の Socket Start に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    let socket: DmdssSocket;
    try {
      socket = this.createSocket(url);
    } catch (err) {
      this.warn(
        `DMDSS WebSocket の接続開始に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.lastActivityAt = Date.now();
    socket.addEventListener("open", () => {
      this.failures = 0;
      this.lastActivityAt = Date.now();
      this.log("DMDSS WebSocket に接続しました (EEW・地震・津波プッシュ受信)");
      this.options.onStateChange?.(true);
    });
    socket.addEventListener("message", (ev) => {
      // 📌 ping を含む全メッセージを死活の証跡にする
      this.lastActivityAt = Date.now();
      this.options.onActivity?.();
      this.handleMessage(socket, ev.data);
    });
    socket.addEventListener("error", () => {
      // 📌 error の後には close が来るため、再接続は close 側に任せる
      this.warn("DMDSS WebSocket エラーが発生しました");
    });
    socket.addEventListener("close", () => {
      const wasCurrent = this.socket === socket;
      if (wasCurrent) {
        this.socket = null;
        this.stopLiveness();
        this.options.onStateChange?.(false);
      }
      if (this.stopped || !wasCurrent) return;
      this.scheduleReconnect();
    });
    this.startLiveness(socket);
  }

  // ------------------------------------------
  // 📡 死活監視 (Wolfx WS と同じ作法)
  // ------------------------------------------
  private startLiveness(socket: DmdssSocket): void {
    this.stopLiveness();
    const timeoutMs = this.options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
    const checkMs = this.options.livenessCheckMs ?? DEFAULT_LIVENESS_CHECK_MS;
    this.livenessTimer = setInterval(() => {
      if (this.stopped || this.socket !== socket) {
        this.stopLiveness();
        return;
      }
      if (Date.now() - this.lastActivityAt <= timeoutMs) return;
      this.warn(
        `DMDSS WebSocket から ${Math.round(timeoutMs / 1000)} 秒以上メッセージが届かないため、接続を強制再接続します`,
      );
      this.stopLiveness();
      this.socket = null;
      this.options.onStateChange?.(false);
      try {
        socket.close();
      } catch {
        // ⚠️ 切断自体の失敗は無視する (再接続は進める)
      }
      this.scheduleReconnect();
    }, checkMs);
    this.livenessTimer.unref?.();
  }

  // ⏳ 死活監視タイマーを止める
  private stopLiveness(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  // 🔄 切断後の再接続を遅延付きで予約する
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.delays[Math.min(this.failures, this.delays.length - 1)];
    this.failures += 1;
    this.warn(`DMDSS WebSocket が切断されました (${Math.round(delay / 1000)} 秒後に再接続します)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // 📨 受信メッセージの振り分け (start / ping / data / error)
  private handleMessage(socket: DmdssSocket, data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return; // JSON でないメッセージは対象外として読み捨てる
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as { type?: unknown; pingId?: unknown };
    switch (msg.type) {
      case "ping": {
        // 📌 最新の pingId をそのまま返して pong する (不一致はエラー
        // 4640、無応答は 120秒で切断される。公式ドキュメントの作法)
        const pingId = typeof msg.pingId === "string" ? msg.pingId : "";
        try {
          socket.send(JSON.stringify({ type: "pong", pingId }));
        } catch {
          this.warn("DMDSS WebSocket への pong 送信に失敗しました");
        }
        return;
      }
      case "start": {
        const start = parsed as { socketId?: unknown; classifications?: unknown };
        this.log(
          `DMDSS の配信を開始しました (socketId: ${String(start.socketId ?? "?")}, 区分: ${
            Array.isArray(start.classifications) ? start.classifications.join(", ") : ""
          })`,
        );
        return;
      }
      case "error": {
        const e = parsed as { error?: unknown; code?: unknown; close?: unknown };
        this.warn(`DMDSS WebSocket エラー: ${String(e.error ?? "不明")} (code ${String(e.code ?? "?")})`);
        return;
      }
      case "data": {
        this.handleData(parsed as DmdssDataMessage);
        return;
      }
      default:
        return; // pong 等は無視する
    }
  }

  // 📥 data メッセージをデコードして電文種別ごとに変換する
  private handleData(msg: DmdssDataMessage): void {
    // 🧪 試験電文 (test) は取り込まない
    if (msg.head?.test === true) return;
    const telegramType = msg.head?.type ?? "";
    const xml = decodeDmdssBody(msg);
    if (xml === null) {
      this.warn(`DMDSS の電文をデコードできませんでした (type: ${telegramType || "?"})`);
      return;
    }
    let draft: EventDraft | null = null;
    try {
      if ((DMDSS_TELEGRAM_TYPES.eew as readonly string[]).includes(telegramType)) {
        draft = parseDmdssEew(xml, telegramType);
      } else if ((DMDSS_TELEGRAM_TYPES.quake as readonly string[]).includes(telegramType)) {
        draft = this.quakes.ingest(xml, telegramType);
      } else if ((DMDSS_TELEGRAM_TYPES.tsunami as readonly string[]).includes(telegramType)) {
        draft = parseDmdssTsunami(xml);
      } else {
        return; // 対象外の電文種別は読み飛ばす
      }
    } catch (err) {
      this.warn(
        `DMDSS の電文変換に失敗しました (type: ${telegramType}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!draft) return;
    void Promise.resolve()
      .then(() => this.options.onDraft(draft!))
      .catch((err: unknown) => {
        this.warn(
          `DMDSS で受信した電文の取り込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
