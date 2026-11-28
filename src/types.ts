// ==========================================
// 📦 共通イベントフォーマット
// ==========================================
// 📌 A.A.S がクライアントへ配信するイベントの形。Aegis ファミリー各実装
// (Discord Bot / Python / Java / Windows / Android / C# / bosai) の既存の
// 情報モデルとフィールド名・規則をそろえ、移行時の変換を最小にする。
// 時刻の表記は P2P の JST 表記 ("2026/11/19 06:41:00") をそのまま保持し、
// 取り込み時刻だけ ISO 8601 (UTC) で別に持つ。

// 📡 取り込み経路の識別子。"jma-xml" は気象庁防災情報XML (PULL 型) 経由で、
// bosai JSON 経由の "jma" とは取得系が違うため別経路として区別する。
// "kawabou" は国土交通省「川の防災情報」、"wbgt" は環境省熱中症予防
// 情報サイト経由
export type SourceId = "p2p" | "wolfx-ws" | "wolfx-http" | "jma" | "jma-xml" | "kawabou" | "wbgt" | "dmdss";

// 📦 イベント種別 (14種別)
export type EventKind =
  | "quake"
  | "eew"
  | "tsunami"
  | "warning"
  | "typhoon"
  | "flood"
  | "sediment"
  | "tornado"
  | "record-rain"
  | "linear-rain"
  | "volcano"
  | "river"
  | "dam"
  | "heat";

// 📦 全種別の配列 (kind 検証・件数集計などで単一の定義を共有する)
export const EVENT_KINDS: readonly EventKind[] = [
  "quake",
  "eew",
  "tsunami",
  "warning",
  "typhoon",
  "flood",
  "sediment",
  "tornado",
  "record-rain",
  "linear-rain",
  "volcano",
  "river",
  "dam",
  "heat",
];

// 📦 全イベント共通の封筒フィールド
export interface A2sEventBase {
  kind: EventKind;
  // 🌍 同一視キー (イベント単位)。規則は種別ごとのコメントを参照
  key: string;
  // 📡 最後にこのイベントを取り込んだ経路
  source: SourceId;
  // 📡 取り込みが確認できた全経路 (重複排除の結果として積み上がる)
  sources: SourceId[];
  // 🕐 初回取り込み時刻 (ISO 8601)
  receivedAt: string;
  // 🕐 最終更新時刻 (ISO 8601)。内容が変わらない再取り込みでは更新しない
  updatedAt: string;
}

// ------------------------------------------
// 🌍 地震情報 (P2P 551)
// ------------------------------------------
// 📌 同一視キーは groupKey: "551:<発生時刻>|@<緯度1桁>,<経度1桁>"
// (座標が無い場合のみ震源名を使う)。複数報 (震度速報→詳細情報) は
// 取り込み側で1イベントに統合済み
export interface QuakeEvent extends A2sEventBase {
  kind: "quake";
  // 📌 主電文の P2P 電文 ID (詳細表示や外部リンク用)
  telegramId: string;
  // 🕐 代表時刻 (P2P 表記)。国内地震では発生時刻だが、国外地震 (Foreign)
  // では電文に発生時刻が無く発表時刻が入るため、発生時刻は originTime を使う
  time: string;
  // 🕐 主電文の発表時刻 (P2P 表記)
  announcedTime: string;
  // 🕐 発生時刻の原表記 (eq.originTime)。国外地震の電文だけが持ち、
  // 国内電文では eq.time が発生時刻そのもののため null
  originTime: string | null;
  hypocenter: string;
  magnitude: number | null;
  // 📌 深さ (km)。null は不明、0 は「ごく浅い」
  depthKm: number | null;
  // 📳 最大震度コード (10=1, 45=5-, 55=6-, 70=7)。-1 は不明 (国外地震)
  maxScale: number;
  // 🌊 津波の見通し (domesticTsunami の原文キー: None / Forecast / Advisory / Warning / Unknown 等)
  tsunamiKind: string;
  // 🌊 電文コメントの原文 (comments.freeFormComment を優先し、無ければ
  // comments.text)。国外地震の津波コメント表示に使う。空・欠落は null
  tsunamiText: string | null;
  // 🌍 国外地震情報 (issue.type === "Foreign") かどうか
  foreign: boolean;
  // 🚨 issue の種別 (DetailScale / ScalePrompt / Foreign 等) と訂正区分
  issueType: string;
  issueCorrect: string;
  lat: number | null;
  lon: number | null;
  // 📳 最大震度を観測した地点名 (あれば)。地域震度 (isArea) の場合は topPointIsArea=true
  topPoint: string | null;
  topPointIsArea: boolean;
  // 📳 都道府県別の最大震度 (降順)
  prefScales: { pref: string; scale: number }[];
  // 📳 観測点・地域の全点 (統合済み)。isArea=true は地域代表値
  points: { pref: string; name: string; scale: number; isArea: boolean }[];
}

