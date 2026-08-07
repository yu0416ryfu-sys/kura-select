// Google Search Console 共通クライアント
//
// 【重要】このファイルは必ず .mjs（プレーンJS）のままにすること。
// scripts/mcp/gsc-mcp.mjs は .mcp.json から --experimental-strip-types なしで
// 起動されるため、ここを .ts にすると gsc MCP サーバーが起動不能になる。
//
// 認証鍵の解決順（CLI 単体実行でも動くようにするための5段）:
//   1. process.env.GSC_SERVICE_ACCOUNT_KEY
//   2. process.env.GOOGLE_APPLICATION_CREDENTIALS（MCP 経由はここで解決）
//   3. .env の GSC_SERVICE_ACCOUNT_KEY（CLI 実行時の主経路）
//   4. 既定パス ~/.config/kura-select/service-account.json
//   5. いずれも無ければエラー（OAuth へは落とさない）
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "../../.env");
const DEFAULT_KEY_PATH = path.join(
  os.homedir(),
  ".config",
  "kura-select",
  "service-account.json",
);

export const SITE_URL = "https://www.kura-select.com/";
export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

// GSC のデータ確定遅延（日）。当日・前日はデータが埋まらないため既定で3日戻す。
export const GSC_DATA_LAG_DAYS = 3;

let envLoaded = false;

// .env は既存の環境変数を上書きしうるので、1・2 で解決できなかったときだけ読む。
function loadEnvFileOnce() {
  if (envLoaded) return;
  envLoaded = true;
  if (!existsSync(ENV_PATH)) return;
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    // .env が読めなくても既定パスで解決できる可能性があるので握りつぶす
  }
}

/**
 * サービスアカウント鍵のパスを解決する。
 * @returns {{ keyFile: string, source: string } | null}
 */
export function resolveServiceAccountKey() {
  const direct = [
    ["GSC_SERVICE_ACCOUNT_KEY(env)", process.env.GSC_SERVICE_ACCOUNT_KEY],
    [
      "GOOGLE_APPLICATION_CREDENTIALS(env)",
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ],
  ];
  for (const [source, keyFile] of direct) {
    if (keyFile && existsSync(keyFile)) return { keyFile, source };
  }

  loadEnvFileOnce();
  const fromEnvFile = process.env.GSC_SERVICE_ACCOUNT_KEY;
  if (fromEnvFile && existsSync(fromEnvFile)) {
    return { keyFile: fromEnvFile, source: "GSC_SERVICE_ACCOUNT_KEY(.env)" };
  }

  if (existsSync(DEFAULT_KEY_PATH)) {
    return { keyFile: DEFAULT_KEY_PATH, source: "既定パス" };
  }

  return null;
}

export function missingKeyMessage() {
  return [
    "GSC のサービスアカウント鍵が見つかりません。次のいずれかを設定してください:",
    "  1. 環境変数 GSC_SERVICE_ACCOUNT_KEY に鍵ファイルのフルパス",
    "  2. 環境変数 GOOGLE_APPLICATION_CREDENTIALS に鍵ファイルのフルパス",
    "  3. .env に GSC_SERVICE_ACCOUNT_KEY=<鍵ファイルのフルパス> を追記",
    `  4. 既定パスに配置: ${DEFAULT_KEY_PATH}`,
    "（鍵の発行手順は docs/AI_OPERATIONS.md / メモ project_ga4_gsc_service_account を参照）",
  ].join("\n");
}

/**
 * GSC API 用の認証クライアントを返す。
 * @param {{ oauthFallback?: () => Promise<any> }} [options]
 *   oauthFallback を渡した場合のみ、鍵が無いときにそれを呼ぶ（MCP 側の従来挙動維持用）。
 *   CLI からは渡さない＝鍵が無ければ即エラー終了させる。
 */
export async function getGscAuth(options = {}) {
  const resolved = resolveServiceAccountKey();
  if (resolved) {
    const auth = new google.auth.GoogleAuth({
      keyFile: resolved.keyFile,
      scopes: SCOPES,
    });
    return auth.getClient();
  }

  if (typeof options.oauthFallback === "function") {
    return options.oauthFallback();
  }

  throw new Error(missingKeyMessage());
}

/**
 * Search Analytics を1回叩く（生の rows を返す）。
 */
export async function querySearchAnalytics(auth, params) {
  const {
    startDate,
    endDate,
    dimensions,
    rowLimit = 1000,
    startRow = 0,
    filterPage,
    siteUrl = SITE_URL,
  } = params;

  const requestBody = { startDate, endDate, dimensions, rowLimit, startRow };
  if (filterPage) {
    requestBody.dimensionFilterGroups = [
      {
        filters: [
          { dimension: "page", operator: "equals", expression: filterPage },
        ],
      },
    ];
  }

  const webmasters = google.webmasters({ version: "v3", auth });
  const res = await webmasters.searchanalytics.query({ siteUrl, requestBody });
  return res.data.rows ?? [];
}

/**
 * Search Analytics を startRow でページングして全件取得する。
 */
export async function fetchAllSearchAnalytics(auth, params) {
  const pageSize = params.pageSize ?? 5000;
  const maxRows = params.maxRows ?? 25000;
  const all = [];

  for (let startRow = 0; startRow < maxRows; startRow += pageSize) {
    const rows = await querySearchAnalytics(auth, {
      ...params,
      rowLimit: Math.min(pageSize, maxRows - startRow),
      startRow,
    });
    all.push(...rows);
    if (rows.length < pageSize) break;
  }

  return all;
}

/** YYYY-MM-DD 形式に整形 */
export function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * GSC の反映遅延を考慮した期間を返す。
 * @param {number} days 取得日数
 * @param {number} [lagDays] 遅延日数（既定 GSC_DATA_LAG_DAYS）
 */
export function resolveDateRange(days, lagDays = GSC_DATA_LAG_DAYS) {
  const end = new Date();
  end.setDate(end.getDate() - lagDays);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { startDate: toDateString(start), endDate: toDateString(end) };
}
