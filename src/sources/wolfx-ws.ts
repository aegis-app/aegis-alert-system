// ==========================================
// 🚨 Wolfx WebSocket (EEW のプッシュ受信)
// ==========================================
// 🚨 Wolfx の jma_eew WebSocket に常時接続し、気象庁 EEW をプッシュで
// 即時受信する。変換は convert/wolfx.ts を HTTP 経路と共用し、同一視
// キーが P2P 556 と一致するため、経路が違っても同じ EEW は二重に
// 配信されない。
// API: wss://ws-api.wolfx.jp/jma_eew (サーバーは毎分 type:"heartbeat" を送る。
// 対象は type:"jma_eew" のみ)
// 📌 外部依存ゼロのため、WebSocket クライアントは Node 22 のグローバル
// WebSocket を使う。再接続・死活監視の規則は DMDSS WS とそろえている。
import { parseWolfxEew, type WolfxParseOptions } from "../convert/wolfx.js";
import type { EventDraft } from "../types.js";

// 🌐 Wolfx EEW WebSocket の URL
export const WOLFX_WS_URL = "wss://ws-api.wolfx.jp/jma_eew";

// 🧩 グローバル WebSocket の最小インターフェース (テストで差し替え可能にする)
export interface WolfxSocket {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  close(): void;
}

// 🧩 ソケット生成の差し替え口 (テスト用)
export type WolfxSocketFactory = (url: string) => WolfxSocket;

// 📦 Wolfx WS クライアントの生成オプション
export interface WolfxWsClientOptions {
  // 🔧 接続先 (既定 WOLFX_WS_URL)
  url?: string;
  // 🧪 WebSocket の生成方法 (テスト用に差し替え可能)
  createSocket?: WolfxSocketFactory;
  // ⏳ 再接続までの待機 (ms)。尽きたら最後の値を繰り返す (既定 5秒→10秒→30秒→60秒)
  reconnectDelaysMs?: number[];
  // 🚨 変換できた EEW の受け渡し先
  onEew: (eew: EventDraft) => void | Promise<void>;
  // 📡 メッセージ (heartbeat を含む) を受信するたびに呼ばれる (死活・状態表示用)
  onActivity?: () => void;
  // 📡 接続状態が変わるたびに呼ばれる
  onStateChange?: (connected: boolean) => void;
  // 📝 通常ログ (既定は無出力)
  log?: (msg: string) => void;
  // 📝 警告ログ (既定は無出力)
  warn?: (msg: string) => void;
  // 🔍 parseWolfxEew へ渡す鮮度判定など (テスト用)
  parseOptions?: WolfxParseOptions;
  // 📡 死活監視: この時間メッセージが一切届かなければ半開き接続とみなして
  // 強制再接続する (既定180秒。サーバーは毎分 heartbeat を送るため)
  livenessTimeoutMs?: number;
  // 📡 死活監視の確認間隔 (既定30秒)
  livenessCheckMs?: number;
}

// ⏳ 再接続間隔の既定 (尽きたら最後の値を繰り返す)
const DEFAULT_RECONNECT_DELAYS_MS = [5000, 10000, 30000, 60000];
// 📡 死活監視の既定 (無音の上限 / 確認間隔)
const DEFAULT_LIVENESS_TIMEOUT_MS = 180000;
const DEFAULT_LIVENESS_CHECK_MS = 30000;

// 🔌 Node 22 のグローバル WebSocket からソケットを作る
function defaultSocketFactory(url: string): WolfxSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WolfxSocket }).WebSocket;
  if (!Ctor) throw new Error("グローバル WebSocket が利用できません (Node 22 が必要です)");
  return new Ctor(url);
}

// 🚨 Wolfx WebSocket に常時接続して EEW をプッシュ受信する
export class WolfxWsClient {
  private socket: WolfxSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  // 🕐 最後にメッセージ (heartbeat を含む) を受信した時刻
  private lastActivityAt = 0;
  // 🔢 連続失敗回数 (再接続間隔の選択に使う)
  private failures = 0;
  private stopped = true;
  private readonly url: string;
  private readonly createSocket: WolfxSocketFactory;
  private readonly delays: number[];
  private readonly log: (msg: string) => void;
  private readonly warn: (msg: string) => void;

  constructor(private options: WolfxWsClientOptions) {
    this.url = options.url ?? WOLFX_WS_URL;
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
    this.connect();
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

  // 🔌 WebSocket へ接続してイベント処理を取り付ける
  private connect(): void {
    if (this.stopped || this.socket) return;
    let socket: WolfxSocket;
    try {
      socket = this.createSocket(this.url);
    } catch (err) {
      this.warn(
        `Wolfx WebSocket の接続開始に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.lastActivityAt = Date.now();
    socket.addEventListener("open", () => {
      this.failures = 0;
      this.lastActivityAt = Date.now();
      this.log("Wolfx WebSocket に接続しました (EEW プッシュ受信)");
      this.options.onStateChange?.(true);
    });
    socket.addEventListener("message", (ev) => {
      // 📌 heartbeat を含む全メッセージを死活の証跡にする
      this.lastActivityAt = Date.now();
      this.options.onActivity?.();
      this.handleMessage(ev.data);
    });
    socket.addEventListener("error", () => {
      // 📌 error の後には close が来るため、再接続は close 側に任せる
      this.warn("Wolfx WebSocket エラーが発生しました");
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
  // 📡 死活監視
  // ------------------------------------------
  // 💬 サーバーは毎分 heartbeat を送るため、長時間メッセージが一切届かない
  // 接続は close も発火しない半開き (ゾンビ) 接続の可能性が高い。
  // 無音が続いたら切断して通常の再接続へ倒す
  private startLiveness(socket: WolfxSocket): void {
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
        `Wolfx WebSocket から ${Math.round(timeoutMs / 1000)} 秒以上メッセージが届かないため、接続を強制再接続します`,
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
    this.warn(`Wolfx WebSocket が切断されました (${Math.round(delay / 1000)} 秒後に再接続します)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // 📨 受信メッセージを解析して EEW だけ取り出す
  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return; // JSON でないメッセージは対象外として読み捨てる
    }
    if (!parsed || typeof parsed !== "object") return;
    // 📌 heartbeat / pong など jma_eew 以外は無視する
    if ((parsed as { type?: unknown }).type !== "jma_eew") return;
    // 🔀 変換規則 (訓練除外・鮮度5分・同一視キー) は HTTP 経路と同一のものを使う
    const eew = parseWolfxEew(parsed, this.options.parseOptions);
    if (!eew) return;
    void Promise.resolve()
      .then(() => this.options.onEew(eew))
      .catch((err: unknown) => {
        this.warn(
          `Wolfx WebSocket で受信した EEW の取り込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