// ------------------------------------------
// 🚨 緊急地震速報 (P2P 556 / Wolfx jma_eew)
// ------------------------------------------
// 📌 すべての EEW 電文は「予報」であり、そのうち警報基準を満たしたものが
// 「警報」でもある二層モデル (isWarn)。P2P 556 由来は常に警報 (isWarn=true)、
// Wolfx 由来は isWarn フラグに従う。
// 同一視キー: JMA のイベント ID が取れる場合は baseKey = "eew-id:<eventId>"
// とし、無い場合のみ "eew-<発生時刻>@<緯度1桁>,<経度1桁>" (座標が無ければ
// 震源名) へフォールバックする。key は取消時に "-cancel" を付けた形を
// 保持し、ストア上の同一性は baseKey で見る
export interface EewEvent extends A2sEventBase {
  kind: "eew";
  // 🌍 イベント同一性キー (取消でも変わらない)
  baseKey: string;
  // 🕐 発表時刻 (P2P 表記)
  time: string;
  // 🕐 発生時刻 (P2P 表記)
  originTime: string;
  cancel: boolean;
  // ⚠️ 警報かどうか
  isWarn: boolean;
  // 📌 最終報かどうか (Wolfx の isFinal)。P2P 556 には概念が無いため常に
  // false。ストアでは終端の事実として粘着保持する
  isFinal: boolean;
  // 📌 報番号 (Wolfx Serial / P2P 556 issue.serial)。取れない場合は null
  serial: number | null;
  // 📌 イベント ID (Wolfx EventID / P2P 556 issue.eventId)。取れない場合は null
  eventId: string | null;
  // 🌍 仮定震源要素かどうか
  isAssumption: boolean;
  hypocenter: string;
  // 📳 推定最大震度コード。-1 は不明
  estScale: number;
  estMagnitude: number | null;
  // 🔁 対象の都道府県 (重複なし、最大6件)
  prefs: string[];
  lat: number | null;
  lon: number | null;
  depthKm: number | null;
  // 🕐 都道府県ごとの主要動到達予想時刻 (発表値、あれば)
  areaArrivals: { pref: string; arrivalTime: string }[];
  // 📳 細分区域ごとの予想震度 (scale は下限値。P2P 556 の scaleFrom)。
  // scaleTo は上限値で、99 は「〜程度以上」(下限のみ判明)。P2P 556 由来
  // のみが持ち、上限の概念が無い経路では null。ストアの統合では prefs /
  // areaArrivals とともに「空でない側を優先」して補完する
  areaScales: { pref: string; name: string; scale: number; scaleTo: number | null }[];
}

// ------------------------------------------
// 🌊 津波予報 (P2P 552)
// ------------------------------------------
// 📌 同一視キーは "552:<P2P 電文 ID>"
export interface TsunamiEvent extends A2sEventBase {
  kind: "tsunami";
  // 🕐 発表時刻 (P2P 表記)
  time: string;
  cancelled: boolean;
  // 📌 最も高いグレード (MajorWarning / Warning / Watch / Unknown)
  grade: string;
  areas: {
    name: string;
    grade: string;
    // 🌊 予想される津波の高さの説明 (例 "1m")。無ければ null
    maxHeightLabel: string | null;
    // 🌊 予想される津波の高さの数値 (m、P2P の maxHeight.value)。
    // ラベルが無い・数値化できない場合は null
    maxHeightValue: number | null;
    // 🕐 第1波到達予想時刻の "HH:MM" 表記。無ければ null
    arrivalLabel: string | null;
    // 📌 第1波の condition (例「第1波の到達を確認」)。無ければ null
    firstHeightCondition: string | null;
  }[];
}

