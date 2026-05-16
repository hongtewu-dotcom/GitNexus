/**
 * Shepherd Gateway Route Resolver
 *
 * Fetches route configuration from Meituan's Shepherd API gateway platform
 * and produces HTTP provider contracts for the gateway repo. This enables
 * proper frontend → gateway → backend cross-link matching.
 *
 * The Shepherd API returns XML with all configured routes for a given group,
 * including request path, HTTP method, domain, and filter chain. Each route
 * becomes a provider contract assigned to the gateway repo in the group.
 *
 * Architecture:
 *   Frontend consumer (e.g. `/m/qos/booking/insert`)
 *     ↓ matches via contractId
 *   Gateway provider (from Shepherd config)
 *     ↓ same path, links to
 *   Backend provider (from Controller scan)
 *
 * Authentication: Shepherd API requires SSO cookie. The resolver supports:
 *   1. Cookie passed directly via config (group.yaml `shepherd.cookie`)
 *   2. Cookie file path (group.yaml `shepherd.cookie_file`)
 *   3. CatDesk auth exchange (catdesk auth exchange — SSO token via CatPaw Desk)
 *   4. Browser-based auto-fetch (catdesk browser-action)
 *   5. Cached response file for offline/CI usage
 *
 * Multi-group: The resolver supports fetching routes from multiple Shepherd groups
 * in a single sync pass, merging contracts from all groups.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeHttpPath } from './http-route-extractor.js';
import type { ExtractedContract } from '../types.js';
import { logger } from '../../logger.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ShepherdRoute {
  apiName: string;
  path: string;
  methodType: string;
  domain: string;
  timeout: number;
  /** Whether this is a wildcard route (path contains `**`) */
  isWildcard: boolean;
}

export interface ShepherdConfig {
  /** Shepherd API group name (e.g. 'flight-m') */
  group: string;
  /** The repo path in the group config that represents the gateway (e.g. 'api/gateway') */
  gateway_repo?: string;
  /** Direct SSO cookie value */
  cookie?: string;
  /** Path to file containing SSO cookie */
  cookie_file?: string;
  /** Path to cached XML response file (for offline/CI) */
  cache_file?: string;
  /** Cache TTL in seconds (default: 3600 = 1 hour) */
  cache_ttl?: number;
}

export interface ShepherdResolveResult {
  routes: ShepherdRoute[];
  contracts: ExtractedContract[];
  fetchTimeMs: number;
  fromCache: boolean;
  /** When resolving multiple groups, per-group breakdown */
  groupResults?: Array<{ group: string; routes: number; contracts: number; fromCache: boolean }>;
}

// ─── XML Parsing ────────────────────────────────────────────────────

/**
 * Parse Shepherd XML response into structured route objects.
 * The XML format is:
 * ```xml
 * <Result>
 *   <code>0</code>
 *   <data>
 *     <apiBriefInfos>
 *       <apiBriefInfos>
 *         <apiName>...</apiName>
 *         <request>
 *           <path>/m/xxx</path>
 *           <methodType>post</methodType>
 *           <domain>gateway-flight.sankuai.com</domain>
 *           <timeout>3000</timeout>
 *         </request>
 *       </apiBriefInfos>
 *     </apiBriefInfos>
 *   </data>
 * </Result>
 * ```
 */
