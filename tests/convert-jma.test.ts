// ==========================================
// 🧪 テスト: 気象庁 (警報・注意報 / 台風) の変換
// ==========================================
// 📌 変換は純粋関数のため時計固定は不要。区域名は area.json
// フィクスチャを parseClass10Names で対応表にして解決関数として渡す
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  ALL_OFFICE_CODES,
  buildWarningUrl,
  dropContainedParts,
  OFFICE_PREF_NAMES,
  parseClass10Names,
  parseTyphoons,
  parseWarningOffice,
  typhoonLines,
  warningSeverity,
} from "../src/convert/jma.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));
}

describe("office codes", () => {
  test("all 58 codes reverse-map to prefecture names", () => {
    assert.equal(ALL_OFFICE_CODES.length, 58);
    assert.equal(new Set(ALL_OFFICE_CODES).size, 58);
    assert.equal(OFFICE_PREF_NAMES.get("130000"), "東京都");
    assert.equal(OFFICE_PREF_NAMES.get("011000"), "北海道");
    assert.equal(OFFICE_PREF_NAMES.get("460040"), "鹿児島県");
    assert.equal(OFFICE_PREF_NAMES.get("474000"), "沖縄県");
    assert.equal(buildWarningUrl("130000"), "https://www.jma.go.jp/bosai/warning/data/warning/130000.json");
  });
});

describe("warning severity", () => {
  test("special warning = 4 / warning = 3 / advisory = 2", () => {
    assert.equal(warningSeverity("33", "大雨特別警報"), 4);
    assert.equal(warningSeverity("03", "大雨警報"), 3);
    assert.equal(warningSeverity("14", "雷注意報"), 2);
    // 📌 コード表に無いコードは名称の末尾で判定する (「その他の警報・注意報」は注意報側)
    assert.equal(warningSeverity("99", "その他の警報・注意報（コード99）"), 2);
  });
});

describe("warning conversion", () => {
  test("one draft per primary area with the exclusion and ordering rules", () => {
    const names = parseClass10Names(fixture("jma-area.json"));
    const drafts = parseWarningOffice(fixture("jma-warning-130000.json"), "130000", (c) => names.get(c));
    // 📌 解除のみ (130020) と「発表警報・注意報はなし」のみ (130030) の区域は含まれない。
    // areaTypes[1] の大雨特別警報 (コード33) も対象外 (一次細分区域は [0] のみ)
    assert.equal(drafts.length, 2);

    const tokyo = drafts.find((d) => d.areaCode === "130010")!;
    assert.equal(tokyo.kind, "warning");
    assert.equal(tokyo.key, "warning:130000:130010");
    assert.equal(tokyo.officeCode, "130000");
    assert.equal(tokyo.prefName, "東京都");
    assert.equal(tokyo.areaName, "東京地方"); // area.json の class10s から解決
    assert.equal(tokyo.reportDatetime, "2026-05-28T10:16:00+09:00");
    assert.equal(tokyo.time, tokyo.reportDatetime);
    assert.equal(tokyo.headline, "東京都では、雷注意報が発表されています。");
    assert.equal(tokyo.released, false);
    // 📌 重複排除: 雷注意報は2エントリ (継続/発表) が名称で1件にまとまる。
    // 整列: 重要度降順 → 名称順。コード表に無い 99 は落とさず名称付きで残る
    assert.deepEqual(
      tokyo.warnings.map((w) => w.name),
      ["大雨警報", "その他の警報・注意報（コード99）", "雷注意報"],
    );
    const thunder = tokyo.warnings.find((w) => w.code === "14")!;
    assert.equal(thunder.status, "継続"); // 先勝ち (同重要度では最初のエントリ)
    assert.equal(tokyo.maxSeverity, 3);

    // 📌 status が空のエントリは継続中として扱い、区域が残る
    const ogasawara = drafts.find((d) => d.areaCode === "130040")!;
    assert.equal(ogasawara.areaName, "小笠原諸島");
    assert.deepEqual(ogasawara.warnings.map((w) => w.name), ["乾燥注意報"]);
  });

  test("unresolvable area names fall back to a code label", () => {
    const drafts = parseWarningOffice(fixture("jma-warning-130000.json"), "130000");
    assert.ok(drafts.length >= 1);
    assert.equal(drafts[0].areaName, "区域 130010");
    // 📌 不正な入力では空配列
    assert.deepEqual(parseWarningOffice(null, "130000"), []);
    assert.deepEqual(parseWarningOffice({}, "130000"), []);
  });
});

describe("area.json parsing", () => {
  test("extracts area names from class10s", () => {
    const names = parseClass10Names(fixture("jma-area.json"));
    assert.equal(names.get("130010"), "東京地方");
    assert.equal(names.get("130040"), "小笠原諸島");
    assert.equal(parseClass10Names(null).size, 0);
    assert.equal(parseClass10Names({ class10s: { x: { enName: "NoName" } } }).size, 0);
  });
});

describe("typhoon conversion", () => {
  test("one draft per typhoon with number and name keys", () => {
    const drafts = parseTyphoons(fixture("jma-typhoon.json"));
    assert.equal(drafts.length, 2);
    const t10 = drafts[0];
    assert.equal(t10.kind, "typhoon");
    assert.equal(t10.number, "10");
    assert.equal(t10.name, "台風第10号");
    assert.equal(t10.englishName, "SANBA");
    assert.equal(t10.key, "typhoon:10");
    // 📌 号数 "10" は台風名に含まれるため表示行では重複排除される
    assert.deepEqual(t10.lines, ["・台風第10号"]);
    // 📦 スカラー値は fields として落とさず保持する
    assert.equal(t10.fields.pressure, 985);
    assert.equal(t10.fields.maxWindSpeed, 35);
    assert.equal(t10.fields.position, "北緯20.5度 東経130.0度付近");
    assert.equal(t10.fields.englishName, "SANBA");

    const td = drafts[1];
    assert.equal(td.number, null); // 番号が取れない場合は名称ベースのキー
    assert.equal(td.key, "typhoon:熱帯低気圧a");
    assert.equal(td.fields.centerPressure, 1002);
  });

  test("no typhoons (empty or invalid input) yields an empty array", () => {
    assert.deepEqual(parseTyphoons([]), []);
    assert.deepEqual(parseTyphoons(null), []);
    assert.deepEqual(parseTyphoons([{}]), []); // lines が作れなければ台風なし
    assert.deepEqual(typhoonLines([]), []);
    assert.deepEqual(dropContainedParts(["台風第10号", "10", "SANBA"]), ["台風第10号", "SANBA"]);
  });
});
