import { describe, it, expect } from "vitest";
import {
  extractCapacityFromItemName,
} from "../scripts/lib/frontmatter";
import { upsertYahooOfferInFrontmatter } from "../scripts/lib/yahoo-offers";
import {
  toComparableCapacity,
  isSameComparableCapacity,
  evaluateYahooCandidate,
  extractUrlQuantityMultiplier,
} from "../scripts/lib/yahoo-matching";

describe("Yahoo候補の容量照合", () => {
  describe("isSameComparableCapacity", () => {
    it("70枚×12個 と 70枚x10コパック は不一致", () => {
      const candidateCap = extractCapacityFromItemName("大王製紙 グーン やわらか素材のおしりふき 70枚x10コパック");
      expect(isSameComparableCapacity("70枚×12個", candidateCap)).toBe(false);
    });

    it("76枚×32個 と 1520枚（76枚×20個パック）は不一致", () => {
      const candidateCap = extractCapacityFromItemName("おしりふき 1520枚（76枚×20個パック）");
      expect(isSameComparableCapacity("76枚×32個", candidateCap)).toBe(false);
    });

    it("80枚×40個 と 【80枚×40個】おしりナップ は一致", () => {
      const candidateCap = extractCapacityFromItemName("【80枚×40個】おしりナップ やわらかタイプ");
      expect(isSameComparableCapacity("80枚×40個", candidateCap)).toBe(true);
    });

    it("容量抽出不可の候補（ウェットティッシュケース）は null になり不一致", () => {
      const candidateCap = extractCapacityFromItemName("フレッシュロック ウェットティッシュケース ホワイト");
      // 容量表記がない商品名から抽出した結果は null か、あっても総量が一致しない
      const result = isSameComparableCapacity("70枚×12個", candidateCap);
      expect(result).toBe(false);
    });

    it("capacity が null の場合は false", () => {
      expect(isSameComparableCapacity(null, "70枚×10個")).toBe(false);
      expect(isSameComparableCapacity("70枚×10個", null)).toBe(false);
    });
  });

  describe("toComparableCapacity", () => {
    it("70枚×12個 → 840枚", () => {
      const result = toComparableCapacity("70枚×12個");
      expect(result?.total).toBe(840);
      expect(result?.unit).toBe("枚");
    });

    it("76枚×32個 → 2432枚", () => {
      const result = toComparableCapacity("76枚×32個");
      expect(result?.total).toBe(2432);
      expect(result?.unit).toBe("枚");
    });

    it("空文字 → null", () => {
      expect(toComparableCapacity("")).toBeNull();
    });

    it("null → null", () => {
      expect(toComparableCapacity(null)).toBeNull();
    });
  });

  describe("extractCapacityFromItemName: 【N個】前置きタグの除去", () => {
    it("【12個】グーン...70枚×12P → 12個ではなく 70枚×12 を返す", () => {
      const cap = extractCapacityFromItemName(
        "【12個】グーン 肌にやさしいおしりふきつめかえ用 GOO.N 大王製紙 70枚×12P 送料無料"
      );
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(840);
      expect(total?.unit).toBe("枚");
    });

    it("【12個】除去後の結果は楽天 70枚×12個 と一致する", () => {
      const candidateCap = extractCapacityFromItemName(
        "【12個】グーン 肌にやさしいおしりふきつめかえ用 GOO.N 大王製紙 70枚×12P 送料無料"
      );
      expect(isSameComparableCapacity("70枚×12個", candidateCap)).toBe(true);
    });

    it("× を含む【80枚×40個】は除去しない", () => {
      const cap = extractCapacityFromItemName("【80枚×40個】おしりナップ やわらか厚手仕上げ");
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(3200);
      expect(total?.unit).toBe("枚");
    });

    it("【100枚】など容量単位は除去しない", () => {
      const cap = extractCapacityFromItemName("【100枚】おしりふき やわらかタイプ");
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(100);
      expect(total?.unit).toBe("枚");
    });

    it("【500mL】など計量単位は除去しない", () => {
      const cap = extractCapacityFromItemName("【500mL】ビオレ ボディウォッシュ");
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(500);
      expect(total?.unit).toBe("mL");
    });

    it("【2個】ビオレ 500mL → 乗数を折り込み 1000mL を返す", () => {
      const cap = extractCapacityFromItemName("【2個】ビオレ ボディウォッシュ 500mL");
      const total = toComparableCapacity(cap);
      expect(total?.total).toBe(1000);
      expect(total?.unit).toBe("mL");
    });

    it("【2個】ビオレ 500mL は楽天 500mL と一致しない", () => {
      const candidateCap = extractCapacityFromItemName("【2個】ビオレ ボディウォッシュ 500mL");
      expect(isSameComparableCapacity("500mL", candidateCap)).toBe(false);
    });
  });

  describe("upsertYahooOfferInFrontmatter: pending 差し替え", () => {
    const BASE_FM = `---
title: "テスト"
products:
  - name: "商品A"
    rank: 1
    capacity: "76枚×32個"
    offers:
      - provider: "yahoo"
        label: "Yahoo!"
        price: 3000
        url: "https://example.com/old"
        available: true
        matchStatus: "pending"
        updatedAt: "2026-01-01"
---
本文
`;

    const candidate = {
      provider: "yahoo" as const,
      label: "Yahoo!" as const,
      name: "商品A 76枚×32個",
      price: 2800,
      url: "https://example.com/new",
      imageUrl: null,
      available: true,
      sellerName: null,
    };

    it("capacityVerified: false のとき別URL候補は拒否する", () => {
      const result = upsertYahooOfferInFrontmatter(BASE_FM, "商品A", candidate, "2026-05-21", { capacityVerified: false });
      expect(result.changed).toBe(false);
      expect(result.reason).toContain("pending");
    });

    it("capacityVerified: true のとき別URL候補で pending を差し替える", () => {
      const result = upsertYahooOfferInFrontmatter(BASE_FM, "商品A", candidate, "2026-05-21", { capacityVerified: true });
      expect(result.changed).toBe(true);
      expect(result.content).toContain("https://example.com/new");
    });

    it("URL変更時に candidate.price が null なら price フィールドを省略する", () => {
      const nullPriceCandidate = { ...candidate, price: null };
      const result = upsertYahooOfferInFrontmatter(BASE_FM, "商品A", nullPriceCandidate, "2026-05-21", { capacityVerified: true });
      expect(result.changed).toBe(true);
      // 旧 offer の price: 3000 を引き継がない
      expect(result.content).not.toMatch(/price:\s*3000/);
      // null をそのまま書き込まない（スキーマ違反防止）
      expect(result.content).not.toContain("price: null");
    });

    it("capacityVerified: true, strictMatch: true, 同一URL のとき matched に昇格する", () => {
      const sameCandidate = { ...candidate, url: "https://example.com/old" };
      const result = upsertYahooOfferInFrontmatter(BASE_FM, "商品A", sameCandidate, "2026-05-22", {
        capacityVerified: true,
        strictMatch: true,
      });
      expect(result.changed).toBe(true);
      expect(result.content).toContain('matchStatus: "matched"');
    });

    it("capacityVerified: true でも strictMatch: false なら pending のまま", () => {
      const sameCandidate = { ...candidate, url: "https://example.com/old" };
      const result = upsertYahooOfferInFrontmatter(BASE_FM, "商品A", sameCandidate, "2026-05-22", {
        capacityVerified: true,
        strictMatch: false,
      });
      expect(result.changed).toBe(true);
      expect(result.content).toContain('matchStatus: "pending"');
    });

    it("strictMatch: true でも別URL のとき matched に昇格しない（pending のまま）", () => {
      const result = upsertYahooOfferInFrontmatter(BASE_FM, "商品A", candidate, "2026-05-22", {
        capacityVerified: true,
        strictMatch: true,
      });
      expect(result.changed).toBe(true);
      expect(result.content).toContain('matchStatus: "pending"');
      expect(result.content).toContain("https://example.com/new");
    });
  });

  describe("evaluateYahooCandidate", () => {
    const baseProduct = {
      name: "グーン 肌にやさしい おしりふき",
      capacity: "70枚×12個",
      brand: "グーン",
    };

    it("商品名トークン一致 + capacity一致 → ok: true", () => {
      const result = evaluateYahooCandidate(baseProduct, {
        provider: "yahoo",
        label: "Yahoo!",
        name: "【12個】グーン 肌にやさしいおしりふき 70枚×12P",
        price: 1800,
        url: "https://example.com/a",
        imageUrl: null,
        available: true,
        sellerName: null,
      });
      expect(result.ok).toBe(true);
    });

    it("brand フィールドが候補名に含まれない場合、strictMatch: false（ok は true のまま）", () => {
      // product.brand に製造メーカー名（大王製紙）を設定すると候補名に含まれず strictMatch: false になる
      const manufacturerBrand = { ...baseProduct, brand: "大王製紙" };
      const result = evaluateYahooCandidate(manufacturerBrand, {
        provider: "yahoo",
        label: "Yahoo!",
        name: "グーン 肌にやさしい おしりふき 70枚×12P",
        price: 1800,
        url: "https://example.com/b",
        imageUrl: null,
        available: true,
        sellerName: null,
      });
      expect(result.ok).toBe(true);          // isLikelySameProduct（先頭トークン"グーン"一致）は通る
      expect(result.strictMatch).toBe(false); // brand "大王製紙" が候補名にないため matched 昇格しない
    });

    it("brand フィールド未設定の場合、brand 照合はスキップして strictMatch を評価する", () => {
      const noBrand = { ...baseProduct, brand: null };
      const result = evaluateYahooCandidate(noBrand, {
        provider: "yahoo",
        label: "Yahoo!",
        name: "グーン 肌にやさしい おしりふき 70枚×12P",
        price: 1800,
        url: "https://example.com/c",
        imageUrl: null,
        available: true,
        sellerName: null,
      });
      expect(result.ok).toBe(true);
      // brand 未設定 → brandMatch は true 扱い。全トークン一致なら strictMatch: true
      expect(result.strictMatch).toBe(true);
    });

    it("送り仮名ゆれ: 商品名「詰め替え」と候補名「詰替」で strictMatch: true になる", () => {
      const result = evaluateYahooCandidate(
        { name: "ムーニー おしりふき やわらか素材 詰め替え", capacity: "76枚×32個", brand: "ムーニー" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "ムーニーおしりふきやわらか素材　詰替　76枚×8個入り×4パック　PP",
          price: 3731,
          url: "https://example.com/e",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      expect(result.strictMatch).toBe(true);
    });

    it("括弧エイリアス: brand「王子ネピア（ネピア）」でも候補名に「ネピア」があれば strictMatch: true", () => {
      const result = evaluateYahooCandidate(
        { name: "ネピア 激吸収 キッチンタオル 100枚", capacity: "100枚", brand: "王子ネピア（ネピア）" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "ネピア 激吸収 キッチンタオル 100枚 送料無料",
          price: 3000,
          url: "https://example.com/nepia",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      // "王子ネピア" は候補名にないが、括弧エイリアス "ネピア" で一致 → strictMatch: true
      expect(result.strictMatch).toBe(true);
    });

    it("括弧エイリアスが役に立たない場合（業務用（各社OEM））は strictMatch: false のまま", () => {
      const result = evaluateYahooCandidate(
        { name: "ペーパータオル エコタイプ 中判 200枚×30袋", capacity: "200枚×30袋（6000枚）", brand: "業務用（各社OEM）" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "ペーパータオル エコタイプ 中判 200枚入 × 30袋 ベクストミル 紙タオル 手拭き",
          price: 3970,
          url: "https://example.com/oem",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      expect(result.strictMatch).toBe(false); // "業務用" も "各社oem" も候補名にない
    });

    it("送り仮名ゆれ: 一般語のひらがな除去では strictMatch を通さない", () => {
      const result = evaluateYahooCandidate(
        { name: "ムーニー おしりふき やわらか素材", capacity: "76枚×32個", brand: "ムーニー" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "ムーニーおしりふき素材　76枚×8個入り×4パック",
          price: 3731,
          url: "https://example.com/f",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      expect(result.strictMatch).toBe(false);
    });

    it("サブトークン照合: brand「花王 ビオレ」/ candidate「花王ビオレ ボディソープ」で strictMatch: true", () => {
      // "花王 ビオレ"（スペースあり）は buildSearchKeyword で "花王 ビオレ" のまま保持されるため、
      // candidate "花王ビオレ"（スペースなし）に対して directBrandMatch が失敗する。
      // brandSubTokens ["花王", "ビオレ"] の両方が candidate に含まれるため subTokenBrandMatch で一致する。
      const result = evaluateYahooCandidate(
        { name: "ビオレ ボディソープ", capacity: "800mL", brand: "花王 ビオレ" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "花王ビオレ ボディソープ 800mL",
          price: 1200,
          url: "https://example.com/biore",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      // "花王 ビオレ" のサブトークン ["花王", "ビオレ"] が両方 candidate 名に含まれる → strictMatch: true
      expect(result.strictMatch).toBe(true);
    });

    it("サブトークン照合: brand「大王製紙」（1トークン）/ candidate「グーン」は strictMatch: false のまま", () => {
      const result = evaluateYahooCandidate(
        { name: "グーン 肌にやさしい おしりふき", capacity: "70枚×12個", brand: "大王製紙" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "グーン 肌にやさしい おしりふき 70枚×12P",
          price: 1800,
          url: "https://example.com/goon",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      // "大王製紙" はサブトークンが1つだけのため subTokenBrandMatch は不適用 → strictMatch: false
      expect(result.strictMatch).toBe(false);
    });

    it("括弧エイリアス: brand「株式会社P（S社）」/ candidate「S社 商品名」で strictMatch: true", () => {
      const result = evaluateYahooCandidate(
        { name: "S社 マルチクリーナー スプレー", capacity: "500mL", brand: "株式会社P（S社）" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "S社 マルチクリーナー スプレー 500mL",
          price: 800,
          url: "https://example.com/scorp",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      // 括弧エイリアス "S社" が candidate に含まれる → strictMatch: true
      expect(result.strictMatch).toBe(true);
    });

    it("括弧エイリアス: 英字・数字 alias「A1」が縮小されずに照合できる", () => {
      const result = evaluateYahooCandidate(
        { name: "A1 プレミアムウォッシュ 500mL", capacity: "500mL", brand: "ブランド（A1）" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "A1 プレミアムウォッシュ 500mL",
          price: 1000,
          url: "https://example.com/a1",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      // 括弧エイリアス "A1" が candidate に含まれる → strictMatch: true
      // normalizeBrandToken を通すと単一英字が除去されるが、括弧 alias は trim+toLowerCase のみなので "a1" が残る
      expect(result.strictMatch).toBe(true);
    });

    it("Step 3 固有語フォールバック: brand 不一致でも固有語（6文字以上・非汎用語）で strictMatch: true", () => {
      // brand "UNKNOWNBRAND" は候補名にない。
      // "スポットエイド"（8文字、GENERIC_PRODUCT_TOKENS 非該当）が候補に含まれる
      // → distinctiveProductTokenMatch = true → strictMatch: true
      const result = evaluateYahooCandidate(
        { name: "スポットエイド ニキビパッチ", capacity: "56枚", brand: "UNKNOWNBRAND" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "スポットエイド ニキビパッチ 56枚",
          price: 800,
          url: "https://example.com/spotaid",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      expect(result.strictMatch).toBe(true);
      // distinctiveProductToken で解消されているため brandFailureReason は出ない
      expect(result.brandFailureReason).toBeUndefined();
    });

    it("Step 3 汎用語ガード: 肌にやさしい（GENERIC_PRODUCT_TOKENS）は固有語フォールバックに使わない", () => {
      // brand "大王製紙" は候補名にない。
      // "肌にやさしい"（6文字）は GENERIC_PRODUCT_TOKENS に含まれるため除外
      // → distinctiveProductTokenMatch = false → strictMatch: false のまま
      const result = evaluateYahooCandidate(
        { name: "グーン 肌にやさしい おしりふき", capacity: "70枚×12個", brand: "大王製紙" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "グーン 肌にやさしい おしりふき 70枚×12P",
          price: 1800,
          url: "https://example.com/goon3",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      expect(result.strictMatch).toBe(false);
      // brand 失敗かつ distinctiveToken もなし → brandFailureReason が出る
      expect(result.brandFailureReason).toBeDefined();
    });

    it("Step 3 汎用語ガード: ペーパータオル（GENERIC_PRODUCT_TOKENS）は固有語フォールバックに使わない", () => {
      // brand "業務用（各社OEM）" は候補名にない。
      // "ペーパータオル"（7文字）は GENERIC_PRODUCT_TOKENS に含まれるため除外
      // → distinctiveProductTokenMatch = false → strictMatch: false のまま
      const result = evaluateYahooCandidate(
        {
          name: "ペーパータオル エコタイプ 中判 200枚×30袋",
          capacity: "200枚×30袋（6000枚）",
          brand: "業務用（各社OEM）",
        },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "ペーパータオル エコタイプ 中判 200枚入 × 30袋 ベクストミル 紙タオル 手拭き",
          price: 3970,
          url: "https://example.com/oem2",
          imageUrl: null,
          available: true,
          sellerName: null,
        }
      );
      expect(result.ok).toBe(true);
      expect(result.strictMatch).toBe(false);
    });

    it("capacity 不一致 → ok: false", () => {
      const result = evaluateYahooCandidate(baseProduct, {
        provider: "yahoo",
        label: "Yahoo!",
        name: "グーン 肌にやさしい おしりふき 70枚×10個",
        price: 1500,
        url: "https://example.com/d",
        imageUrl: null,
        available: true,
        sellerName: null,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("capacity不一致");
    });
  });

  describe("extractUrlQuantityMultiplier", () => {
    it("ValueCommerce vc_url の x6 サフィックスから 6 を返す", () => {
      const url =
        "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=xxx&pid=yyy&vc_url=" +
        encodeURIComponent("https://store.shopping.yahoo.co.jp/sundrugec/4902011743081x6.html");
      expect(extractUrlQuantityMultiplier(url)).toBe(6);
    });

    it("x サフィックスなし URL では 1 を返す", () => {
      const url =
        "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=xxx&pid=yyy&vc_url=" +
        encodeURIComponent("https://store.shopping.yahoo.co.jp/v-drug/4902011743081.html");
      expect(extractUrlQuantityMultiplier(url)).toBe(1);
    });

    it("ハイフン区切り（v-drug 系）でも誤検知しない", () => {
      const url =
        "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=xxx&pid=yyy&vc_url=" +
        encodeURIComponent("https://store.shopping.yahoo.co.jp/v-drug/0270030-4902011743081-1.html");
      expect(extractUrlQuantityMultiplier(url)).toBe(1);
    });

    it("x1 は倍率 1 として扱う（>= 2 のみ有効）", () => {
      const url = "https://store.shopping.yahoo.co.jp/store/4902011743081x1.html";
      expect(extractUrlQuantityMultiplier(url)).toBe(1);
    });
  });

  describe("evaluateYahooCandidate — URL 倍率", () => {
    const baseUrl =
      "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=xxx&pid=yyy&vc_url=" +
      encodeURIComponent("https://store.shopping.yahoo.co.jp/sundrugec/4902011743081x6.html");

    it("楽天 14枚 / Yahoo名 14枚 / URL x6 → ok: false（84枚 vs 14枚）", () => {
      const result = evaluateYahooCandidate(
        { name: "グーン スーパーBIG パンツ", capacity: "14枚", brand: "大王製紙（グーン）" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "グーン スーパーBIG パンツ 14枚 スーパービッグ",
          price: 7681,
          url: baseUrl,
          imageUrl: null,
          available: true,
          sellerName: "sundrugec",
        }
      );
      expect(result.ok).toBe(false);
      expect(result.urlMultiplier).toBe(6);
    });

    it("楽天 14枚×6個 / Yahoo名 14枚 / URL x6 → ok: true（84枚 vs 84枚）", () => {
      const result = evaluateYahooCandidate(
        { name: "グーン スーパーBIG パンツ ケース販売", capacity: "14枚×6個", brand: "大王製紙（グーン）" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "グーン スーパーBIG パンツ 14枚",
          price: 7681,
          url: baseUrl,
          imageUrl: null,
          available: true,
          sellerName: "sundrugec",
        }
      );
      expect(result.ok).toBe(true);
    });

    it("URL x6 / Yahoo名に既に ×6 含む → 二重計算しない（84枚 vs 14枚 → ok: false）", () => {
      const result = evaluateYahooCandidate(
        { name: "グーン スーパーBIG パンツ", capacity: "14枚", brand: "大王製紙（グーン）" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "グーン スーパーBIG パンツ 14枚×6個",
          price: 7681,
          url: baseUrl,
          imageUrl: null,
          available: true,
          sellerName: "sundrugec",
        }
      );
      expect(result.ok).toBe(false);
    });

    it("URL x{N} なし → 既存動作を維持", () => {
      const singleUrl =
        "https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=xxx&pid=yyy&vc_url=" +
        encodeURIComponent("https://store.shopping.yahoo.co.jp/v-drug/4902011743081.html");
      const result = evaluateYahooCandidate(
        { name: "グーン スーパーBIG パンツ", capacity: "14枚", brand: "大王製紙（グーン）" },
        {
          provider: "yahoo",
          label: "Yahoo!",
          name: "グーン スーパーBIG パンツ 14枚",
          price: 1254,
          url: singleUrl,
          imageUrl: null,
          available: true,
          sellerName: "v-drug",
        }
      );
      expect(result.ok).toBe(true);
      expect(result.urlMultiplier).toBe(1);
    });
  });
});