export function parseShepherdXml(xmlText: string): ShepherdRoute[] {
  const routes: ShepherdRoute[] = [];

  // Use regex-based extraction since we don't want to add an XML parser dependency.
  // Each <apiBriefInfos> block within the outer <apiBriefInfos> is one route.
  const apiBlockRegex =
    /<apiBriefInfos>\s*<errMsg[^>]*\/?>([^<]*(?:<\/errMsg>)?)\s*<apiName>([^<]+)<\/apiName>([\s\S]*?)<\/apiBriefInfos>/g;

  let match: RegExpExecArray | null;
  while ((match = apiBlockRegex.exec(xmlText)) !== null) {
    const errMsg = match[1].replace(/<\/errMsg>/, '').trim();
    const apiName = match[2].trim();
    const body = match[3];

    // Skip unpublished APIs (those with errMsg)
    if (errMsg && errMsg.length > 0) continue;

    // Extract request fields
    const pathMatch = body.match(/<path>([^<]+)<\/path>/);
    const methodMatch = body.match(/<methodType>([^<]+)<\/methodType>/);
    const domainMatch = body.match(/<domain>([^<]+)<\/domain>/);
    const timeoutMatch = body.match(/<timeout>([^<]+)<\/timeout>/);

    if (!pathMatch) continue;

    const routePath = pathMatch[1].trim();
    const methodType = methodMatch?.[1]?.trim() || '*';
    const domain = domainMatch?.[1]?.trim() || '';
    const timeout = parseInt(timeoutMatch?.[1] || '3000', 10);
    const isWildcard = routePath.includes('**');

    routes.push({
      apiName,
      path: routePath,
      methodType: methodType.toUpperCase(),
      domain,
      timeout,
      isWildcard,
    });
  }

  return routes;
}

// ─── Fetching ───────────────────────────────────────────────────────

const SHEPHERD_API_BASE = 'http://shepherd.sankuai.com/apis/info/by/group';
const DEFAULT_CACHE_TTL = 3600; // 1 hour

interface CacheEntry {
  fetchedAt: number;
  xmlText: string;
}

/**
 * Fetch route configuration from Shepherd API.
 * Supports multiple auth strategies and caching.
 */
async function fetchShepherdRoutes(config: ShepherdConfig, groupDir: string): Promise<{ xml: string; fromCache: boolean }> {
  const cachePath = config.cache_file
    ? path.resolve(config.cache_file)
    : path.join(groupDir, '.shepherd-cache', `${config.group}.xml`);

  const cacheTtl = (config.cache_ttl ?? DEFAULT_CACHE_TTL) * 1000;

  // 1. Try cache first
  try {
    const cacheMetaPath = cachePath + '.meta.json';
    const metaRaw = await fs.readFile(cacheMetaPath, 'utf-8');
    const meta: CacheEntry = JSON.parse(metaRaw);
    if (Date.now() - meta.fetchedAt < cacheTtl) {
      const xml = await fs.readFile(cachePath, 'utf-8');
      if (xml.includes('<apiBriefInfos>')) {
        return { xml, fromCache: true };
      }
    }
  } catch {
    // Cache miss or invalid — proceed to fetch
  }

  // 2. Resolve SSO cookie
  let cookie = config.cookie || '';
  if (!cookie && config.cookie_file) {
    try {
      cookie = (await fs.readFile(path.resolve(config.cookie_file), 'utf-8')).trim();
    } catch {
      logger.warn(`[shepherd] Could not read cookie_file: ${config.cookie_file}`);
    }
  }

  // 3. Try direct HTTP fetch with cookie
  const url = `${SHEPHERD_API_BASE}?group=${encodeURIComponent(config.group)}`;
  let xml = '';

  if (cookie) {
    try {
      const response = await fetch(url, {
        headers: { Cookie: cookie },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        xml = await response.text();
      }
    } catch (err) {
      logger.warn(`[shepherd] Direct fetch failed: ${(err as Error).message}`);
    }
  }

  // 3.5. Fallback: try catdesk auth exchange (SSO token via CatPaw Desk key)
  if (!xml || !xml.includes('<apiBriefInfos>')) {
    try {
      const exchangedCookie = await fetchCookieViaCatdeskExchange();
      if (exchangedCookie) {
        const response = await fetch(url, {
          headers: { Cookie: exchangedCookie },
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) {
          xml = await response.text();
        }
      }
    } catch (err) {
      logger.warn(`[shepherd] Catdesk auth exchange failed: ${(err as Error).message}`);
    }
  }

  // 4. Fallback: try catdesk browser-action (if available)
  if (!xml || !xml.includes('<apiBriefInfos>')) {
    try {
      xml = await fetchViaBrowser(url);
    } catch (err) {
      logger.warn(`[shepherd] Browser fetch failed: ${(err as Error).message}`);
    }
  }

  // 5. Final fallback: try reading stale cache
  if (!xml || !xml.includes('<apiBriefInfos>')) {
    try {
      xml = await fs.readFile(cachePath, 'utf-8');
      if (xml.includes('<apiBriefInfos>')) {
        logger.info('[shepherd] Using stale cache (fresh fetch failed)');
        return { xml, fromCache: true };
      }
    } catch {
      // No stale cache available
    }
    throw new Error(
      `[shepherd] Could not fetch routes for group "${config.group}". ` +
      'Provide a valid SSO cookie via shepherd.cookie or shepherd.cookie_file in group.yaml, ' +
      'or ensure catdesk browser is available with an active login session.',
    );
  }

  // 6. Write to cache
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, xml, 'utf-8');
    await fs.writeFile(
      cachePath + '.meta.json',
      JSON.stringify({ fetchedAt: Date.now(), xmlText: '' } satisfies CacheEntry),
      'utf-8',
    );
  } catch {
    // Non-fatal cache write failure
  }

  return { xml, fromCache: false };
}