// ------------------------------------------
// ⚠️ 気象警報・注意報 (気象庁 warning/<officeCode>.json)
// ------------------------------------------
// 📌 同一視キーは "warning:<officeCode>:<areaCode>" で、イベントは
// 一次細分区域 (areaTypes[0]) ごとに1件。警報はイベントログではなく
// 「現在有効な集合」であり、ストアは有効な区域だけを保持する
// (保持モデルは store.ts の applyWarningSnapshot を参照)
export interface WarningEntry {
  // ⚠️ 気象庁の警報コード (例 "14")
  code: string;
  // ⚠️ 警報・注意報の名称。コード表に無いコードは
  // 「その他の警報・注意報（コードXX）」になる (落とさない)
  name: string;
  // 📌 原文の status (「継続」「発表」等)。空・欠落は継続中として扱う
  status: string;
  // 📌 重要度: 特別警報=4 / 警報=3 / 注意報=2
  severity: number;
}

export interface WarningEvent extends A2sEventBase {
  kind: "warning";
  // 🏢 発表官署コード (warning/<officeCode>.json のコード)
  officeCode: string;
  // 📍 その官署コードが属する都道府県名 (正式名)
  prefName: string;
  // 📍 一次細分区域コード
  areaCode: string;
  // 📍 一次細分区域名 (area.json の class10s から解決。解決できなければ
  // 「区域 <code>」にフォールバックする)
  areaName: string;
  // 🕐 官署の発表日時 (ISO 8601 原表記)
  reportDatetime: string;
  // 📢 官署の headlineText
  headline: string;
  // ⚠️ 発表中の警報・注意報 (重要度降順→名称順)。解除イベントでは空
  warnings: WarningEntry[];
  // 📌 区域内の最大重要度。解除イベントでは 0
  maxSeverity: number;
  // 🕐 代表時刻 (= reportDatetime)
  time: string;
  // 📌 解除イベントかどうか。ストアに保持されるのは常に false で、
  // true のものは applyWarningSnapshot が配信専用に生成する
  released: boolean;
}

// ------------------------------------------
// 🌀 台風 (気象庁 targetTc.json)
// ------------------------------------------
// 📌 同一視キーは "typhoon:<台風番号>"。番号が取れない場合は名称ベース
// ("typhoon:<名称>")。targetTc の要素の形は不定なため、表示行 (lines)
// は防御的規則で作り、要素に含まれるスカラー値は fields として落とさず保持する
export interface TyphoonEvent extends A2sEventBase {
  kind: "typhoon";
  // 🌀 台風番号 (typhoonNumber / number / tcNumber)。取れなければ null
  number: string | null;
  // 🌀 名称 (name / typhoonName / title)。取れなければ null
  name: string | null;
  // 🌀 英語名 (englishName / enName / english)。取れなければ null
  englishName: string | null;
  // 📝 表示行 (台風1件につき1行)
  lines: string[];
  // 📦 要素に含まれる全スカラー値 (文字列・数値)。位置・中心気圧・
  // 進路予報など、データ源に含まれる項目はここ経由で保持される
  fields: Record<string, string | number>;
  // 🕐 代表時刻。要素内の日時らしいスカラー値があればそれ、無ければ ""。
  // 保持期間の判定には使わない (台風は最終確認時刻で判定する。store.ts 参照)
  time: string;
}

// ------------------------------------------
// 🌊 指定河川洪水予報 (気象庁防災情報XML VXKO**)
// ------------------------------------------
// 📌 同一視キーは "flood:<発表官署>:<河川名>:<予報区域名>"。同一河川・
// 区域の続報 (格上げ・格下げ・解除) は発表官署・河川・区域が不変のため
// 自然に1件へ統合される。種別は Headline の Information の Item/Kind に
// Name (氾濫注意情報 等) と Code (10=解除 / 20,21,22=注意 / 30,31=警戒 /
// 40,41=危険 / 51,53=発生) で入る。PublishingOffice は共同発表官署の
// 列挙 (xs:list) の原文をそのまま保持する
export interface FloodStation {
  // 📍 水位観測所名
  name: string;
  // 🌊 現況水位の原文 (m 単位の数値文字列)。電文に水位情報が無ければ null
  waterLevel: string | null;
  // 🌊 現況水位の condition (「上昇」等)。無ければ null
  condition: string | null;
}

