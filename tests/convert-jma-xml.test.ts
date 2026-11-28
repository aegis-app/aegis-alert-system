// ==========================================
// 🧪 テスト: 気象庁防災情報XML の変換 (フィード分類・電文)
// ==========================================
// 📌 フィクスチャの出典: 土砂 (VXWW50) / 竜巻 (VPHW50・51) / 火山
// (VFVO51・52・53) / 府県気象情報 (VPFJ50) と Atom フィードの entry は
// 2026-11-26 に実際のフィードから取得した実物。洪水 (VXKO) / 記録的
// 短時間大雨 (VPOA50) / 顕著な大雨 (VPFJ50) は調査時点でフィード内に
// 実物が無かったため、気象庁の公開フォーマット仕様 (洪水予報 XML の
// 解説 / 技術情報第501号 別紙) と同系統の実電文に基づく代替
// フィクスチャ (各ファイル冒頭のコメント参照)。
// 📌 変換は純粋関数のため時計固定は不要。ストアへ流す検証では、
// 竜巻フィクスチャの発表日時 (2026-11-24) が保持期間ガード (72時間)
// に掛からないよう、モックタイマーで時計を電文直後に固定する
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  classifyDataCode,
  floodSeverity,
  parseFeedEntries,
  parseFloodTelegram,
  parseLinearRainTelegram,
  parseRecordRainTelegram,
  parseSedimentTelegram,
  parseTornadoTelegram,
  parseVolcanoTelegram,
} from "../src/convert/jma-xml.js";
import { EventStore } from "../src/store.js";
import type { SedimentEvent } from "../src/types.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8");
}

describe("feed parsing and classification", () => {
  test("extracts ids, urls and data codes from real entries", () => {
    const entries = parseFeedEntries(fixture("jma-xml-feed.xml"));
    assert.equal(entries.length, 6);
    assert.deepEqual(
      entries.map((e) => e.code),
      ["VXWW50", "VPHW50", "VPHW51", "VFVO53", "VPFJ50", "VPWW53"],
    );
    assert.ok(entries.every((e) => e.id === e.url)); // 気象庁フィードでは id = 電文 URL
  });

  test("only target codes are classified into domains", () => {
    assert.equal(classifyDataCode("VXKO50"), "flood");
    assert.equal(classifyDataCode("VXKO89"), "flood");
    assert.equal(classifyDataCode("VXKO90"), null); // ii=50-89 の範囲外
    assert.equal(classifyDataCode("VXKO49"), null);
    assert.equal(classifyDataCode("VXWW50"), "sediment");
    assert.equal(classifyDataCode("VPHW50"), "tornado");
    assert.equal(classifyDataCode("VPHW51"), "tornado");
    assert.equal(classifyDataCode("VPOA50"), "record-rain");
    assert.equal(classifyDataCode("VPZJ50"), "linear-rain-candidate");
    assert.equal(classifyDataCode("VPCJ50"), "linear-rain-candidate");
    assert.equal(classifyDataCode("VPFJ50"), "linear-rain-candidate");
    assert.equal(classifyDataCode("VFVO50"), "volcano");
    assert.equal(classifyDataCode("VFVO56"), "volcano");
    assert.equal(classifyDataCode("VFVO60"), "volcano");
    assert.equal(classifyDataCode("VPWW53"), null); // 警報 XML は bosai JSON が正のため対象外
    assert.equal(classifyDataCode("VXSE53"), null);
    assert.equal(classifyDataCode(""), null);
  });
});

