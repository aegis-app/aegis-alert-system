// ==========================================
// 🧩 最小 XML パーサと電文共通部の読み取り
// ==========================================
// 📌 気象庁防災情報XML (電文) と Atom フィードの読み取りに必要な範囲
// (要素・属性・テキスト・CDATA・コメント・処理命令) だけを扱う、
// 名前空間に依存しない最小の防御的パーサ。実行時の外部依存ゼロの方針
// (DESIGN 判断記録 1) のため、XML パーサも標準機能の範囲で自作する。
// 電文は jmaxml の名前空間つきだが、要素の同一性は接頭辞を除いた
// ローカル名で判定する (接頭辞は資料ごとに変わりうるため)。
// 壊れた XML では例外にせず、読めた範囲のツリーを返す (取り込みを
// 止めないため)。

// 🧩 XML ツリーの要素
export interface XmlNode {
  // 🏷️ ローカル名 (名前空間接頭辞を除いた要素名)
  name: string;
  // 🏷️ 属性 (キーもローカル名に正規化する)
  attrs: Record<string, string>;
  children: XmlNode[];
  // 📝 直下のテキスト (子要素のテキストは含まない)
  text: string;
}

// 🏷️ 名前空間接頭辞を除いたローカル名にする
function localName(raw: string): string {
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

// 🔤 XML エンティティを復号する
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (m, body: string) => {
    switch (body) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
      default: {
        const code = body.startsWith("#x") || body.startsWith("#X")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
    }
  });
}

// 🧩 XML 文字列をツリーへ変換する。ルート要素が無ければ null
export function parseXml(xml: string): XmlNode | null {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      stack[stack.length - 1].text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const inner = end < 0 ? xml.slice(lt + 9) : xml.slice(lt + 9, end);
      stack[stack.length - 1].text += inner;
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) break;
    const tagBody = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tagBody.startsWith("/")) {
      // 🔚 終了タグ: 対応する開始タグまで巻き戻す (不一致でも壊さない)
      const name = localName(tagBody.slice(1).trim());
      for (let d = stack.length - 1; d >= 1; d--) {
        if (stack[d].name === name) {
          stack.length = d;
          break;
        }
      }
      continue;
    }
    const selfClosing = tagBody.endsWith("/");
    const inner = selfClosing ? tagBody.slice(0, -1) : tagBody;
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    if (!nameMatch) continue;
    const node: XmlNode = { name: localName(nameMatch[1]), attrs: {}, children: [], text: "" };
    const attrSrc = inner.slice(nameMatch[1].length);
    const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrSrc)) !== null) {
      node.attrs[localName(am[1])] = decodeEntities(am[2] ?? am[3] ?? "");
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root.children[0] ?? null;
}

// 🔍 子要素から名前で探す
export function childOf(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

// 🔍 子要素のテキスト (前後の空白を除く)。無ければ ""
export function childText(node: XmlNode, name: string): string {
  return childOf(node, name)?.text.trim() ?? "";
}

// 🔍 子孫要素を名前で全て集める (文書順)
export function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

// 🔍 子孫要素から名前で最初に一致するものを探す
export function firstDescendant(node: XmlNode, name: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const hit = firstDescendant(c, name);
    if (hit) return hit;
  }
  return undefined;
}

// 🔢 全角数字を半角化する (雨量・レベル等の数値抽出用)
export function toHalfDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 📝 テキスト要素群の本文を連結する (重複は除く)
export function joinTexts(nodes: XmlNode[]): string {
  const parts: string[] = [];
  for (const nd of nodes) {
    const t = nd.text.trim();
    if (t && !parts.includes(t)) parts.push(t);
  }
  return parts.join("\n");
}

// ------------------------------------------
// 📄 電文 (Report) の共通部
// ------------------------------------------
// 📌 気象庁電文は Control (伝送情報) / Head (見出し) / Body (本文) の
// 3部構成で全ドメイン共通。Headline の Information は type 属性ごとに
// Item (Kind + Areas) を持ち、ドメインごとの対象・種別はここから取る

// 📢 Headline の Information 1件分の Item
export interface HeadlineItem {
  kindName: string;
  kindCode: string;
  kindCondition: string;
  kindStatus: string;
  areas: { name: string; code: string }[];
}

// 📢 Headline の Information (type 属性つき)
export interface HeadlineInfo {
  type: string;
  items: HeadlineItem[];
}

// 📄 電文を共通部へ分解した結果
export interface TelegramParts {
  root: XmlNode;
  controlTitle: string;
  editorialOffice: string;
  publishingOffice: string;
  headTitle: string;
  reportDateTime: string;
  validDateTime: string | null;
  infoType: string;
  headlineText: string;
  headlineInfos: HeadlineInfo[];
  body: XmlNode | null;
}

// 📄 電文 XML を共通部へ分解する。Report でなければ null
export function parseTelegramParts(xml: string): TelegramParts | null {
  const root = parseXml(xml);
  if (!root || root.name !== "Report") return null;
  const control = childOf(root, "Control");
  const head = childOf(root, "Head");
  if (!control || !head) return null;
  const headline = childOf(head, "Headline");
  const headlineInfos: HeadlineInfo[] = [];
  if (headline) {
    for (const info of headline.children.filter((c) => c.name === "Information")) {
      const items: HeadlineItem[] = [];
      for (const item of info.children.filter((c) => c.name === "Item")) {
        const kind = childOf(item, "Kind");
        const areasNode = childOf(item, "Areas");
        const areas = areasNode
          ? areasNode.children
              .filter((c) => c.name === "Area")
              .map((a) => ({ name: childText(a, "Name"), code: childText(a, "Code") }))
              .filter((a) => a.name)
          : [];
        items.push({
          kindName: kind ? childText(kind, "Name") : "",
          kindCode: kind ? childText(kind, "Code") : "",
          kindCondition: kind ? childText(kind, "Condition") : "",
          kindStatus: kind ? childText(kind, "Status") : "",
          areas,
        });
      }
      headlineInfos.push({ type: info.attrs.type ?? "", items });
    }
  }
  const valid = childText(head, "ValidDateTime");
  return {
    root,
    controlTitle: childText(control, "Title"),
    editorialOffice: childText(control, "EditorialOffice"),
    publishingOffice: childText(control, "PublishingOffice"),
    headTitle: childText(head, "Title"),
    reportDateTime: childText(head, "ReportDateTime"),
    validDateTime: valid || null,
    infoType: childText(head, "InfoType"),
    headlineText: headline ? childText(headline, "Text") : "",
    headlineInfos,
    body: childOf(root, "Body") ?? null,
  };
}

// 📝 Body 内の Text 要素を本文として連結する (気象系 Body の共通形)
export function bodyTextOf(body: XmlNode | null): string {
  if (!body) return "";
  return joinTexts(descendants(body, "Text"));
}
