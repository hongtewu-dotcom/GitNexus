import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { initLbug, closeLbug, executeParameterized } from '../lbug/pool-adapter.js';
import { readRegistry, type RegistryEntry } from '../../storage/repo-manager.js';
import type { GroupConfig, RepoHandle, RepoSnapshot, StoredContract, CrossLink, ShepherdDetectConfig, RepoScope } from './types.js';
import { HttpRouteExtractor } from './extractors/http-route-extractor.js';
import { GrpcExtractor } from './extractors/grpc-extractor.js';
import { ThriftExtractor } from './extractors/thrift-extractor.js';
import { TopicExtractor } from './extractors/topic-extractor.js';
import { MafkaPropertiesExtractor } from './extractors/mafka-properties-extractor.js';
import { ExternalIoExtractor } from './extractors/external-io-extractor.js';
import { HttpConsumerExtractor } from './extractors/http-consumer-extractor.js';
import { CraneExtractor } from './extractors/crane-extractor.js';
import { SquirrelExtractor } from './extractors/squirrel-extractor.js';
import { ManifestExtractor } from './extractors/manifest-extractor.js';
import { discoverWorkspaceLinks } from './extractors/workspace-extractor.js';
import { resolveShepherdRoutes, type ShepherdConfig } from './extractors/shepherd-route-resolver.js';
import { buildProviderIndex, runExactMatch, runWildcardMatch } from './matching.js';
import { filterContracts } from './post-filter.js';
import { detectServiceBoundaries, assignService } from './service-boundary-detector.js';
import type { CypherExecutor } from './contract-extractor.js';
import { writeContractRegistry } from './storage.js';
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
 * Normalize the `detect.shepherd` config value into a ShepherdConfig object.
 * Supports:
 *   - `true` → tries to infer group name from the group config name
 *   - `{ group: 'flight-m', ... }` → uses as-is
 */
function normalizeShepherdConfig(
  raw: ShepherdDetectConfig | boolean,
  groupConfig: GroupConfig,
): ShepherdConfig | null {
  if (raw === false) return null;
  if (raw === true) {
    // Auto-infer: use group name as shepherd group, try common patterns
    const name = groupConfig.name;
    // Look for a repo with 'gateway' in its path
    const gatewayRepo = Object.keys(groupConfig.repos).find(
      (k) => k.includes('gateway') || k.includes('shepherd'),
    );
    return {
      group: name,
      gateway_repo: gatewayRepo,
    };
  }
  // Object form — pass through with defaults
  return {
    group: raw.group,
    gateway_repo: raw.gateway_repo || Object.keys(groupConfig.repos).find(
      (k) => k.includes('gateway') || k.includes('shepherd'),
    ),
    cookie: raw.cookie,
    cookie_file: raw.cookie_file,
    cache_file: raw.cache_file,
    cache_ttl: raw.cache_ttl,
  };
}