describe("flood telegram (VXKO)", () => {
  test("converts category, river, area and station water levels", () => {
    const d = parseFloodTelegram(fixture("jma-xml-vxko-flood.xml"));
    assert.ok(d);
    assert.equal(d.key, "flood:下館河川事務所 水戸地方気象台:小貝川:小貝川");
    assert.equal(d.river, "小貝川");
    assert.equal(d.area, "小貝川");
    assert.equal(d.category, "氾濫警戒情報");
    assert.equal(d.categoryCode, "30");
    assert.equal(d.severity, 3);
    assert.equal(d.cancelled, false);
    assert.equal(d.time, "2026-08-29T09:10:00+09:00"); // ISO 8601 原表記を保持
    assert.equal(d.title, "小貝川氾濫警戒情報");
    assert.ok(d.headline.includes("氾濫危険水位"));
    assert.ok(d.text.includes("警戒レベル３相当"));
    assert.deepEqual(d.stations, [{ name: "三谷", waterLevel: "4.20", condition: "上昇" }]);
  });

  test("a release telegram is cancelled and severity comes from the code table", () => {
    const releasedXml = fixture("jma-xml-vxko-flood.xml")
      .replaceAll("氾濫警戒情報", "氾濫注意情報解除")
      .replaceAll("<Code>30</Code>", "<Code>10</Code>");
    const d = parseFloodTelegram(releasedXml);
    assert.ok(d);
    assert.equal(d.cancelled, true);
    assert.equal(d.severity, 0);
    assert.equal(floodSeverity("51", "氾濫発生情報"), 5);
    assert.equal(floodSeverity("40", "氾濫危険情報"), 4);
    assert.equal(floodSeverity("21", "氾濫注意情報"), 2);
    assert.equal(floodSeverity("10", "氾濫注意情報解除"), 0);
  });
});

describe("sediment telegram (VXWW50)", () => {
  test("extracts only the alerting cities as the complete active set", () => {
    const s = parseSedimentTelegram(fixture("jma-xml-vxww50-sediment.xml"));
    assert.ok(s);
    assert.equal(s.prefName, "新潟県");
    // 📌 実電文 Body は県内全30市町村を列挙し、警戒は3市町村のみ
    assert.deepEqual(
      s.drafts.map((d) => d.cityName).sort(),
      ["上越市", "刈羽村", "柏崎市"],
    );
    assert.equal(s.drafts[0].key, "sediment:新潟県:柏崎市");
    assert.equal(s.drafts[0].released, false);
    assert.equal(s.drafts[0].time, "2026-11-21T19:42:00+09:00");
  });

  test("a full-release telegram returns the scope with zero drafts", () => {
    const s = parseSedimentTelegram(fixture("jma-xml-vxww50-sediment-release.xml"));
    assert.ok(s);
    assert.equal(s.prefName, "新潟県");
    assert.deepEqual(s.drafts, []);
  });

  test("announce → no change → full release flows through the store snapshot", () => {
    const store = new EventStore();
    const announce = parseSedimentTelegram(fixture("jma-xml-vxww50-sediment.xml"));
    assert.ok(announce);
    const r1 = store.applySedimentSnapshot(announce.drafts, [announce.prefName]);
    assert.equal(r1.length, 3);
    assert.ok(r1.every((r) => r.change === "new"));
    assert.equal(store.counts().sediment, 3);

    // 📌 同じ集合では何も返らない
    assert.deepEqual(store.applySedimentSnapshot(announce.drafts, [announce.prefName]), []);

    // 📌 取得に失敗した都道府県は差分の対象外 (前回状態を保持)
    assert.deepEqual(store.applySedimentSnapshot([], ["東京都"]), []);
    assert.equal(store.counts().sediment, 3);

    // 📌 全解除: 3件とも released: true の配信専用イベントになり、ストアから除かれる
    const release = parseSedimentTelegram(fixture("jma-xml-vxww50-sediment-release.xml"));
    assert.ok(release);
    const r2 = store.applySedimentSnapshot(release.drafts, [release.prefName]);
    assert.equal(r2.length, 3);
    assert.ok(r2.every((r) => (r.event as SedimentEvent).released === true));
    assert.equal(store.counts().sediment, 0);
    // 📌 解除イベントは保存されないため再び出ない
    assert.deepEqual(store.applySedimentSnapshot(release.drafts, [release.prefName]), []);
  });
});

