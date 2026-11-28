// ==========================================
// 🧪 テスト: Wolfx WebSocket クライアント (疑似ソケット)
// ==========================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WolfxWsClient } from "../src/sources/wolfx-ws.js";
import { FakeSocket, sleep } from "./fake-socket.js";
import type { EventDraft } from "../src/types.js";

function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8")) as Record<string, unknown>;
}

// 📌 フィクスチャの発表時刻 (2026/11/19 02:23 JST) に鮮度判定の基準を合わせる
const FIXTURE_NOW = new Date("2026-11-19T02:24:00+09:00");

test("Wolfx WS: jma_eew メッセージが変換されて渡され、heartbeat は死活だけに効く", async (t) => {
  const sockets: FakeSocket[] = [];
  const received: EventDraft[] = [];
  let activities = 0;
  const client = new WolfxWsClient({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onEew: (eew) => {
      received.push(eew);
    },
    onActivity: () => {
      activities += 1;
    },
    parseOptions: { now: FIXTURE_NOW },
  });
  t.after(() => client.stop());
  client.start();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  assert.equal(client.connected, true);

  sockets[0].message(JSON.stringify({ type: "heartbeat" }));
  assert.equal(received.length, 0);
  assert.equal(activities, 1);

  const eewJson = { ...fixtureJson("wolfx-eew-kumamoto.json"), type: "jma_eew" };
  sockets[0].message(JSON.stringify(eewJson));
  await sleep(10);
  assert.equal(received.length, 1);
  assert.equal(received[0].kind, "eew");
  client.stop();
  assert.equal(client.connected, false);
});

test("Wolfx WS: 切断すると再接続し、stop 後は再接続しない", async (t) => {
  const sockets: FakeSocket[] = [];
  const client = new WolfxWsClient({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onEew: () => {},
    reconnectDelaysMs: [10],
  });
  t.after(() => client.stop());
  client.start();
  sockets[0].open();
  sockets[0].close();
  await sleep(40);
  assert.equal(sockets.length, 2, "切断後に新しいソケットで再接続する");
  client.stop();
  sockets[1].close();
  await sleep(40);
  assert.equal(sockets.length, 2, "stop 後は再接続しない");
});

test("Wolfx WS: 無音が続くと半開き接続とみなして強制再接続する", async (t) => {
  const sockets: FakeSocket[] = [];
  const client = new WolfxWsClient({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onEew: () => {},
    reconnectDelaysMs: [5],
    livenessTimeoutMs: 30,
    livenessCheckMs: 10,
  });
  t.after(() => client.stop());
  client.start();
  sockets[0].open();
  await sleep(90);
  client.stop();
  assert.ok(sockets.length >= 2, "無音のままでは再接続される");
});
