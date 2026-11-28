// ==========================================
// 🧪 テスト: 熱中症警戒アラートの変換 (環境省 WBGT)
// ==========================================
// 📌 フィクスチャ wbgt-alert-20260815-17.csv は 2026/08/15 17時発表分の
// 実ファイル (UTF-8)。この回は 京都府 (当日フラグ1)・和歌山県 (当日1・
// 翌日1)・八重山地方 (当日1・翌日1) の3区域に発表があった。
// 📌 候補 URL の検証は基準時刻を引数で固定する (実時計に依存しない)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { heatLevelName, parseWbgtAlertCsv, wbgtCandidateUrls } from "../src/convert/wbgt.js";
import { EventStore } from "../src/store.js";
import type { HeatEvent } from "../src/types.js";

function fixtureText(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8");
}

const CSV = fixtureText("wbgt-alert-20260815-17.csv");

describe("heat level names", () => {
  test("names levels 0-3", () => {
    assert.equal(heatLevelName(0), "発表なし");
    assert.equal(heatLevelName(1), "熱中症警戒アラート");
    assert.equal(heatLevelName(2), "熱中症特別警戒アラート判定");
    assert.equal(heatLevelName(3), "熱中症特別警戒アラート");
  });
});

describe("CSV conversion", () => {
  test("parses the CSV and drafts only the areas under alert (real fixture)", () => {
    const drafts = parseWbgtAlertCsv(CSV);
    assert.equal(drafts.length, 3);
    const kyoto = drafts.find((d) => d.areaCode === "260000");
    assert.ok(kyoto);
    assert.equal(kyoto.key, "heat:260000");
    assert.equal(kyoto.areaName, "京都府");
    assert.equal(kyoto.prefName, "京都");
    assert.equal(kyoto.level, 1);
    assert.equal(kyoto.levelName, "熱中症警戒アラート");
    assert.deepEqual(kyoto.target1, { date: "2026/08/15", flag: 1 });
    assert.deepEqual(kyoto.target2, { date: "2026/08/16", flag: 0 });
    assert.equal(kyoto.reportDate, "2026/08/15");
    assert.equal(kyoto.reportTime, "17:00:00");
    assert.equal(kyoto.reportDatetime, "2026-08-15T17:00:00+09:00");
    assert.equal(kyoto.time, kyoto.reportDatetime);
    // 🌡️ 和歌山県の日最高 WBGT は 17時列の友ケ島 33 が最大
    const wakayama = drafts.find((d) => d.areaCode === "300000");
    assert.ok(wakayama);
    assert.equal(wakayama.level, 1);
    assert.deepEqual(wakayama.target2, { date: "2026/08/16", flag: 1 });
    assert.equal(wakayama.maxWbgt, 33);
    assert.equal(wakayama.maxWbgtStation, "友ケ島");
  });

  test("candidate URLs are today's newest first, then yesterday's", () => {
    const urls = wbgtCandidateUrls(new Date("2026-08-15T08:00:00Z")); // JST 17:00
    assert.equal(urls.length, 8);
    assert.ok(urls[0].endsWith("/2026/alert_20260815_17.csv"));
    assert.ok(urls[1].endsWith("/2026/alert_20260815_14.csv"));
    assert.ok(urls[4].endsWith("/2026/alert_20260814_17.csv"));
  });
});

describe("snapshot flow in the store", () => {
  test("announce → release is a diff through applyHeatSnapshot", () => {
    const store = new EventStore({ maxAgeHours: 24 * 365 });
    const drafts = parseWbgtAlertCsv(CSV);
    const r1 = store.applyHeatSnapshot(drafts);
    assert.equal(r1.length, 3);
    assert.ok(r1.every((r) => r.change === "new"));
    assert.equal(store.counts().heat, 3);
    // 📌 同じ内容の再適用では変化なし
    assert.deepEqual(store.applyHeatSnapshot(drafts), []);
    // 📌 空のスナップショット (ファイルは取得できたが発表ゼロ) は全解除になる
    const r2 = store.applyHeatSnapshot([]);
    assert.equal(r2.length, 3);
    assert.ok(
      r2.every((r) => {
        const ev = r.event as HeatEvent;
        return ev.released && ev.level === 0 && ev.levelName === "発表なし";
      }),
    );
    assert.equal(store.counts().heat, 0);
  });
});