export interface FloodEvent extends A2sEventBase {
  kind: "flood";
  // 🏢 発表官署 (Control/PublishingOffice の原文。共同発表の列挙を含む)
  office: string;
  // 🏞️ 河川名 (Headline の河川 Areas。複数ある場合は先頭を代表とし、
  // 全河川は rivers に保持する)
  river: string;
  // 🏞️ 対象河川の全名称
  rivers: string[];
  // 📍 予報区域名 (標題河川名)
  area: string;
  // 📌 種別名 (氾濫注意情報 / 氾濫警戒情報 / 氾濫危険情報 / 氾濫発生情報 /
  // 解除時の種別名 等。新標題 (レベル２氾濫注意報 等) も原文のまま保持する)
  category: string;
  // 📌 種別コード (Kind/Code の原文)
  categoryCode: string;
  // 📌 重要度: 解除=0 / 氾濫注意情報=2 / 氾濫警戒情報=3 / 氾濫危険情報=4 /
  // 氾濫発生情報=5 (コードで判定する)
  severity: number;
  // 📌 解除電文かどうか (種別コード 10、または種別名に「解除」を含む)。
  // ストアでは tsunami の cancelled と同じく終端の事実として粘着する
  cancelled: boolean;
  // 🕐 発表日時 (Head/ReportDateTime の ISO 8601 原表記)
  reportDatetime: string;
  // 🕐 代表時刻 (= reportDatetime)
  time: string;
  // 📢 標題 (Head/Title。例「小貝川氾濫警戒情報」)
  title: string;
  // 📢 見出し文 (Headline/Text)
  headline: string;
  // 📝 本文 (Body の主文等の Text を連結したもの)
  text: string;
  // 📍 対象観測所と水位状況 (Body の主文 Item の Stations と、水位・
  // 流量情報の現況水位を観測所名で突き合わせたもの)
  stations: FloodStation[];
}

// ------------------------------------------
// 🏔️ 土砂災害警戒情報 (気象庁防災情報XML VXWW50)
// ------------------------------------------
// 📌 同一視キーは "sediment:<都道府県名>:<市町村名>" で、イベントは
// 市町村ごとに1件。warning と同じ「現在有効な集合」であり、ストアは
// 発表中の市町村だけを保持する (保持モデルは store.ts の
// applySedimentSnapshot を参照)。電文は完全集合型 (Body が県内全市町村の
// 警戒 / 解除 / なし を列挙する) のため、Body の警戒集合をそのまま
// 完全集合として取り込む
export interface SedimentEvent extends A2sEventBase {
  kind: "sediment";
  // 📍 都道府県名 (Body/TargetArea の Name)
  prefName: string;
  // 📍 市町村名
  cityName: string;
  // 🕐 発表日時 (Head/ReportDateTime の ISO 8601 原表記)
  reportDatetime: string;
  // 🕐 代表時刻 (= reportDatetime)
  time: string;
  // 📢 見出し文 (Headline/Text)
  headline: string;
  // 📌 解除イベントかどうか。ストアに保持されるのは常に false で、
  // true のものは applySedimentSnapshot が配信専用に生成する
  released: boolean;
}

// ------------------------------------------
// 🌪️ 竜巻注意情報 (気象庁防災情報XML VPHW50 / VPHW51)
// ------------------------------------------
// 📌 同一視キーは "tornado:<発表官署>:<発表日時>"。VPHW50 (目撃情報
// なし) と VPHW51 (目撃情報付き) は同一発表の別電文であり、発表官署と
// 発表日時が同じため1件に統合される (目撃情報の有無は witnessed で表す。
// 発表官署は Control/PublishingOffice が「気象庁」に統一されるため、
// キーと office には実編集官署である EditorialOffice を使う)
export interface TornadoEvent extends A2sEventBase {
  kind: "tornado";
  // 🏢 編集官署 (Control/EditorialOffice)
  office: string;
  // 📍 対象地域 (府県予報区・細分区域名。Headline の Information の Areas)
  areas: string[];
  // 🕐 発表日時 (Head/ReportDateTime の ISO 8601 原表記)
  reportDatetime: string;
  // 🕐 代表時刻 (= reportDatetime)
  time: string;
  // 🕐 有効期限 (Head/ValidDateTime の ISO 8601 原表記)。無ければ null
  validUntil: string | null;
  // 📢 見出し文 (Headline/Text)
  headline: string;
  // 📝 本文 (Body の Text を連結したもの)
  text: string;
  // 👀 目撃情報付き (VPHW51) かどうか
  witnessed: boolean;
}