describe("tornado telegram (VPHW50 / VPHW51)", () => {
  test("both codes merge into one key and witnessed is distinguished", () => {
    const d50 = parseTornadoTelegram(fixture("jma-xml-vphw50-tornado.xml"), "VPHW50");
    const d51 = parseTornadoTelegram(fixture("jma-xml-vphw51-tornado.xml"), "VPHW51");
    assert.ok(d50 && d51);
    assert.equal(d50.key, "tornado:気象庁本庁:2026-11-24T18:03:00+09:00");
    assert.equal(d51.key, d50.key);
    assert.equal(d50.witnessed, false);
    assert.equal(d51.witnessed, true);
    assert.deepEqual(d50.areas, ["伊豆諸島南部"]);
    assert.equal(d50.validUntil, "2026-11-24T19:10:00+09:00");
  });

  test("the converted draft ingests into the store with the clock pinned", (t) => {
    // 🕐 フィクスチャの発表は 2026-11-24 18:03 JST。実時計では保持期間
    // (72時間) を超えてガードに落ちるため、時計を電文直後に固定する
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-24T18:10:00+09:00") });
    const store = new EventStore();
    const d = parseTornadoTelegram(fixture("jma-xml-vphw50-tornado.xml"), "VPHW50");
    assert.ok(d);
    const r = store.ingest(d, "jma-xml");
    assert.equal(r.change, "new");
    assert.equal(store.counts().tornado, 1);
  });
});

describe("record-rain telegram (VPOA50)", () => {
  test("extracts station, amount and analysis type from the headline", () => {
    const d = parseRecordRainTelegram(fixture("jma-xml-vpoa50-record-rain.xml"));
    assert.ok(d);
    assert.equal(d.key, "record-rain:金沢地方気象台:2018-10-19T10:00:00+09:00");
    assert.deepEqual(d.areas, ["能登"]);
    assert.equal(d.station, "珠洲市付近");
    assert.equal(d.rainfallMm, 100); // 全角数字を半角化して数値にする
    assert.equal(d.rainfallLabel, "約１００ミリ");
    assert.equal(d.rainfallType, "analysis"); // 「付近で約」は解析雨量
  });
});

describe("linear-rain (significant heavy rain)", () => {
  test("only the significant-heavy-rain bulletins convert; ordinary ones do not", () => {
    const d = parseLinearRainTelegram(fixture("jma-xml-vpfj50-linear-rain.xml"));
    assert.ok(d);
    assert.equal(d.key, "linear-rain:福岡管区気象台:2026-07-10T11:35:00+09:00");
    assert.equal(d.title, "顕著な大雨に関する福岡県気象情報");
    assert.ok(d.text.includes("線状降水帯"));
    // 📌 実物の通常の府県気象情報 (顕著な大雨ではない) は null
    assert.equal(parseLinearRainTelegram(fixture("jma-xml-vpfj50-weather.xml")), null);
  });
});

describe("volcano telegrams (VFVO)", () => {
  test("an ashfall forecast (real telegram) yields name, level and target cities", () => {
    const d = parseVolcanoTelegram(fixture("jma-xml-vfvo53-volcano.xml"), "VFVO53");
    assert.ok(d);
    assert.equal(d.key, "volcano:霧島山（新燃岳）:降灰予報:2026-11-26T11:00:00+09:00");
    assert.equal(d.category, "降灰予報");
    assert.equal(d.level, 2);
    assert.equal(d.levelName, "火口周辺規制");
    assert.ok(d.areas.includes("宮崎県都城市"));
    assert.ok(d.areas.length >= 20);
  });

  test("a commentary telegram is level 3 and an observation report has no level", () => {
    const d51 = parseVolcanoTelegram(fixture("jma-xml-vfvo51-volcano.xml"), "VFVO51");
    assert.ok(d51);
    assert.equal(d51.volcanoName, "桜島");
    assert.equal(d51.category, "解説情報");
    assert.equal(d51.level, 3);
    assert.equal(d51.levelName, "入山規制");
    const d52 = parseVolcanoTelegram(fixture("jma-xml-vfvo52-volcano.xml"), "VFVO52");
    assert.ok(d52);
    assert.equal(d52.category, "観測報");
    assert.equal(d52.level, null);
    assert.ok(d52.headline.includes("噴火"));
  });
});
