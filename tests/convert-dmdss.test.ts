// ==========================================
// 🧪 テスト: DMDSS (dmdata.jp) の電文変換と経路間の同一視
// ==========================================
// 📌 フィクスチャは気象庁防災情報XMLの公式フォーマット仕様に基づく
// 合成電文で、P2P / Wolfx の実フィクスチャと同一イベントにそろえてある。
// DMDSS 経由の実電文での検証は残タスク。
// 📌 ストアへ流す検証は、フィクスチャの発表日時が保持期間ガードに
// 掛からないよう、モックタイマーで時計を固定したうえで保持期間を
// 大きく取る (実時計に依存しない)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import {
  decodeDmdssBody,
  parseDmdssEew,
  parseDmdssTsunami,
  tsunamiKindFromComment,
  DmdssQuakeAccumulator,
  type DmdssDataMessage,
} from "../src/convert/dmdss.js";
import { parseQuakes, parseTsunamis } from "../src/convert/p2p.js";
import { parseWolfxEew } from "../src/convert/wolfx.js";
import { EventStore } from "../src/store.js";
import { parseP2pTime } from "../src/util.js";
import type { QuakeDraft } from "../src/types.js";

function fixtureText(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8");
}
function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

// 🕐 ストア検証用の固定時計 (フィクスチャ群の直後)
function pinClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-28T00:00:00+09:00") });
}

describe("envelope decoding", () => {
  test("restores gzip + base64 bodies to XML", () => {
    const xml = fixtureText("dmdss-vxse45-eew.xml");
    const msg: DmdssDataMessage = {
      type: "data",
      classification: "eew.forecast",
      head: { type: "VXSE45" },
      format: "xml",
      compression: "gzip",
      encoding: "base64",
      body: gzipSync(Buffer.from(xml, "utf-8")).toString("base64"),
    };
    assert.equal(decodeDmdssBody(msg), xml);
  });

  test("restores uncompressed utf-8 bodies", () => {
    const xml = fixtureText("dmdss-vtse41-tsunami.xml");
    const msg: DmdssDataMessage = {
      type: "data",
      format: "xml",
      compression: null,
      encoding: "utf-8",
      body: xml,
    };
    assert.equal(decodeDmdssBody(msg), xml);
  });

  test("zip compression and non-XML formats are skipped as null", () => {
    assert.equal(
      decodeDmdssBody({ type: "data", format: "xml", compression: "zip", encoding: "base64", body: "AAAA" }),
      null,
    );
    assert.equal(
      decodeDmdssBody({ type: "data", format: "a/n", compression: null, encoding: "utf-8", body: "text" }),
      null,
    );
    assert.equal(decodeDmdssBody({ type: "data", format: "xml", body: undefined }), null);
  });
});

describe("EEW conversion", () => {
  test("VXSE45 (forecast) converts with a baseKey matching Wolfx", () => {
    const draft = parseDmdssEew(fixtureText("dmdss-vxse45-eew.xml"), "VXSE45");
    assert.ok(draft);
    assert.equal(draft.kind, "eew");
    // 📌 同一視キーは JMA イベント ID ベースで、Wolfx / P2P 556 と一致する
    assert.equal(draft.baseKey, "eew-id:20261126085642");
    assert.equal(draft.key, "eew-id:20261126085642");
    assert.equal(draft.eventId, "20261126085642");
    assert.equal(draft.serial, 4);
    assert.equal(draft.time, "2026/11/26 08:57:19");
    assert.equal(draft.originTime, "2026/11/26 08:56:40");
    assert.equal(draft.hypocenter, "熊本県天草・芦北地方");
    assert.equal(draft.lat, 32.3);
    assert.equal(draft.lon, 130.5);
    assert.equal(draft.depthKm, 10);
    assert.equal(draft.estMagnitude, 2.9);
    assert.equal(draft.estScale, 30);
    assert.equal(draft.isWarn, false);
    assert.equal(draft.cancel, false);
    assert.deepEqual(draft.prefs, ["熊本県", "鹿児島県"]);
    assert.deepEqual(draft.areaArrivals, [
      { pref: "熊本県", arrivalTime: "2026/11/26 08:57:10" },
      { pref: "鹿児島県", arrivalTime: "2026/11/26 08:58:10" },
    ]);
    assert.deepEqual(draft.areaScales, [
      { pref: "熊本県", name: "熊本県熊本地方", scale: 30, scaleTo: 30 },
      { pref: "熊本県", name: "熊本県天草・芦北地方", scale: 30, scaleTo: 40 },
      { pref: "鹿児島県", name: "鹿児島県薩摩地方", scale: 20, scaleTo: 30 },
    ]);
  });

  test("VXSE43 (warning) sets isWarn and converts intensity labels", () => {
    const draft = parseDmdssEew(fixtureText("dmdss-vxse43-eew.xml"), "VXSE43");
    assert.ok(draft);
    assert.equal(draft.isWarn, true);
    assert.equal(draft.estScale, 70);
    assert.equal(draft.depthKm, 15);
    assert.deepEqual(draft.areaScales, [
      { pref: "石川県", name: "石川県能登", scale: 70, scaleTo: 70 },
      { pref: "新潟県", name: "新潟県上越", scale: 50, scaleTo: 55 },
    ]);
  });

  test("cancellations convert as cancel; training telegrams are rejected", () => {
    const cancelXml = fixtureText("dmdss-vxse45-eew.xml").replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>");
    const cancel = parseDmdssEew(cancelXml, "VXSE45");
    assert.ok(cancel);
    assert.equal(cancel.cancel, true);
    assert.equal(cancel.key, "eew-id:20261126085642-cancel");
    assert.equal(cancel.baseKey, "eew-id:20261126085642");
    const trainingXml = fixtureText("dmdss-vxse45-eew.xml").replace("<Status>通常</Status>", "<Status>訓練</Status>");
    assert.equal(parseDmdssEew(trainingXml, "VXSE45"), null);
  });
});

