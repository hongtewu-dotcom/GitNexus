import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { initLbug, closeLbug, executeParameterized } from '../lbug/pool-adapter.js';
import { readRegistry, type RegistryEntry } from '../../storage/repo-manager.js';
import type { GroupConfig, RepoHandle, RepoSnapshot, StoredContract, CrossLink, ShepherdDetectConfig } from './types.js';
import { HttpRouteExtractor } from './extractors/http-route-extractor.js';
import { GrpcExtractor } from './extractors/grpc-extractor.js';
import { ThriftExtractor } from './extractors/thrift-extractor.js';
import { TopicExtractor } from './extractors/topic-extractor.js';
import { IncludeExtractor } from './extractors/include-extractor.js';
import { MafkaPropertiesExtractor } from './extractors/mafka-properties-extractor.js';
import { ExternalIoExtractor } from './extractors/external-io-extractor.js';
import { HttpConsumerExtractor } from './extractors/http-consumer-extractor.js';
import { CraneExtractor } from './extractors/crane-extractor.js';
import { SquirrelExtractor } from './extractors/squirrel-extractor.js';
import { DbusExtractor } from './extractors/dbus-extractor.js';
import { ManifestExtractor } from './extractors/manifest-extractor.js';
import { discoverWorkspaceLinks } from './extractors/workspace-extractor.js';
import { resolveShepherdRoutes, resolveMultipleShepherdGroups, type ShepherdConfig } from './extractors/shepherd-route-resolver.js';
import { buildProviderIndex, runExactMatch, runWildcardMatch } from './matching.js';
import { filterContracts } from './post-filter.js';
import { detectServiceBoundaries, assignService } from './service-boundary-detector.js';
import type { CypherExecutor } from './contract-extractor.js';
import { writeContractRegistry } from './storage.js';
import { writeBridge } from './bridge-db.js';
import type { ContractRegistry } from './types.js';

import { logger } from '../logger.js';
export interface SyncOptions {
  extractorOverride?:
    | ((repo: RepoHandle) => Promise<StoredContract[]>)
    | (() => Promise<StoredContract[]>);
  resolveRepoHandle?: (registryName: string, groupPath: string) => Promise<RepoHandle | null>;
  skipWrite?: boolean;
  groupDir?: string;
  allowStale?: boolean;
  verbose?: boolean;
  exactOnly?: boolean;
  skipEmbeddings?: boolean;
}

export interface SyncResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
  unmatched: StoredContract[];
  missingRepos: string[];
  repoSnapshots: Record<string, RepoSnapshot>;
}

export function stableRepoPoolId(entry: RegistryEntry, allEntries: RegistryEntry[]): string {
  const base = entry.name.toLowerCase();
  const resolved = path.resolve(entry.path);
  for (const other of allEntries) {
    if (other.name.toLowerCase() === base && path.resolve(other.path) !== resolved) {
      const hash = Buffer.from(entry.path).toString('base64url').slice(0, 6);
      return `${base}-${hash}`;
    }
  }
  return base;
}

function defaultResolveHandle(allEntries: RegistryEntry[]) {
  return async (registryName: string, groupPath: string): Promise<RepoHandle | null> => {
    const e = allEntries.find((en) => en.name === registryName);
    if (!e) return null;
    const poolId = stableRepoPoolId(e, allEntries);
    return {
      id: poolId,
      path: groupPath,
      repoPath: e.path,
      storagePath: e.storagePath,
    };
  };
}

/**
 * Dedupe cross-links that point from the same consumer endpoint to the same
 * provider endpoint for the same contract. Preserves first-seen order so the
 * caller controls precedence (e.g., pass manifest links first).
 */
