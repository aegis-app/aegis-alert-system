// ==========================================
// 🧪 テスト用フェイク WebSocket (wolfx-ws / dmdss-ws / hub のテストで共用)
// ==========================================
import type { WolfxSocket } from "../src/sources/wolfx-ws.js";

// 🔌 イベント発火を手動で制御できるフェイクソケット。
// DMDSS の pong 返信確認のため send も記録する
export class FakeSocket implements WolfxSocket {
  private listeners = new Map<string, ((ev: never) => void)[]>();
  // 🔌 close されたかどうか
  closed = false;
  // 📨 send された文字列の一覧 (DMDSS の pong 検証用)
  sent: string[] = [];

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(type: string, listener: (ev: never) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener as (ev: never) => void);
    this.listeners.set(type, arr);
  }

  // 📨 DMDSS クライアントが pong 返信に使う送信口 (内容を記録するだけ)
  send(data: string): void {
    this.sent.push(data);
  }

  private emit(type: string, ev?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) (l as (e: unknown) => void)(ev);
  }

  // 🔌 接続完了を発火する
  open(): void {
    this.emit("open");
  }

  // 📨 メッセージ受信を発火する
  message(data: unknown): void {
    this.emit("message", { data });
  }

  // 🔌 切断を発火する (二重発火はしない)
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

// ⏳ 実時間で少し待つ (タイマー駆動のテスト用)
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