// ------------------------------------------
// 🌧️ 記録的短時間大雨情報 (気象庁防災情報XML VPOA50)
// ------------------------------------------
// 📌 同一視キーは "record-rain:<編集官署>:<発表日時>" (竜巻注意情報と
// 同じく EditorialOffice を使う)。雨量は見出し文の定型 (「珠洲市付近で
// 約１００ミリ」等) から抽出する: 「付近で約」は解析雨量、「で○○ミリ」
// (約なし) は観測を表す文面上の区別があるため、種別 (rainfallType)
// として保持する
export interface RecordRainEvent extends A2sEventBase {
  kind: "record-rain";
  // 🏢 編集官署 (Control/EditorialOffice)
  office: string;
  // 📍 対象地域 (Headline の Information の Areas 名)
  areas: string[];
  // 📍 雨量を観測・解析した地点の原文 (見出し文から抽出。例「珠洲市付近」)
  station: string | null;
  // 🌧️ 雨量 (ミリ、全角数字を半角化した数値)。抽出できなければ null
  rainfallMm: number | null;
  // 🌧️ 雨量の原文 (例「約１００ミリ」)。抽出できなければ null
  rainfallLabel: string | null;
  // 🌧️ 雨量の種別: "observed" (観測) / "analysis" (解析雨量) / null (判別不能)
  rainfallType: "observed" | "analysis" | null;
  // 🕐 発表日時 (Head/ReportDateTime の ISO 8601 原表記)
  reportDatetime: string;
  // 🕐 代表時刻 (= reportDatetime)
  time: string;
  // 📢 見出し文 (Headline/Text)
  headline: string;
  // 📝 本文 (Body の Text を連結したもの)
  text: string;
}

// ------------------------------------------
// 🌧️ 顕著な大雨に関する情報 / 線状降水帯 (気象庁防災情報XML
// VPZJ50 / VPCJ50 / VPFJ50 のうち該当電文のみ)
// ------------------------------------------
// 📌 独立電文ではなく気象情報電文の一種であり、標題 (Head/Title) に
// 「顕著な大雨に関する」を含むものだけを取り込む。同一視キーは
// "linear-rain:<発表官署>:<発表日時>"
export interface LinearRainEvent extends A2sEventBase {
  kind: "linear-rain";
  // 🏢 発表官署 (Control/PublishingOffice)
  office: string;
  // 📢 標題 (Head/Title。例「顕著な大雨に関する福岡県気象情報」)
  title: string;
  // 📍 対象地域 (Headline の Information の Areas があればそれ、無ければ
  // 空配列とし、地域は title / headline の原文で表す)
  areas: string[];
  // 🕐 発表日時 (Head/ReportDateTime の ISO 8601 原表記)
  reportDatetime: string;
  // 🕐 代表時刻 (= reportDatetime)
  time: string;
  // 📢 見出し文 (Headline/Text)
  headline: string;
  // 📝 本文 (Body の Text を連結したもの)
  text: string;
}

// ------------------------------------------
// 🌋 火山系 (気象庁防災情報XML VFVO**、地震火山フィード)
// ------------------------------------------
// 📌 同一視キーは "volcano:<火山名>:<category>:<発表日時>"。火山名は
// Body の Areas (codeType="火山名") から取る。category は Control/Title
// から判別する: 噴火速報 / 噴火警報・予報 / 降灰予報 / 解説情報 /
// 観測報 / その他。噴火警戒レベルは取れる場合のみ保持する
export type VolcanoCategory = "噴火速報" | "噴火警報・予報" | "降灰予報" | "解説情報" | "観測報" | "その他";

export interface VolcanoEvent extends A2sEventBase {
  kind: "volcano";
  // 🌋 火山名
  volcanoName: string;
  // 📌 電文の分類 (Control/Title から判別)
  category: VolcanoCategory;
  // 📌 噴火警戒レベル (1〜5)。電文に無ければ null
  level: number | null;
  // 📌 噴火警戒レベルの名称 (例「入山規制」)。無ければ null
  levelName: string | null;
  // 📍 対象市町村 (降灰予報の対象市町村等。無ければ空配列)
  areas: string[];
  // 🕐 発表日時 (Head/ReportDateTime の ISO 8601 原表記)
  reportDatetime: string;
  // 🕐 代表時刻 (= reportDatetime)
  time: string;
  // 📢 標題 (Head/Title)
  title: string;
  // 📢 見出し文 (Headline/Text)
  headline: string;
  // 📝 本文 (Body の本文要素を連結したもの)
  text: string;
}

