// ==========================================
// 🧪 テスト: 河川観測値・ダムの変換 (川の防災情報)
// ==========================================
// 📌 フィクスチャは 2026-11-26 11:20 時点の実データ (多摩川水系):
// - kawabou-rsys-83030000.json: 水系インデックス (水系名・河川名)
// - kawabou-rvrlist-83030001.json: 多摩川 (河川コード 83030001) の観測所マスタ
// - kawabou-tm-rsyslist-83030000.json: 水系全体の現在値 (tmStg/tmRn/tmDam)
// 📌 変換は純粋関数のため時計固定は不要
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  convertRsysTmList,
  kawabouDatePath,
  levelStateFromTm,
  parseRsysIndex,
  parseRvrMaster,
} from "../src/convert/kawabou.js";
import type { DamDraft, RiverDraft } from "../src/types.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf-8"));
}

function tamaDrafts(): { riverDrafts: RiverDraft[]; damDrafts: DamDraft[] } {
  const idx = parseRsysIndex(fixture("kawabou-rsys-83030000.json"));
  const masters = new Map([[83030001, parseRvrMaster(fixture("kawabou-rvrlist-83030001.json"))]]);
  return convertRsysTmList(fixture("kawabou-tm-rsyslist-83030000.json"), {
    systemName: idx.systemName,
    riverNames: idx.riverNames,
    masters,
  });
}

describe("date path", () => {
  test("builds the rsyslist date path from the current observation time (10-minute floor)", () => {
    assert.equal(kawabouDatePath("2026/11/26 11:25"), "20261126/1120/");
    assert.equal(kawabouDatePath("2026/11/26 11:20"), "20261126/1120/");
    assert.equal(kawabouDatePath("2026/11/26 00:09"), "20261126/0000/");
    assert.throws(() => kawabouDatePath("不明"));
  });
});

describe("level state derivation", () => {
  test("derives the state from the exceedance and missing codes", () => {
    assert.deepEqual(levelStateFromTm({ stgCcd: 0, stgOvlvl: 0 }), { levelState: "平常", stateSeverity: 0 });
    assert.deepEqual(levelStateFromTm({ stgCcd: 0, stgOvlvl: 10 }), { levelState: "水防団待機水位超過", stateSeverity: 1 });
    assert.deepEqual(levelStateFromTm({ stgCcd: 0, stgOvlvl: 30 }), { levelState: "氾濫注意水位超過", stateSeverity: 2 });
    assert.deepEqual(levelStateFromTm({ stgCcd: 0, stgOvlvl: 60 }), { levelState: "避難判断水位超過", stateSeverity: 3 });
    assert.deepEqual(levelStateFromTm({ stgCcd: 0, stgOvlvl: 80 }), { levelState: "氾濫危険水位超過", stateSeverity: 4 });
    assert.deepEqual(levelStateFromTm({ stgCcd: 0, stgOvlvl: 90 }), { levelState: "氾濫発生水位超過", stateSeverity: 5 });
    // 📌 欠測コード (128以上) が立っていれば超過コードより欠測を優先する
    assert.deepEqual(levelStateFromTm({ stgCcd: 140, stgOvlvl: 90 }), { levelState: "欠測", stateSeverity: -1 });
    assert.deepEqual(levelStateFromTm({ stgCcd: null, stgOvlvl: 0 }), { levelState: "欠測", stateSeverity: -1 });
  });
});

describe("station master", () => {
  test("extracts thresholds from the river master (Tama river, Chofu bridge)", () => {
    const master = parseRvrMaster(fixture("kawabou-rvrlist-83030001.json"));
    const chofu = master.stg.get("2132000400004");
    assert.equal(chofu?.name, "調布橋");
    assert.deepEqual(chofu?.thresholds, {
      standby: 0.2,
      caution: 1,
      refuge: 1.2,
      danger: 1.6,
      flood: 3.3,
    });
    assert.equal(master.dam.get("0332900700101")?.name, "白丸調整池");
    assert.equal(master.rn.size, 14);
  });
});

describe("current values conversion", () => {
  test("converts a whole river system into level / rain / dam drafts (real fixture)", () => {
    const { riverDrafts, damDrafts } = tamaDrafts();
    // 🌊 水位: 調布橋 (マスタ解決済み)
    const chofu = riverDrafts.find((d) => d.stationCode === "2132000400004");
    assert.ok(chofu);
    assert.equal(chofu.key, "river:level:2132000400004");
    assert.equal(chofu.metric, "level");
    assert.equal(chofu.stationName, "調布橋");
    assert.equal(chofu.riverName, "多摩川");
    assert.equal(chofu.systemName, "多摩川");
    assert.equal(chofu.value, -2.78);
    assert.equal(chofu.observedAt, "2026/11/26 11:20");
    assert.equal(chofu.levelState, "平常");
    assert.equal(chofu.stateSeverity, 0);
    assert.equal(chofu.thresholds.danger, 1.6);
    // 📌 欠測局 (stgCcd=190、値は 0 のプレースホルダ) は値を null にし、欠測として扱う
    const missing = riverDrafts.find((d) => d.stationCode === "2132000400091");
    assert.ok(missing);
    assert.equal(missing.value, null);
    assert.equal(missing.levelState, "欠測");
    assert.equal(missing.stateSeverity, -1);
    // 🌧️ 雨量: 多摩川の雨量観測所は14局、現在値は時間雨量が代表値
    const rains = riverDrafts.filter((d) => d.metric === "rain" && d.riverName === "多摩川");
    assert.equal(rains.length, 14);
    assert.ok(rains.every((d) => d.key.startsWith("river:rain:") && d.levelState === "平常"));
    // 🏞️ ダム: 白丸調整池は全項目が欠測コードのため null になり、放流中にならない
    const shiromaru = damDrafts.find((d) => d.damCode === "0332900700101");
    assert.ok(shiromaru);
    assert.equal(shiromaru.key, "dam:0332900700101");
    assert.equal(shiromaru.name, "白丸調整池");
    assert.equal(shiromaru.storageLevel, null);
    assert.equal(shiromaru.outflow, null);
    assert.equal(shiromaru.discharging, false);
    // 🏞️ ダム: 管内河川のダム (マスタ未解決) はコード由来の名前で落とさず取り込み、
    // 貯水率は有効容量が欠測のため利水容量で代替される
    const ogouchi = damDrafts.find((d) => d.damCode === "2137700700001");
    assert.ok(ogouchi);
    assert.equal(ogouchi.name, "ダム 2137700700001");
    assert.equal(ogouchi.storageLevel, 511.39);
    assert.equal(ogouchi.storageRate, 68.7);
    assert.equal(ogouchi.inflow, 4.01);
    assert.equal(ogouchi.outflow, 4.01);
    assert.equal(ogouchi.discharging, true);
  });
});