/**
 * Attempt to obtain SSO cookie via catdesk auth exchange.
 * This uses the CatPaw Desk token-exchange mechanism to get a valid SSO cookie
 * without requiring an active browser session.
 */
async function fetchCookieViaCatdeskExchange(): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileP = promisify(execFile);

    const { stdout } = await execFileP(
      'catdesk',
      ['auth', 'exchange', '--format', 'cookie', '--target', 'shepherd.sankuai.com'],
      { timeout: 10000 },
    );
    const cookie = stdout.trim();
    if (cookie && cookie.length > 10) {
      return cookie;
    }
    return null;
  } catch {
    // catdesk auth exchange not available or failed — graceful degradation
    return null;
  }
}

/**
 * Fetch Shepherd page content via catdesk browser-action.
 * Requires catdesk CLI and an active browser session with SSO login.
 *
 * The Shepherd XML response can be ~300KB+ which exceeds the single
 * browser-action evaluate response limit (~8KB). We use a chunked
 * extraction strategy: store the content in a global variable, then
 * read it in base64-encoded segments.
 */
async function fetchViaBrowser(url: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);

  const CHUNK_SIZE = 4000; // characters per chunk (safe under 8KB after base64)

  // Navigate to the URL
  const navCmd = JSON.stringify({ action: 'navigate', url });
  await execFileP('catdesk', ['browser-action', navCmd], { timeout: 20000 });

  // Store full text + get total length
  const initScript = `
    window.__shpText = document.body.innerText;
    window.__shpLen = window.__shpText.length;
    window.__shpLen;
  `;
  const initCmd = JSON.stringify({ action: 'evaluate', script: initScript });
  const { stdout: initOut } = await execFileP('catdesk', ['browser-action', initCmd], { timeout: 15000 });
  const initResult = JSON.parse(initOut);
  if (!initResult.success) {
    throw new Error(`Browser init failed: ${initResult.error}`);
  }

  const totalLen = parseInt(String(initResult.data?.result || '0'), 10);
  if (totalLen === 0) return '';

  // Read in chunks via base64 to avoid JSON escaping issues
  const totalChunks = Math.ceil(totalLen / CHUNK_SIZE);
  const chunks: string[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const chunkScript = `btoa(unescape(encodeURIComponent(window.__shpText.substr(${offset}, ${CHUNK_SIZE}))))`;
    const chunkCmd = JSON.stringify({ action: 'evaluate', script: chunkScript });
    const { stdout } = await execFileP('catdesk', ['browser-action', chunkCmd], { timeout: 10000 });
    const chunkResult = JSON.parse(stdout);
    if (!chunkResult.success) {
      throw new Error(`Browser chunk ${i}/${totalChunks} failed: ${chunkResult.error}`);
    }
    const b64 = chunkResult.data?.result || '';
    // Decode base64 → UTF-8
    chunks.push(Buffer.from(b64, 'base64').toString('utf-8'));
  }

  // Cleanup global
  const cleanupCmd = JSON.stringify({
    action: 'evaluate',
    script: 'delete window.__shpText; delete window.__shpLen; "ok"',
  });
  await execFileP('catdesk', ['browser-action', cleanupCmd], { timeout: 5000 }).catch(() => {});

  return chunks.join('');
}