// ------------------------------------------
// 🏞️ 河川観測値 (国土交通省「川の防災情報」テレメータ)
// ------------------------------------------
// 📌 同一視キーは "river:<metric>:<観測所コード (obsFcd)>"。スナップ
// ショット型: ストアは観測所ごとの最新値を保持して REST で参照できる
// ようにし、SSE へは levelState の遷移時だけ配信する (数値変化そのもの
// は配信しない。遷移の判定は取り込み側が担う)。
// ⚠️ 値は速報値 (未精査) であり、異常値を含み得る (提供側の前提)。
// 出典: 国土交通省 川の防災情報
export type RiverLevelState =
  | "平常"
  | "水防団待機水位超過"
  | "氾濫注意水位超過"
  | "避難判断水位超過"
  | "氾濫危険水位超過"
  | "氾濫発生水位超過"
  | "欠測";

export interface RiverEvent extends A2sEventBase {
  kind: "river";
  // 📌 観測種別: "level" = 水位観測所 / "rain" = 雨量観測所
  metric: "level" | "rain";
  // 📍 観測所コード (川の防災情報の obsFcd、13桁)
  stationCode: string;
  // 📍 観測所名 (観測所マスタから解決。解決できなければ「観測所 <コード>」)
  stationName: string;
  // 🏞️ 河川名
  riverName: string;
  // 🏞️ 水系名
  systemName: string;
  // 🌊 現在値: 水位は水位 (m、テレメータ stg)、雨量は時間雨量 (mm、
  // テレメータ rnHr)。欠測時は null
  value: number | null;
  // 🌧️ 10分雨量 (mm)。雨量観測所のみが持ち、水位観測所では null
  rain10m: number | null;
  // 🕐 観測時刻 (原表記 "2026/11/26 11:20")
  observedAt: string;
  // 🕐 代表時刻 (= observedAt)
  time: string;
  // 📌 基準水位との比較状態。水位はテレメータの超過レベルコードと
  // 欠測コードから導く。雨量には基準水位の概念が無いため、欠測で
  // なければ「平常」として扱う
  levelState: RiverLevelState;
  // 📌 状態の数値化: 平常=0 / 水防団待機=1 / 氾濫注意=2 / 避難判断=3 /
  // 氾濫危険=4 / 氾濫発生=5 / 欠測=-1 (不明として扱う)
  stateSeverity: number;
  // 📏 基準水位 (m、水位観測所のみ。観測所マスタの rsrvStg / warnStg /
  // spclWarnStg / dngStg / fldStg)。設定が無い・マスタ未解決の観測所
  // では null。雨量観測所ではすべて null
  thresholds: {
    standby: number | null;
    caution: number | null;
    refuge: number | null;
    danger: number | null;
    flood: number | null;
  };
}

// ------------------------------------------
// 🏞️ ダム諸量 (国土交通省「川の防災情報」テレメータ)
// ------------------------------------------
// 📌 同一視キーは "dam:<ダムコード (obsFcd)>"。河川観測値と同じスナップ
// ショット型で、SSE へは放流の開始/停止 (discharging の遷移) のとき
// だけ配信する。貯水率や放流量の増減そのものは配信しない。
// ⚠️ 値は速報値 (未精査)。出典: 国土交通省 川の防災情報
export interface DamEvent extends A2sEventBase {
  kind: "dam";
  // 📍 ダムコード (川の防災情報の obsFcd、13桁)
  damCode: string;
  // 📍 ダム名 (観測所マスタから解決。解決できなければ「ダム <コード>」)
  name: string;
  // 🏞️ 河川名
  riverName: string;
  // 🏞️ 水系名
  systemName: string;
  // 🌊 貯水位 (m、テレメータ storLvl)。欠測時は null
  storageLevel: number | null;
  // 🌊 貯水率 (%)。有効容量貯水率 (storPcntEff) を優先し、取れなければ
  // 利水容量貯水率 (storPcntIrr) で代替する。欠測時は null
  storageRate: number | null;
  // 🌊 全流入量 (m³/s、テレメータ allSink)。欠測時は null
  inflow: number | null;
  // 🌊 全放流量 (m³/s、テレメータ allDisch)。欠測時は null
  outflow: number | null;
  // 📌 放流中かどうか (放流量が欠測でなく 0 より大きい)。放流の開始/
  // 停止の遷移判定に使う
  discharging: boolean;
  // 🕐 観測時刻 (原表記 "2026/11/26 11:10")
  observedAt: string;
  // 🕐 代表時刻 (= observedAt)
  time: string;
}