describe("quake conversion and accumulation", () => {
  test("VXSE51 → VXSE52 → VXSE53 accumulate into one quake by EventID", () => {
    const acc = new DmdssQuakeAccumulator();
    const d1 = acc.ingest(fixtureText("dmdss-vxse51-quake.xml"), "VXSE51");
    assert.ok(d1);
    // 📌 震度速報だけの段階: 発生時刻は EventID から復元し、キーは震源名側
    assert.equal(d1.issueType, "ScalePrompt");
    assert.equal(d1.key, "551:2026/11/19 06:41:00|不明");
    assert.equal(d1.maxScale, 20);
    assert.equal(d1.points.length, 1);
    assert.equal(d1.points[0]!.isArea, true);

    const d2 = acc.ingest(fixtureText("dmdss-vxse52-quake.xml"), "VXSE52");
    assert.ok(d2);
    assert.equal(d2.key, "551:2026/11/19 06:41:00|@32.3,130.4");
    assert.equal(d2.hypocenter, "熊本県天草・芦北地方");
    assert.equal(d2.magnitude, 2.8);
    assert.equal(d2.tsunamiKind, "None");

    const d3 = acc.ingest(fixtureText("dmdss-vxse53-quake.xml"), "VXSE53");
    assert.ok(d3);
    assert.equal(d3.issueType, "DetailScale");
    assert.equal(d3.key, "551:2026/11/19 06:41:00|@32.3,130.4");
    assert.equal(d3.time, "2026/11/19 06:41:00");
    assert.equal(d3.announcedTime, "2026/11/19 06:44:00");
    assert.equal(d3.originTime, null); // 📌 国内地震は P2P と同じく null
    assert.equal(d3.telegramId, "20261119064100");
    assert.equal(d3.depthKm, 10);
    assert.equal(d3.maxScale, 20);
    assert.equal(d3.topPoint, "球磨村渡");
    assert.equal(d3.topPointIsArea, false);
    assert.deepEqual(d3.prefScales, [{ pref: "熊本県", scale: 20 }]);
    const names = d3.points.map((p) => `${p.name}:${p.scale}:${p.isArea ? "a" : "s"}`).sort();
    assert.deepEqual(names, [
      "水俣市牧ノ内:10:s",
      "水俣市陣内:10:s",
      "熊本県天草・芦北:20:a",
      "球磨村渡:20:s",
    ]);
  });

  test("the tsunami outlook is judged from the ForecastComment stock phrases", () => {
    assert.equal(tsunamiKindFromComment("この地震による津波の心配はありません。"), "None");
    assert.equal(
      tsunamiKindFromComment("この地震により、日本の沿岸では若干の海面変動があるかもしれませんが、被害の心配はありません。"),
      "Forecast",
    );
    assert.equal(tsunamiKindFromComment("津波警報等を発表しています。"), "Warning");
    assert.equal(tsunamiKindFromComment("津波注意報を発表しました。"), "Advisory");
    assert.equal(tsunamiKindFromComment("現在、津波の到達状況を調査中です。"), "Checking");
    assert.equal(tsunamiKindFromComment(""), "Unknown");
  });
});

