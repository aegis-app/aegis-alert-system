// ==========================================
// 🧪 テスト: Wolfx の変換 (EEW の予報経路)
// ==========================================
// 📌 鮮度判定は発表時刻からの経過で決まるため、基準時刻 (now) は
// フィクスチャの発表時刻に合わせて固定値を渡す (実時計に依存しない)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseEews } from "../src/convert/p2p.js";
import { parseWolfxEew, wolfxIntensityToScale } from "../src/convert/wolfx.js";
import { parseP2pTime } from "../src/util.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));
}

describe("intensity conversion", () => {
  test("maps Wolfx intensity labels to P2P scale codes", () => {
    assert.equal(wolfxIntensityToScale("1"), 10);
    assert.equal(wolfxIntensityToScale("5弱"), 45);
    assert.equal(wolfxIntensityToScale("5強"), 50);
    assert.equal(wolfxIntensityToScale("6弱"), 55);
    assert.equal(wolfxIntensityToScale("7"), 70);
    assert.equal(wolfxIntensityToScale("不明"), -1);
    assert.equal(wolfxIntensityToScale(null), -1);
  });
});

describe("Wolfx EEW conversion", () => {
  test("converts a real fixture (Ishigaki) keeping Serial / EventID / isWarn", () => {
    const now = parseP2pTime("2026/11/22 17:44:00")!;
    const eew = parseWolfxEew(fixture("wolfx-eew-ishigaki.json"), { now });
    assert.ok(eew);
    assert.equal(eew.isWarn, false);
    assert.equal(eew.serial, 4);
    assert.equal(eew.eventId, "20261122174303");
    assert.equal(eew.estScale, 10);
    assert.equal(eew.hypocenter, "石垣島近海");
    assert.equal(eew.baseKey, "eew-id:20261122174303");
  });

  test("a warning report carries per-area scales and arrival estimates", () => {
    const now = parseP2pTime("2026/11/22 17:44:00")!;
    const eew = parseWolfxEew(fixture("wolfx-eew-warn.json"), { now });
    assert.ok(eew);
    assert.equal(eew.isWarn, true);
    assert.equal(eew.estScale, 30);
    assert.deepEqual(eew.prefs, ["沖縄県"]);
    assert.ok(eew.areaScales.some((a) => a.name === "沖縄県八重山地方" && a.scale === 30));
    assert.ok(eew.areaArrivals.some((a) => a.pref === "沖縄県" && a.arrivalTime === "2026/11/22 17:44:10"));
  });

  test("stale reports (over 5 minutes) and training reports are rejected", () => {
    const stale = parseP2pTime("2026/11/22 17:50:00")!;
    assert.equal(parseWolfxEew(fixture("wolfx-eew-ishigaki.json"), { now: stale }), null);
    const training = { ...(fixture("wolfx-eew-ishigaki.json") as Record<string, unknown>), isTraining: true };
    const now = parseP2pTime("2026/11/22 17:44:00")!;
    assert.equal(parseWolfxEew(training, { now }), null);
  });

  test("isFinal is kept and Wolfx area scales never carry scaleTo", () => {
    const now = parseP2pTime("2026/11/22 17:44:00")!;
    const eew = parseWolfxEew(fixture("wolfx-eew-ishigaki.json"), { now });
    assert.ok(eew);
    assert.equal(eew.isFinal, true); // 📌 フィクスチャは isFinal=true の実電文
    const warn = parseWolfxEew(fixture("wolfx-eew-warn.json"), { now });
    assert.ok(warn);
    assert.equal(warn.isFinal, false);
    // 📌 Wolfx 由来の areaScales は上限の概念を持たないため scaleTo は null
    assert.ok(warn.areaScales.length > 0 && warn.areaScales.every((a) => a.scaleTo === null));
    const km = parseWolfxEew(fixture("wolfx-eew-kumamoto.json"), { now: parseP2pTime("2026/11/19 02:24:00")! });
    assert.ok(km);
    assert.equal(km.isFinal, false); // 📌 isFinal キーが無い電文は false
  });

  test("a final report without WarnArea converts with empty area fields", () => {
    // 📌 2026-11-26 朝の実イベント (熊本県天草・芦北地方 M2.9) の最終報
    // そのもの。Wolfx の最終報は WarnArea を含まないため、変換結果の
    // 地域情報は空になる。これは変換の欠落ではなく電文側の性質で、
    // 途中報の地域情報を最終報で消さないのはストアの統合の領分
    const now = parseP2pTime("2026/11/26 08:58:00")!;
    const eew = parseWolfxEew(fixture("wolfx-eew-kumamoto-20261126-final.json"), { now });
    assert.ok(eew);
    assert.equal(eew.isFinal, true);
    assert.equal(eew.serial, 4);
    assert.equal(eew.eventId, "20261126085642");
    assert.deepEqual(eew.areaScales, []);
    assert.deepEqual(eew.areaArrivals, []);
    assert.deepEqual(eew.prefs, []);
  });
});

describe("cross-route identity", () => {
  test("the same EEW gets the same baseKey from P2P 556 and Wolfx", () => {
    const fromP2p = parseEews(fixture("p2p-556.json")).find((e) => e.serial === 1);
    const now = parseP2pTime("2026/11/19 02:24:00")!;
    const fromWolfx = parseWolfxEew(fixture("wolfx-eew-kumamoto.json"), { now });
    assert.ok(fromP2p && fromWolfx);
    assert.equal(fromWolfx.baseKey, fromP2p.baseKey);
    // 📳 推定最大震度も経路によらず一致する (556 の scaleFrom 最大値 = Wolfx の MaxIntensity)
    assert.equal(fromWolfx.estScale, fromP2p.estScale);
    assert.equal(fromWolfx.isWarn, false); // Wolfx 側は予報として届いた時点の状態
    assert.equal(fromP2p.isWarn, true); // 556 由来は常に警報
  });
});
