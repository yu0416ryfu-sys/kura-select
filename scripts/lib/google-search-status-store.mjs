// Google 検索ステータスの取得と履歴ファイル（data/google-search-status.json）の読み書き
//
// 取得に失敗しても週次スナップショットやベースライン保存は止めない（保存分で判定し、その旨を残す）。
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  STATUS_DASHBOARD_URL,
  STATUS_INCIDENTS_URL,
  mergeIncidents,
  normalizeIncidents,
} from './google-search-status.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SEARCH_STATUS_PATH = path.resolve(__dirname, '../../data/google-search-status.json');

const README =
  'Google 検索ステータス ダッシュボード（' +
  STATUS_DASHBOARD_URL +
  '）の告知の履歴。pnpm search-status で incidents.json を取得して id ごとに追記・上書きする（ダッシュボードは約1年分しか返さないため、消えた分もここに残す）。' +
  '手で編集しない。測定窓との重なりの扱いは CLAUDE.md §5.0.2 ルール6。';

export function readSearchStatusLog(filePath = SEARCH_STATUS_PATH) {
  if (!existsSync(filePath)) return { updatedAt: null, source: STATUS_INCIDENTS_URL, readme: README, incidents: [] };
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export async function fetchSearchStatusIncidents({ timeoutMs = 15000 } = {}) {
  const response = await fetch(STATUS_INCIDENTS_URL, {
    headers: { 'User-Agent': 'kura-select-analytics/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`incidents.json の取得に失敗しました（HTTP ${response.status}）`);
  return normalizeIncidents(await response.json());
}

/**
 * 取得して履歴にマージする。offline なら保存分だけ返す。
 * 戻り値: { available, source: 'live' | 'cache', error?, incidents, fetchedAt? }
 */
export async function loadSearchStatus({ offline = false, write = true, filePath = SEARCH_STATUS_PATH } = {}) {
  const log = readSearchStatusLog(filePath);
  if (offline) {
    return { available: log.incidents.length > 0, source: 'cache', error: log.incidents.length ? undefined : '保存分がありません', incidents: log.incidents };
  }
  try {
    const fetched = await fetchSearchStatusIncidents();
    const incidents = mergeIncidents(log.incidents, fetched);
    const fetchedAt = new Date().toISOString();
    // 中身が変わったときだけ書く（毎週の実行で updatedAt だけの差分を出さない）
    const changed = JSON.stringify(incidents) !== JSON.stringify(log.incidents);
    if (write && changed) {
      writeFileSync(
        filePath,
        `${JSON.stringify({ updatedAt: fetchedAt, source: STATUS_INCIDENTS_URL, readme: README, incidents }, null, 2)}\n`,
        'utf8',
      );
    }
    return { available: true, source: 'live', incidents, fetchedAt };
  } catch (error) {
    if (log.incidents.length > 0) {
      return { available: true, source: 'cache', error: error.message, incidents: log.incidents };
    }
    return { available: false, source: 'cache', error: error.message, incidents: [] };
  }
}
