# A.A.S (Aegis Alert System)

| 項目 | 内容 |
|---|---|
| バージョン | v0.1.0 |
| 状態 | **ゼロから作り直し中（再実装中）** |
| 実装 | TypeScript（Node 22、ESM）、実行時の外部依存ゼロ |

English version: [README.md](README.md)

## 概要

A.A.S（読み： アース。機能名は A2S）は、Aegis ファミリー（Discord Bot、
Python / Java / Windows / Android / C# の各クライアント、Web の bosai）の
防災情報の取り込み・正規化・配信を一本化する中継ハブ。各クライアントが
個別に上流へ取りに行くのではなく、A.A.S が一括で取り込み、共通イベント
フォーマットへ正規化し、重複を排除して全クライアントへ配信する。

> **再実装について：** 本リポジトリは従来の `aegis-alert-system`
> （v0.10.0）をゼロから書き直す再実装である。本番は従来実装が稼働中で、
> 本コードベースは契約互換を目標にフェーズ単位で再構築している。
> 既存クライアントは無変更で切り替えられる。計画とモジュール単位の
> パリティチェックリストは [DESIGN.md](DESIGN.md) を参照。

## API 契約（要約）

認証は `Authorization: Bearer <token>`（SSE のみ `?token=` クエリも可）。
owner リスナーはプライベートネットワーク内専用で、別に公開用リスナーが
名前つき利用者別トークンに対して読み取り専用エンドポイントを提供する
（owner トークンは公開側では拒否される）。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/v1/status` | 稼働状態（保持件数、取り込み経路ごとの健康状態） |
| GET | `/v1/status/public` | 無認証の粗い状態（公開ステータス表示用。イベント内容は含まない） |
| GET | `/v1/events` | 直近イベントの一覧。`kind` / `since` / `limit` で絞り込み |
| GET | `/v1/stream` | SSE ストリーム。接続時に保持イベントを再生し、以後は新規・更新を push |
| GET | `/v1/master` | マスターデータの索引（名前・件数・生成日） |
| GET | `/v1/master/<name>` | マスターデータ1件を原形式のまま配信 |

マスターデータ（9件）： `stations`（震度観測点 4,361）、`station-prefs`、
`tsunami-stations`、`tsunami-zones`、`coastline`、`eew-polygons`、
`volcanoes`、`rivers`、`amedas`（気象庁から実行時取得）。

### イベント種別（14種）

`quake`（地震）、`eew`（緊急地震速報）、`tsunami`（津波）、`warning`
（警報・注意報）、`typhoon`（台風）、`flood`（洪水予報）、`sediment`
（土砂災害警戒情報）、`tornado`（竜巻注意情報）、`record-rain`
（記録的短時間大雨情報）、`linear-rain`（線状降水帯）、`volcano`
（火山）、`river`（河川観測値）、`dam`（ダム諸量）、`heat`
（熱中症警戒アラート）。

取り込み元： P2P地震情報（地震・津波・EEW）、Wolfx（WebSocket ＋ HTTP
フォールバック）、DMDSS（dmdata.jp。契約は EEW（予報））、気象庁の
警報・台風、気象庁防災情報XML フィード、国土交通省「川の防災情報」の
河川・ダム観測値（**現行本番では巡回負荷の恒久対策まで無効化中**）、
環境省 WBGT の熱中症警戒アラート。

公開リスナーでの EEW 配信にはゲートがある： 二次利用制限のため、許可
リストに名前があり、かつ供給元が DMDSS の場合にだけ届ける。

## 設定

設定はすべて環境変数で行う。全一覧と安全な localhost 既定値は
[.env.example](.env.example) を参照。実物の `.env` は絶対にコミット
しないこと。

## 開発

開発手順は [CONTRIBUTING.md](CONTRIBUTING.md) の統一手順に従う：
Issue を先に作り、ブランチ `<type>/<issue-number>-<slug>`、PR に
`Closes #<number>` を付け、「Rebase and merge」で取り込む。

```bash
npm install
npm run build   # tsc -> dist/
npm test        # ビルド + node --test
npm start       # node --env-file-if-exists=.env dist/src/index.js
```

## ライセンス

MIT（[LICENSE](LICENSE)）。同梱フォント（後続フェーズで追加）には
それぞれのライセンスが適用される。
