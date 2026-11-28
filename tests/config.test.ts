// ==========================================
// 🧪 設定 (config.ts) のテスト
// ==========================================
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_CORS_ORIGINS,
  loadConfig,
  parseClientTokens,
  parseCorsOrigins,
  parseNameList,
} from "../src/config.js";

describe("loadConfig defaults", () => {
  test("empty env yields safe localhost defaults", () => {
    const config = loadConfig({});
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8730);
    assert.equal(config.token, undefined);
    assert.equal(config.publicPort, undefined);
    assert.equal(config.clientTokens.size, 0);
    assert.deepEqual(config.publicEewClients, []);
    assert.deepEqual(config.corsOrigins, [...DEFAULT_CORS_ORIGINS]);
    assert.equal(config.riverIntervalMs, 600000);
    assert.equal(config.dmdssApiKey, undefined);
    assert.ok(config.dataFile.endsWith("data/events.json"));
    assert.ok(config.jmaXmlSeenFile.endsWith("jma-xml-seen.json"));
  });

  test("token is trimmed and an empty token counts as unset", () => {
    assert.equal(loadConfig({ A2S_TOKEN: "  secret  " }).token, "secret");
    assert.equal(loadConfig({ A2S_TOKEN: "   " }).token, undefined);
  });
});

describe("port validation", () => {
  test("a valid port is used as-is", () => {
    assert.equal(loadConfig({ A2S_PORT: "9000" }).port, 9000);
    assert.equal(loadConfig({ A2S_PUBLIC_PORT: "8731" }).publicPort, 8731);
  });

  test("an invalid owner port falls back to the default", () => {
    assert.equal(loadConfig({ A2S_PORT: "abc" }).port, 8730);
    assert.equal(loadConfig({ A2S_PORT: "70000" }).port, 8730);
    assert.equal(loadConfig({ A2S_PORT: "0" }).port, 8730);
  });

  test("an invalid public port disables the public listener", () => {
    assert.equal(loadConfig({ A2S_PUBLIC_PORT: "abc" }).publicPort, undefined);
    assert.equal(loadConfig({ A2S_PUBLIC_PORT: "-1" }).publicPort, undefined);
    assert.equal(loadConfig({ A2S_PUBLIC_PORT: "65536" }).publicPort, undefined);
  });
});

describe("interval validation", () => {
  test("non-positive or invalid intervals fall back to defaults", () => {
    const config = loadConfig({
      A2S_P2P_EEW_INTERVAL_MS: "0",
      A2S_JMA_WARNING_INTERVAL_MS: "-5",
      A2S_HEAT_INTERVAL_MS: "xyz",
    });
    assert.equal(config.p2pEewIntervalMs, 15000);
    assert.equal(config.jmaWarningIntervalMs, 60000);
    assert.equal(config.heatIntervalMs, 1800000);
  });

  test("river interval 0 is honored as 'disabled'", () => {
    assert.equal(loadConfig({ A2S_RIVER_INTERVAL_MS: "0" }).riverIntervalMs, 0);
    assert.equal(loadConfig({ A2S_RIVER_INTERVAL_MS: "-1" }).riverIntervalMs, 600000);
  });
});

describe("parseClientTokens", () => {
  test("parses name:token pairs", () => {
    const tokens = parseClientTokens("bosai-web:tok1, dev : tok2 ");
    assert.equal(tokens.get("bosai-web"), "tok1");
    assert.equal(tokens.get("dev"), "tok2");
    assert.equal(tokens.size, 2);
  });

  test("skips malformed entries and reserved names", () => {
    const tokens = parseClientTokens("no-separator,:empty-name,empty-token:,owner:x,anonymous:y,ok:fine");
    assert.equal(tokens.size, 1);
    assert.equal(tokens.get("ok"), "fine");
  });

  test("undefined or empty input yields an empty map", () => {
    assert.equal(parseClientTokens(undefined).size, 0);
    assert.equal(parseClientTokens("").size, 0);
  });
});

describe("parseNameList", () => {
  test("trims, drops empties and de-duplicates", () => {
    assert.deepEqual(parseNameList(" a, b ,a,, c "), ["a", "b", "c"]);
    assert.deepEqual(parseNameList(undefined), []);
  });
});

describe("parseCorsOrigins", () => {
  test("normalizes valid origins and strips paths", () => {
    assert.deepEqual(parseCorsOrigins("https://example.com/some/path, http://localhost:3000"), [
      "https://example.com",
      "http://localhost:3000",
    ]);
  });

  test("falls back to the default when nothing valid remains", () => {
    assert.deepEqual(parseCorsOrigins("not-a-url, ftp://example.com"), [...DEFAULT_CORS_ORIGINS]);
    assert.deepEqual(parseCorsOrigins(undefined), [...DEFAULT_CORS_ORIGINS]);
  });
});