// ─── Contract Generation ────────────────────────────────────────────

/**
 * Convert Shepherd routes into ExtractedContract provider entries.
 * Each route becomes a provider contract attached to the gateway repo.
 *
 * Wildcard routes (paths ending with `/**`) are handled in two tiers:
 *   1. If a wildcard prefix already has specific sub-routes registered
 *      (e.g. `/m/price/**` with `/m/price/query`, `/m/price/decode`),
 *      the wildcard is skipped — the specific routes provide better matches.
 *   2. If a wildcard is the ONLY route for its prefix (e.g. `/m/auth/**`
 *      with no `/m/auth/xxx` siblings), it IS included. The `/**` suffix
 *      is stripped and the contract is registered as a prefix provider
 *      (`http::METHOD::/m/auth`) so that consumer paths like `/m/auth/login`
 *      can match via the prefix matching logic in findMatchingKeys.
 */
function routesToContracts(routes: ShepherdRoute[], shepherdGroup: string): ExtractedContract[] {
  const contracts: ExtractedContract[] = [];
  const seen = new Set<string>();

  // Collect all non-wildcard path prefixes so we can decide which wildcards
  // are redundant vs. sole-coverage.
  const exactPrefixes = new Set<string>();
  for (const route of routes) {
    if (!route.isWildcard) {
      exactPrefixes.add(route.path);
    }
  }

  for (const route of routes) {
    if (route.isWildcard) {
      // Check if any non-wildcard route shares this prefix
      const prefix = route.path.replace(/\/?\*\*$/, '');
      const hasCoverage = routes.some(
        (r) => !r.isWildcard && r.path.startsWith(prefix + '/'),
      );
      if (hasCoverage) continue; // specific sub-routes already cover this prefix
    }

    // For wildcard routes, normalize by stripping the /** suffix
    const rawPath = route.isWildcard
      ? route.path.replace(/\/?\*\*$/, '')
      : route.path;
    const normalized = normalizeHttpPath(rawPath);

    // Some routes have comma-separated methods like "POST,GET".
    // Split them into individual contracts so each method gets its own match.
    // Exception: wildcard prefix routes (from `/**`) act as gateway forwards —
    // they accept any HTTP method, so we force method=* for matching purposes.
    const rawMethod = route.isWildcard ? '*' : (route.methodType || '*');
    const methods = rawMethod.includes(',')
      ? rawMethod.split(',').map(m => m.trim()).filter(Boolean)
      : [rawMethod];

    for (const method of methods) {
      const contractId = `http::${method}::${normalized}`;

      // Deduplicate
      if (seen.has(contractId)) continue;
      seen.add(contractId);

      contracts.push({
        contractId,
        type: 'http',
        role: 'provider',
        symbolUid: `shepherd:${shepherdGroup}:${route.apiName}`,
        symbolRef: {
          filePath: `shepherd://${shepherdGroup}/${route.apiName}`,
          name: route.apiName,
        },
        symbolName: route.apiName,
        confidence: route.isWildcard ? 0.8 : 0.95,
        meta: {
          extractionStrategy: 'shepherd_gateway',
          shepherdGroup,
          apiName: route.apiName,
          domain: route.domain,
          timeout: route.timeout,
          originalPath: route.path,
          httpMethod: method,
          ...(route.isWildcard && { wildcardPrefix: true }),
        },
      });
    }
  }

  return contracts;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Resolve Shepherd gateway routes and produce provider contracts (single group).
 *
 * @param config - Shepherd configuration from group.yaml
 * @param groupDir - Path to the group directory (~/.gitnexus/groups/<name>/)
 * @returns Routes, contracts, and timing info
 */
export async function resolveShepherdRoutes(
  config: ShepherdConfig,
  groupDir: string,
): Promise<ShepherdResolveResult> {
  const start = Date.now();

  const { xml, fromCache } = await fetchShepherdRoutes(config, groupDir);
  const routes = parseShepherdXml(xml);
  const contracts = routesToContracts(routes, config.group);

  const fetchTimeMs = Date.now() - start;
  logger.info(
    `[shepherd] Resolved ${routes.length} routes (${contracts.length} contracts) ` +
    `for group "${config.group}" in ${fetchTimeMs}ms${fromCache ? ' (cached)' : ''}`,
  );

  return { routes, contracts, fetchTimeMs, fromCache };
}

/**
 * Resolve Shepherd gateway routes from multiple groups in one pass.
 * Merges contracts from all groups, deduplicating by contractId.
 * Groups are processed sequentially (each shares the same auth context).
 *
 * @param groups - Array of group names to resolve
 * @param baseConfig - Base Shepherd config (cookie, cache settings shared across groups)
 * @param groupDir - Path to the group directory (~/.gitnexus/groups/<name>/)
 * @returns Merged routes, contracts, timing, and per-group breakdown
 */
export async function resolveMultipleShepherdGroups(
  groups: string[],
  baseConfig: Omit<ShepherdConfig, 'group'>,
  groupDir: string,
): Promise<ShepherdResolveResult> {
  const start = Date.now();
  const allRoutes: ShepherdRoute[] = [];
  const allContracts: ExtractedContract[] = [];
  const seenContractIds = new Set<string>();
  const groupResults: Array<{ group: string; routes: number; contracts: number; fromCache: boolean }> = [];
  let anyFromCache = false;

  for (const group of groups) {
    try {
      const config: ShepherdConfig = { ...baseConfig, group };
      const { xml, fromCache } = await fetchShepherdRoutes(config, groupDir);
      const routes = parseShepherdXml(xml);
      const contracts = routesToContracts(routes, group);

      // Deduplicate: same contractId from different groups → keep first
      const newContracts = contracts.filter((c) => {
        if (seenContractIds.has(c.contractId)) return false;
        seenContractIds.add(c.contractId);
        return true;
      });

      allRoutes.push(...routes);
      allContracts.push(...newContracts);
      if (fromCache) anyFromCache = true;

      groupResults.push({
        group,
        routes: routes.length,
        contracts: newContracts.length,
        fromCache,
      });

      logger.info(
        `[shepherd] Group "${group}": ${routes.length} routes → ${newContracts.length} new contracts${fromCache ? ' (cached)' : ''}`,
      );
    } catch (err) {
      logger.warn(`[shepherd] Group "${group}" failed: ${(err as Error).message}`);
      groupResults.push({ group, routes: 0, contracts: 0, fromCache: false });
      // Non-fatal: continue with other groups
    }
  }

  const fetchTimeMs = Date.now() - start;
  logger.info(
    `[shepherd] Multi-group resolved: ${allRoutes.length} total routes, ` +
    `${allContracts.length} contracts from ${groups.length} groups in ${fetchTimeMs}ms`,
  );

  return {
    routes: allRoutes,
    contracts: allContracts,
    fetchTimeMs,
    fromCache: anyFromCache,
    groupResults,
  };
}
