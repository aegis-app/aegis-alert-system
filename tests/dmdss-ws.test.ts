// ==========================================
// 🧪 テスト: DMDSS WebSocket クライアント (疑似ソケット + Socket Start 差し替え)
// ==========================================
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DmdssWsClient } from "../src/sources/dmdss-ws.js";
import { FakeSocket, sleep } from "./fake-socket.js";
import type { EventDraft } from "../src/types.js";

function fixtureText(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8");
}

// 📦 EEW 電文 (gzip + base64) の data メッセージを作る
function eewDataMessage(): string {
  const xml = fixtureText("dmdss-vxse45-eew.xml");
  return JSON.stringify({
    type: "data",
    classification: "eew.forecast",
    head: { type: "VXSE45", test: false },
    format: "xml",
    compression: "gzip",
    encoding: "base64",
    body: gzipSync(Buffer.from(xml, "utf-8")).toString("base64"),
  });
}

test("DMDSS WS: ping へ同じ pingId で pong を返し、data の EEW が変換されて渡される", async (t) => {
  const sockets: FakeSocket[] = [];
  const received: EventDraft[] = [];
  const client = new DmdssWsClient({
    apiKey: "test-api-key",
    classifications: ["eew.forecast"],
    startSocket: async () => ({ url: "wss://example.invalid/socket" }),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onDraft: (draft) => {
      received.push(draft);
    },
  });
  t.after(() => client.stop());
  client.start();
  await sleep(10); // Socket Start は非同期
  assert.equal(sockets.length, 1);
  sockets[0].open();
  assert.equal(client.connected, true);

  sockets[0].message(JSON.stringify({ type: "ping", pingId: "abc-123" }));
  assert.deepEqual(sockets[0].sent, [JSON.stringify({ type: "pong", pingId: "abc-123" })]);

  sockets[0].message(eewDataMessage());
  await sleep(10);
  assert.equal(received.length, 1);
  assert.equal(received[0].kind, "eew");
  client.stop();
});

test("DMDSS WS: 試験電文 (test) は取り込まない", async (t) => {
  const sockets: FakeSocket[] = [];
  const received: EventDraft[] = [];
  const client = new DmdssWsClient({
    apiKey: "test-api-key",
    startSocket: async () => ({ url: "wss://example.invalid/socket" }),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onDraft: (draft) => {
      received.push(draft);
    },
  });
  t.after(() => client.stop());
  client.start();
  await sleep(10);
  sockets[0].open();
  const msg = JSON.parse(eewDataMessage()) as { head: { test: boolean } };
  msg.head.test = true;
  sockets[0].message(JSON.stringify(msg));
  await sleep(10);
  client.stop();
  assert.equal(received.length, 0);
});

test("DMDSS WS: Socket Start の失敗では例外にせず、再接続を予約する", async (t) => {
  let starts = 0;
  const warnings: string[] = [];
  const client = new DmdssWsClient({
    apiKey: "test-api-key",
    startSocket: async () => {
      starts += 1;
      throw new Error("maximum connections");
    },
    createSocket: () => new FakeSocket(),
    onDraft: () => {},
    warn: (msg) => warnings.push(msg),
    reconnectDelaysMs: [10],
  });
  t.after(() => client.stop());
  client.start();
  await sleep(60);
  client.stop();
  assert.ok(starts >= 2, "失敗しても再試行する (単一接続の空き待ちを含む)");
  assert.ok(warnings.some((w) => w.includes("Socket Start")));
});