export async function syncGroup(config: GroupConfig, opts?: SyncOptions): Promise<SyncResult> {
  const missingRepos: string[] = [];
  const repoSnapshots: Record<string, RepoSnapshot> = {};
  let autoContracts: StoredContract[] = [];
  let manifestCrossLinks: CrossLink[] = [];
  let dbExecutors: Map<string, CypherExecutor> | undefined;
  let registryEntries: RegistryEntry[] | undefined;

  // Scope filter: BFS-reachable methods per repo (populated during extraction if scopes configured)
  // Keys in the set are "filePath::methodName" composite strings for method-level precision.
  const scopeReachableMethods = new Map<string, Set<string>>();

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
    const mafkaEx = new MafkaPropertiesExtractor();
    const externalIoEx = new ExternalIoExtractor();
    const httpConsumerEx = new HttpConsumerExtractor();
    const craneEx = new CraneExtractor();
    const squirrelEx = new SquirrelExtractor();
    dbExecutors = new Map<string, CypherExecutor>();
    const openPoolIds: string[] = [];

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

          // ─── Scope filter: BFS from entry points ─────────────────────
          // If this repo has a scope config, run BFS from the declared entry
          // points to collect all reachable file paths. These are later used
          // to filter cross-links so only entry-point-reachable consumers
          // participate in matching.
          if (config.scopes?.[groupPath]) {
            const scope = config.scopes[groupPath];
            const depth = scope.max_depth ?? 15;
            const reachable = new Set<string>();

            for (const ep of scope.entry_points) {
              try {
                const whereClause = ep.file
                  ? `start.name = '${ep.method}' AND start.filePath = '${ep.file}'`
                  : `start.name = '${ep.method}'`;
                // Return both filePath and method name for method-level scope filtering
                const query = `MATCH (start)-[:CodeRelation* 1..${depth}]->(target) WHERE ${whereClause} RETURN DISTINCT target.filePath, target.name`;
                const result = await executor(query, {});

                // Parse Cypher result — expect rows with target.filePath and target.name
                if (Array.isArray(result)) {
                  for (const row of result) {
                    const r = row as Record<string, unknown>;
                    const fp = r['target.filePath'];
                    const name = r['target.name'];
                    if (typeof fp === 'string' && typeof name === 'string') {
                      reachable.add(`${fp}::${name}`);
                    } else if (typeof fp === 'string') {
                      // Fallback: file-only (when name not available)
                      reachable.add(`${fp}::*`);
                    }
                  }
                } else if (result && typeof result === 'object') {
                  // LadybugDB markdown table format
                  const md = (result as Record<string, unknown>).markdown;
                  if (typeof md === 'string') {
                    const lines = md.split('\n');
                    for (const line of lines.slice(2)) { // skip header + separator
                      const cols = line.split('|').map((c: string) => c.trim()).filter(Boolean);
                      if (cols.length >= 2 && cols[0] && !cols[0].startsWith('---')) {
                        reachable.add(`${cols[0]}::${cols[1]}`);
                      } else if (cols.length >= 1 && cols[0] && !cols[0].startsWith('---')) {
                        reachable.add(`${cols[0]}::*`);
                      }
                    }
                  }
                }

                if (opts?.verbose) {
                  logger.info(
                    `  scope[${groupPath}]: BFS from ${ep.method}${ep.file ? ` (${ep.file})` : ''} → ${reachable.size} reachable method nodes`,
                  );
                }
              } catch (err) {
                logger.warn(
                  `[scope] BFS for ${groupPath} entry ${ep.method} failed: ${(err as Error).message}`,
                );
              }
            }

            if (reachable.size > 0) {
              scopeReachableMethods.set(groupPath, reachable);
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
  if (config.detect.shepherd) {
    try {
      const shepherdCfg = normalizeShepherdConfig(config.detect.shepherd, config);
      if (shepherdCfg) {
        const groupDir = opts?.groupDir || '';
        const result = await resolveShepherdRoutes(shepherdCfg, groupDir);
        const gatewayRepo = shepherdCfg.gateway_repo || 'api/gateway';

        for (const c of result.contracts) {
          autoContracts.push({
            ...c,
            repo: gatewayRepo,
          });
        }

        if (opts?.verbose) {
          logger.info(
            `  shepherd: ${result.contracts.length} gateway routes from group "${shepherdCfg.group}"` +
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

  // ─── Scope filter: restrict cross-links to BFS-reachable methods ────
  // For repos with scope config, only keep cross-links whose consumer
  // contract's callerMethod is in the BFS-reachable set. This ensures
  // that only contracts invoked from methods reachable from the declared
  // entry points survive — a file-level check is insufficient because the
  // same file (e.g., a Gateway class) may contain both reachable and
  // unreachable methods.
  if (scopeReachableMethods.size > 0) {
    // Build a lookup from symbolUid → StoredContract for callerMethod access
    const contractByUid = new Map<string, StoredContract>();
    for (const c of allContracts) {
      contractByUid.set(c.symbolUid, c);
    }

    const beforeCount = crossLinks.length;
    crossLinks = crossLinks.filter((link) => {
      const reachable = scopeReachableMethods.get(link.from.repo);
      if (!reachable) return true; // no scope for this repo — keep all

      const contract = contractByUid.get(link.from.symbolUid);
      const callerMethod = contract?.meta?.callerMethod as string | undefined;
      const filePath = link.from.symbolRef.filePath;

      if (callerMethod) {
        // Method-level match: check "filePath::callerMethod"
        if (reachable.has(`${filePath}::${callerMethod}`)) return true;
        // Also check wildcard entries (file known reachable but method name not tracked)
        if (reachable.has(`${filePath}::*`)) return true;
        return false;
      }

      // No callerMethod available — fall back to file-level (any method in this file is reachable)
      for (const key of reachable) {
        if (key.startsWith(`${filePath}::`)) return true;
      }
      return false;
    });
    if (opts?.verbose) {
      logger.info(
        `  scope filter: ${beforeCount} → ${crossLinks.length} cross-links (removed ${beforeCount - crossLinks.length} unreachable)`,
      );
    }
  }

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
  }

  return {
    contracts: allContracts,
    crossLinks,
    unmatched: wildcard.remaining,
    missingRepos,
    repoSnapshots,
  };
}