function dedupeCrossLinks(links: CrossLink[]): CrossLink[] {
  const seen = new Set<string>();
  const out: CrossLink[] = [];
  for (const link of links) {
    const key = `${link.from.repo}::${link.from.symbolUid}|${link.to.repo}::${link.to.symbolUid}|${link.type}|${link.contractId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

/**
 * Resolve the list of shepherd group names from a ShepherdDetectConfig.
 * Supports:
 *   - `group: "flight-m"` → single group
 *   - `group: ["flight-m", "flight-b"]` → multi-group via group field
 *   - `groups: ["flight-m", "flight-b"]` → multi-group via explicit field (takes precedence)
 */
function resolveShepherdGroupNames(raw: ShepherdDetectConfig): string[] {
  if (raw.groups && raw.groups.length > 0) return raw.groups;
  if (!raw.group) return [];
  if (Array.isArray(raw.group)) return raw.group;
  return [raw.group];
}

/**
 * Normalize the `detect.shepherd` config value into shepherd resolution params.
 * Returns { groups, baseConfig, gatewayRepo } for use with multi-group resolver.
 *
 * Supports:
 *   - `true` → tries to infer group name from the group config name
 *   - `{ group: 'flight-m', ... }` → single group
 *   - `{ group: ['flight-m', 'flight-b'], ... }` → multi-group
 *   - `{ groups: ['flight-m', 'flight-b'], ... }` → multi-group (explicit)
 *   - `[{ group: 'flight-m' }, { group: 'flight-b' }]` → array of configs
 */
function normalizeShepherdConfig(
  raw: ShepherdDetectConfig | ShepherdDetectConfig[] | boolean,
  groupConfig: GroupConfig,
): { groups: string[]; baseConfig: Omit<ShepherdConfig, 'group'>; gatewayRepo: string } | null {
  if (raw === false) return null;

  const defaultGatewayRepo = Object.keys(groupConfig.repos).find(
    (k) => k.includes('gateway') || k.includes('shepherd'),
  ) || 'api/gateway';

  if (raw === true) {
    // Auto-infer: use group config name as the single shepherd group
    return {
      groups: [groupConfig.name],
      baseConfig: { gateway_repo: defaultGatewayRepo },
      gatewayRepo: defaultGatewayRepo,
    };
  }

  // Array of separate configs → merge groups, use first config's auth settings
  if (Array.isArray(raw)) {
    const allGroups: string[] = [];
    for (const item of raw) {
      allGroups.push(...resolveShepherdGroupNames(item));
    }
    const first = raw[0];
    return {
      groups: allGroups,
      baseConfig: {
        gateway_repo: first.gateway_repo || defaultGatewayRepo,
        cookie: first.cookie,
        cookie_file: first.cookie_file,
        cache_file: first.cache_file,
        cache_ttl: first.cache_ttl,
      },
      gatewayRepo: first.gateway_repo || defaultGatewayRepo,
    };
  }

  // Single config object (possibly with multiple groups)
  const groups = resolveShepherdGroupNames(raw);
  return {
    groups,
    baseConfig: {
      gateway_repo: raw.gateway_repo || defaultGatewayRepo,
      cookie: raw.cookie,
      cookie_file: raw.cookie_file,
      cache_file: raw.cache_file,
      cache_ttl: raw.cache_ttl,
    },
    gatewayRepo: raw.gateway_repo || defaultGatewayRepo,
  };
}

export async function syncGroup(config: GroupConfig, opts?: SyncOptions): Promise<SyncResult> {
  const missingRepos: string[] = [];
  const repoSnapshots: Record<string, RepoSnapshot> = {};
  let autoContracts: StoredContract[] = [];
  let manifestCrossLinks: CrossLink[] = [];
  let dbExecutors: Map<string, CypherExecutor> | undefined;
  let registryEntries: RegistryEntry[] | undefined;

  const eo = opts?.extractorOverride;
  if (eo && eo.length === 0) {
    autoContracts = await (eo as () => Promise<StoredContract[]>)();
  } else {
    registryEntries = await readRegistry();
    const entries = registryEntries;
    const resolve = opts?.resolveRepoHandle ?? defaultResolveHandle(entries);
    const httpEx = new HttpRouteExtractor();
    const grpcEx = new GrpcExtractor();
    const thriftEx = new ThriftExtractor();
    const topicEx = new TopicExtractor();
    const includeEx = new IncludeExtractor();
    const mafkaEx = new MafkaPropertiesExtractor();
    const externalIoEx = new ExternalIoExtractor();
    const httpConsumerEx = new HttpConsumerExtractor();
    const craneEx = new CraneExtractor();
    const squirrelEx = new SquirrelExtractor();
    const dbusEx = new DbusExtractor();
    dbExecutors = new Map<string, CypherExecutor>();
    const openPoolIds: string[] = [];
    // tableName (lowercase) → set of repos that write it, collected while each
    // repo's connection pool is still open. Used by deriveDbusWriteSides below.
    const tableToWriteRepos = new Map<string, Set<string>>();

    try {
      for (const [groupPath, regName] of Object.entries(config.repos)) {
        const handle = await resolve(regName, groupPath);
        if (!handle) {
          missingRepos.push(groupPath);
          continue;
        }

        const poolId = handle.id;
        const lbugPath = path.join(handle.storagePath, 'lbug');
        try {
          await initLbug(poolId, lbugPath);
          openPoolIds.push(poolId);

          const executor: CypherExecutor = (query, params) =>
            executeParameterized(poolId, query, params ?? {});

          dbExecutors.set(groupPath, executor);

          const boundaries = await detectServiceBoundaries(handle.repoPath);

          if (config.detect.http) {
            const extracted = await httpEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.grpc) {
            const extracted = await grpcEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.thrift) {
            const extracted = await thriftEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.topics) {
            const extracted = await topicEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.includes) {
            const extracted = await includeEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          // Mafka properties extraction (complementary to tree-sitter topic patterns)
          if (config.detect.topics) {
            const extracted = await mafkaEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }


          // External IO boundary detection (HTTP/Socket to external systems)
          if (config.detect.external_io) {
            const extracted = await externalIoEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          // HTTP consumer detection (FeignClient, RestTemplate, WebClient)
          if (config.detect.http_consumers) {
            const extracted = await httpConsumerEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          // Crane distributed task scheduling (@Crane annotations)
          if (config.detect.crane) {
            const extracted = await craneEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          // Squirrel Redis cluster dependency detection
          if (config.detect.squirrel) {
            const extracted = await squirrelEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          // DBus CDC topic and thrift service detection
          if (config.detect.dbus) {
            const extracted = await dbusEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
            // Collect QUERIES edges for this repo while its pool is still open.
            // This feeds deriveDbusWriteSides after the loop.
            try {
              const rows = await executor(
                'MATCH ()-[r:CodeRelation {type: "QUERIES"}]->(t:CodeElement) RETURN DISTINCT t.name AS tableName',
                {},
              );
              for (const row of rows) {
                const name = (row['tableName'] as string | undefined)?.toLowerCase();
                if (!name) continue;
                if (!tableToWriteRepos.has(name)) tableToWriteRepos.set(name, new Set());
                tableToWriteRepos.get(name)!.add(groupPath);
              }
            } catch (err) {
              logger.warn(
                { repo: groupPath, err: err instanceof Error ? err.message : String(err) },
                '[sync] QUERIES collection failed for repo',
              );
            }
          }

          const metaPath = path.join(handle.storagePath, 'meta.json');
          try {
            const raw = await fs.readFile(metaPath, 'utf-8');
            const m = JSON.parse(raw) as { indexedAt?: string; lastCommit?: string };
            repoSnapshots[groupPath] = {
              indexedAt: m.indexedAt || '',
              lastCommit: m.lastCommit || '',
            };
          } catch {
            const e = entries.find((en) => en.name === regName);
            repoSnapshots[groupPath] = {
              indexedAt: e?.indexedAt || '',
              lastCommit: e?.lastCommit || '',
            };
          }
        } catch {
          missingRepos.push(groupPath);
        }
      }
      // All per-repo QUERIES edges collected. Derive writeSideRepos for dbus consumers.
      deriveDbusWriteSides(autoContracts, tableToWriteRepos);
    } finally {
      for (const id of [...new Set(openPoolIds)]) {
        await closeLbug(id).catch(() => {});
      }
    }
  }

  // ─── Shepherd gateway route resolution ──────────────────────────────
  // When config.detect.shepherd is configured, fetch route definitions from
  // the Shepherd API gateway and register them as provider contracts for the
  // gateway repo. This creates proper frontend→gateway cross-links and helps
  // disambiguate generic paths (e.g. /query) that multiple backends expose.
  // Supports multiple Shepherd groups (flight-m, flight-b, flight-x, etc.).
  if (config.detect.shepherd) {
    try {
      const shepherdCfg = normalizeShepherdConfig(config.detect.shepherd, config);
      if (shepherdCfg) {
        const groupDir = opts?.groupDir || '';
        const { groups, baseConfig, gatewayRepo } = shepherdCfg;

        let result;
        if (groups.length === 1) {
          // Single group: use original single-group resolver
          result = await resolveShepherdRoutes({ ...baseConfig, group: groups[0] }, groupDir);
        } else {
          // Multi-group: use merged resolver
          result = await resolveMultipleShepherdGroups(groups, baseConfig, groupDir);
        }

        for (const c of result.contracts) {
          autoContracts.push({
            ...c,
            repo: gatewayRepo,
          });
        }

        if (opts?.verbose) {
          const groupsStr = groups.length === 1
            ? `group "${groups[0]}"`
            : `${groups.length} groups [${groups.join(', ')}]`;
          logger.info(
            `  shepherd: ${result.contracts.length} gateway routes from ${groupsStr}` +
            ` (${result.fetchTimeMs}ms, ${result.fromCache ? 'cached' : 'fresh'})`,
          );
        }
      }
    } catch (err) {
      logger.warn(`[shepherd] Route resolution failed: ${(err as Error).message}`);
      // Non-fatal — continue with other extractors' data
    }
  }

  // Auto-discover workspace dependency contracts (Rust Cargo workspaces, etc.)
  // and merge them with explicit manifest links. Discovered links use the same
  // ManifestExtractor pipeline as hand-written links in group.yaml.
  let allLinks = [...config.links];

  if (config.detect.workspace_deps) {
    const repoPaths = new Map<string, string>();
    if (!registryEntries) registryEntries = await readRegistry();
    for (const [groupPath, regName] of Object.entries(config.repos)) {
      const e = registryEntries.find((en) => en.name === regName);
      if (e) repoPaths.set(groupPath, e.path);
    }

    const wsResult = await discoverWorkspaceLinks(config.repos, repoPaths, dbExecutors);
    if (wsResult.links.length > 0) {
      allLinks = [...allLinks, ...wsResult.links];
      if (opts?.verbose) {
        for (const s of wsResult.stats) {
          logger.info(
            `  workspace-deps: discovered ${s.linkCount} cross-${s.ecosystem.toLowerCase()} links from ${s.projectCount} ${s.ecosystem} projects`,
          );
        }
      }
    }
  }

  // Process manifest links declared in group.yaml (plus any auto-discovered).
  // ManifestExtractor is fully implemented but was never wired into this
  // pipeline — config.links were parsed and validated but silently dropped.
  // Placed after the DB try/finally: resolveSymbol falls back to synthetic
  // UIDs when dbExecutors is undefined or a pool is closed, so cross-links
  // are always generated regardless of whether real DB executors are available.
  if (allLinks.length > 0) {
    const knownRepos = new Set(Object.keys(config.repos));
    for (const link of allLinks) {
      const dangling = [link.from, link.to].filter((r) => !knownRepos.has(r));
      if (dangling.length > 0) {
        logger.warn(
          `[group/sync] manifest link ${link.type}:${link.contract} references repos not in config.repos: ${dangling.join(', ')} — cross-links will use synthetic UIDs`,
        );
      }
    }

    const manifestEx = new ManifestExtractor();
    const manifestResult = await manifestEx.extractFromManifest(allLinks, dbExecutors);
    autoContracts.push(...manifestResult.contracts);
    manifestCrossLinks = manifestResult.crossLinks;
    if (opts?.verbose) {
      logger.info(
        `  manifest: ${manifestCrossLinks.length} cross-links from ${allLinks.length} links (${config.links.length} declared + ${allLinks.length - config.links.length} discovered)`,
      );
    }
  }

  // Post-extraction noise filtering (incremental, config-gated)
  if (config.detect.post_filter) {
    autoContracts = filterContracts(autoContracts);
  }

  const providerIndex = buildProviderIndex(autoContracts, config.matching);
  const { matched, unmatched } = runExactMatch(autoContracts, providerIndex, config.matching);
  const wildcard = runWildcardMatch(unmatched, providerIndex, config.matching);

  // Dedupe cross-links. Manifest contracts participate in runExactMatch, so a
  // manifest-declared link can also emit a matchType:'exact' CrossLink with the
  // same endpoints. Prefer the manifest version — it reflects operator intent
  // and carries matchType:'manifest' which downstream consumers may rely on.
  // Note: Squirrel Redis contracts now use standard provider/consumer roles
  // (writer=provider, reader=consumer) and are matched via runExactMatch above,
  // just like Thrift and Mafka — no special peer-link logic needed.
  let crossLinks = dedupeCrossLinks([...manifestCrossLinks, ...matched, ...wildcard.matched]);
  const allContracts: StoredContract[] = autoContracts;

  const registry: ContractRegistry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots,
    missingRepos,
    contracts: allContracts,
    crossLinks,
  };

  if (opts?.groupDir && !opts.skipWrite) {
    await writeContractRegistry(opts.groupDir, registry);
    // writeBridge failure (disk full, schema error, permission denied) must
    // not mask the registry — contracts.json was just written successfully
    // and is the canonical source of truth. A stale or absent bridge
    // degrades impact queries to empty results, which is recoverable on
    // the next sync. Surface the failure as a warning so operators can
    // act, but do not propagate it.
    // (PR #1156 follow-up review: writeBridge error in sync.ts propagates
    // uncaught.)
    try {
      await writeBridge(opts.groupDir, {
        contracts: allContracts,
        crossLinks,
        repoSnapshots,
        missingRepos,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: msg, groupDir: opts.groupDir },
        '⚠️ writeBridge failed; contracts.json is intact but bridge.lbug is stale. Re-run `gitnexus group sync` to retry.',
      );
    }
  }

  return {
    contracts: allContracts,
    crossLinks,
    unmatched: wildcard.remaining,
    missingRepos,
    repoSnapshots,
  };
}

/**
 * For each thrift-mode dbus consumer contract, find which repos write the
 * tables it listens to using a pre-built tableToWriteRepos map (collected
 * per-repo while each pool was still open). Mutates contracts in-place.
 *
 * tableToWriteRepos: tableName (lowercase) → set of groupPath strings that
 * have a QUERIES edge pointing at a CodeElement with that name.
 * groupPath equals StoredContract.repo, so self-exclusion (c.repo) is exact.
 */
function deriveDbusWriteSides(
  contracts: StoredContract[],
  tableToWriteRepos: Map<string, Set<string>>,
): void {
  if (tableToWriteRepos.size === 0) return;

  for (const c of contracts) {
    // Only thrift-mode consumers have QUERIES edges to match against.
    // Mafka-mode dbus consumers (contractId: dbus::<topicName>) are linked via
    // topic name, not DB table QUERIES edges, so they are intentionally excluded.
    if (c.type !== 'dbus' || c.role !== 'consumer' || !c.contractId.startsWith('dbus::thrift::')) {
      continue;
    }
    const tableNames = (c.meta?.tableNames as string[] | undefined) ?? [];
    if (tableNames.length === 0) continue;

    const writeSide = new Set<string>();
    for (const table of tableNames) {
      const repos = tableToWriteRepos.get(table.toLowerCase());
      if (repos) {
        for (const r of repos) {
          if (r !== c.repo) writeSide.add(r);
        }
      }
    }
    if (writeSide.size > 0) {
      c.meta = { ...c.meta, writeSideRepos: [...writeSide].sort() };
    }
  }
}