// ------------------------------------------
// 🌡️ 熱中症警戒アラート (環境省 WBGT 電子情報提供サービス)
// ------------------------------------------
// 📌 同一視キーは "heat:<府県予報区等コード>" (例 "heat:130000")。
// warning と同じ有効集合型で、ストアは発表中の区域だけを保持する
// (保持モデルは store.ts の applyHeatSnapshot を参照)。スコープは
// CSV 全体を1つとする (ファイルが取得できた場合のみ差分を適用し、
// 取得できない場合は前回状態を保持する)。
// 📌 本データは環境省熱中症予防情報サイトからの提供情報を利用して
// いる。CSV は参考情報という位置づけで、正式発表は環境省のサイト/
// 報道発表が正である
export interface HeatEvent extends A2sEventBase {
  kind: "heat";
  // 📍 府県予報区等コード (CSV の「府県予報区等コード」)
  areaCode: string;
  // 📍 府県予報区名 (例「東京都」「石狩・空知・後志地方」)
  areaName: string;
  // 📍 都道府県名 (CSV の「都道府県名」)
  prefName: string;
  // 📌 レベル (TargetDate1/2 フラグの最大値。フラグ 9=発表時間外は
  // 0 として扱う): 0=発表なし / 1=熱中症警戒アラート /
  // 2=熱中症特別警戒アラートの判定 / 3=熱中症特別警戒アラート
  level: number;
  // 📌 レベル名 (level の表示名。解除イベントでは「発表なし」)
  levelName: string;
  // 🎯 対象日1 (当日) とそのフラグ
  target1: { date: string; flag: number };
  // 🎯 対象日2 (翌日) とそのフラグ
  target2: { date: string; flag: number };
  // 🌡️ 日最高 WBGT (区域内の地点別値の最大値)。地点別値が無ければ null
  maxWbgt: number | null;
  // 🌡️ 日最高 WBGT を記録した地点名。無ければ null
  maxWbgtStation: string | null;
  // 🕐 発表日 (CSV ファイルの ReportDate 原表記 "2026/08/15")
  reportDate: string;
  // 🕐 発表時刻 (CSV ファイル名の時刻に対応する ReportTime 原表記)
  reportTime: string;
  // 🕐 発表日時 (ISO 8601)
  reportDatetime: string;
  // 🕐 代表時刻 (= reportDatetime)
  time: string;
  // 📌 解除イベントかどうか。ストアに保持されるのは常に false で、
  // true のものは applyHeatSnapshot が配信専用に生成する
  released: boolean;
}

// 📦 全イベントの判別共用体
export type A2sEvent =
  | QuakeEvent
  | EewEvent
  | TsunamiEvent
  | WarningEvent
  | TyphoonEvent
  | FloodEvent
  | SedimentEvent
  | TornadoEvent
  | RecordRainEvent
  | LinearRainEvent
  | VolcanoEvent
  | RiverEvent
  | DamEvent
  | HeatEvent;

// 📥 取り込み側が生成する下書き (封筒フィールドはストアが付ける)
export type QuakeDraft = Omit<QuakeEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type EewDraft = Omit<EewEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type TsunamiDraft = Omit<TsunamiEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type WarningDraft = Omit<WarningEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type TyphoonDraft = Omit<TyphoonEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type FloodDraft = Omit<FloodEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type SedimentDraft = Omit<SedimentEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type TornadoDraft = Omit<TornadoEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type RecordRainDraft = Omit<RecordRainEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type LinearRainDraft = Omit<LinearRainEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type VolcanoDraft = Omit<VolcanoEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type RiverDraft = Omit<RiverEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type DamDraft = Omit<DamEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type HeatDraft = Omit<HeatEvent, "source" | "sources" | "receivedAt" | "updatedAt">;
export type EventDraft =
  | QuakeDraft
  | EewDraft
  | TsunamiDraft
  | WarningDraft
  | TyphoonDraft
  | FloodDraft
  | SedimentDraft
  | TornadoDraft
  | RecordRainDraft
  | LinearRainDraft
  | VolcanoDraft
  | RiverDraft
  | DamDraft
  | HeatDraft;