describe("tsunami conversion", () => {
  test("VTSE41 converts into the common tsunami format", () => {
    const draft = parseDmdssTsunami(fixtureText("dmdss-vtse41-tsunami.xml"));
    assert.ok(draft);
    assert.equal(draft.key, "552:2026/11/19 06:44:00");
    assert.equal(draft.time, "2026/11/19 06:44:00");
    assert.equal(draft.grade, "Watch");
    assert.equal(draft.cancelled, false);
    assert.deepEqual(draft.areas, [
      {
        name: "宮崎県沿岸",
        grade: "Watch",
        arrivalLabel: "07:10",
        firstHeightCondition: null,
        maxHeightLabel: "1m",
        maxHeightValue: 1,
      },
      {
        name: "鹿児島県東部",
        grade: "Watch",
        arrivalLabel: "07:20",
        firstHeightCondition: "第1波の到達を確認",
        maxHeightLabel: "1m",
        maxHeightValue: 1,
      },
    ]);
  });
});

describe("cross-route identity in the store", () => {
  test("an EEW from Wolfx and DMDSS merges into one event", (t) => {
    pinClock(t);
    const store = new EventStore({ maxAgeHours: 24 * 365 });
    const wolfx = parseWolfxEew(fixtureJson("wolfx-eew-kumamoto-20261126-final.json"), {
      now: parseP2pTime("2026/11/26 08:58:00")!,
    });
    assert.ok(wolfx);
    const dmdss = parseDmdssEew(fixtureText("dmdss-vxse45-eew.xml"), "VXSE45");
    assert.ok(dmdss);
    store.ingest(wolfx, "wolfx-ws");
    const merged = store.ingest(dmdss, "dmdss");
    assert.equal(store.counts().eew, 1);
    assert.deepEqual([...merged.event.sources].sort(), ["dmdss", "wolfx-ws"]);
  });

  test("a quake from P2P and DMDSS merges into one event", (t) => {
    pinClock(t);
    const store = new EventStore({ maxAgeHours: 24 * 365 });
    const p2p = parseQuakes(fixtureJson("p2p-551.json")).find(
      (q) => q.key === "551:2026/11/19 06:41:00|@32.3,130.4",
    ) as QuakeDraft | undefined;
    assert.ok(p2p, "P2P フィクスチャに対象地震があること");
    const acc = new DmdssQuakeAccumulator();
    acc.ingest(fixtureText("dmdss-vxse51-quake.xml"), "VXSE51");
    const dmdss = acc.ingest(fixtureText("dmdss-vxse53-quake.xml"), "VXSE53");
    assert.ok(dmdss);
    assert.equal(dmdss.key, p2p.key);
    store.ingest(p2p, "p2p");
    const merged = store.ingest(dmdss, "dmdss");
    assert.equal(store.counts().quake, 1);
    assert.deepEqual([...merged.event.sources].sort(), ["dmdss", "p2p"]);
  });

  test("a tsunami merges across routes by time + area name despite different keys", (t) => {
    pinClock(t);
    const p2p = parseTsunamis(fixtureJson("p2p-552.json"))[0];
    assert.ok(p2p);
    assert.equal(p2p.key, "552:synthetic-552-001"); // 📌 P2P のキーは電文 ID
    const dmdss = parseDmdssTsunami(fixtureText("dmdss-vtse41-tsunami.xml"));
    assert.ok(dmdss);
    assert.notEqual(dmdss.key, p2p.key);

    // P2P → DMDSS の順
    const store1 = new EventStore({ maxAgeHours: 24 * 365 });
    store1.ingest(p2p, "p2p");
    store1.ingest(dmdss, "dmdss");
    assert.equal(store1.counts().tsunami, 1);
    const stored1 = store1.snapshot().find((e) => e.kind === "tsunami");
    assert.ok(stored1);
    assert.equal(stored1.key, p2p.key); // 📌 先に届いた側のキーを維持する
    assert.deepEqual([...stored1.sources].sort(), ["dmdss", "p2p"]);

    // DMDSS → P2P の順でも1件 (キーは DMDSS 側になる)
    const store2 = new EventStore({ maxAgeHours: 24 * 365 });
    store2.ingest(dmdss, "dmdss");
    store2.ingest(p2p, "p2p");
    assert.equal(store2.counts().tsunami, 1);
    const stored2 = store2.snapshot().find((e) => e.kind === "tsunami");
    assert.ok(stored2);
    assert.equal(stored2.key, dmdss.key);
    assert.deepEqual([...stored2.sources].sort(), ["dmdss", "p2p"]);

    // 📌 発表時刻が違えば別イベントのまま
    const store3 = new EventStore({ maxAgeHours: 24 * 365 });
    store3.ingest(p2p, "p2p");
    const other = parseDmdssTsunami(
      fixtureText("dmdss-vtse41-tsunami.xml").replaceAll("06:44:00", "07:44:00"),
    );
    assert.ok(other);
    store3.ingest(other, "dmdss");
    assert.equal(store3.counts().tsunami, 2);
  });
});
