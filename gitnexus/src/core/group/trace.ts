/**
 * Cross-repo call trace — BFS within each repo's LadybugDB, jumping across
 * repos via CrossLinks from the Contract Registry.
 *
 * Core module, decoupled from CLI. Consumed by CLI and (future) MCP tool.
 *
 * Algorithm:
 *   1. Load ContractRegistry (contracts.json) for the group.
 *   2. In the entry repo, resolve the entry symbol → BFS downstream via CALLS edges.
 *   3. For each BFS-visited node whose `id` matches a CrossLink endpoint's `symbolUid`,
 *      record the cross-repo hop and enqueue the target endpoint for the next repo.
 *   4. Open the target repo's lbug, seed BFS from the target symbolUid, repeat.
 *   5. Recurse until maxCrossDepth is exhausted or no more hops are found.
 */

import type {
  ContractRegistry,
  ContractType,
  CrossLink,
  CrossLinkEndpoint,
  GroupConfig,
  MatchType,
} from './types.js';
import type { GroupRepoHandle, GroupToolPort } from './service.js';
import { GroupNotFoundError, loadGroupConfig } from './config-parser.js';
import { getGroupDir, readContractRegistry } from './storage.js';
import { initLbug, executeParameterized, closeLbug } from '../lbug/pool-adapter.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single node visited during intra-repo BFS. */
export interface TraceNode {
  id: string;
  name: string;
  type: string;
  filePath: string;
  depth: number;
  relationType?: string;
  confidence?: number;
}

/** A cross-repo hop discovered during the trace. */
export interface TraceCrossHop {
  contractId: string;
  contractType: ContractType;
  matchType: MatchType;
  linkConfidence: number;
  from: {
    repo: string;
    symbolUid: string;
    symbolName: string;
  };
  to: {
    repo: string;
    symbolUid: string;
    symbolName: string;
  };
}

/** One repo's BFS result within the trace. */
export interface TraceRepoSegment {
  repo: string;
  repoPath: string;
  entrySymbolUid: string;
  nodes: TraceNode[];
  crossHops: TraceCrossHop[];
}

/** Full trace result returned to callers. */
export interface TraceResult {
  group: string;
  entryRepo: string;
  entryTarget: string;
  direction: 'downstream' | 'upstream';
  segments: TraceRepoSegment[];
  /** Repos that could not be opened / traversed. */
  skippedRepos: string[];
  /** True when maxCrossDepth was hit before the trace naturally terminated. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface TraceParams {
  /** Group name. */
  name: string;
  /** Group repo path (key in group.yaml repos map, e.g. "app/backend"). */
  repo: string;
  /** Symbol name or file path to start the trace from. */
  target: string;
  /** Trace direction — defaults to 'downstream'. */
  direction?: 'downstream' | 'upstream';
  /** Max BFS depth within each repo (default 5). */
  maxDepth?: number;
  /** Max cross-repo hops (default 3). */
  maxCrossDepth?: number;
  /** Relation types for BFS edges (default: CALLS). */
  relationTypes?: string[];
  /** Include test files in traversal (default false). */
  includeTests?: boolean;
  /** Minimum edge confidence (0–1, default 0). */
  minConfidence?: number;
}

// ---------------------------------------------------------------------------
// Deps injection (keeps module free of LocalBackend)
// ---------------------------------------------------------------------------

export interface TraceDeps {
  port: GroupToolPort;
  gitnexusDir: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_CROSS_DEPTH = 3;
const DEFAULT_RELATION_TYPES = ['CALLS'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTestFilePath(fp: string): boolean {
  const lower = fp.toLowerCase();
  return (
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/') ||
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('_test.')
  );
}

/** Build a lookup: symbolUid → CrossLink[] for a given repo (as "from" side). */
function buildCrossLinkIndex(
  crossLinks: CrossLink[],
  repoPath: string,
  direction: 'downstream' | 'upstream',
): Map<string, CrossLink[]> {
  const index = new Map<string, CrossLink[]>();
  for (const link of crossLinks) {
    // For downstream trace: we leave the current repo via the "from" endpoint
    // (consumer calls provider). The BFS-visited node matches from.symbolUid,
    // and we jump to to.symbolUid in the target repo.
    //
    // For upstream trace: we leave via the "to" endpoint (provider is called
    // by consumer). The BFS-visited node matches to.symbolUid, and we jump
    // to from.symbolUid in the source repo.
    const localEndpoint: CrossLinkEndpoint = direction === 'downstream' ? link.from : link.to;
    const remoteEndpoint: CrossLinkEndpoint = direction === 'downstream' ? link.to : link.from;

    if (localEndpoint.repo !== repoPath) continue;
    // Skip self-links (same repo on both sides)
    if (remoteEndpoint.repo === repoPath) continue;

    const uid = localEndpoint.symbolUid;
    if (!uid) continue;

    let arr = index.get(uid);
    if (!arr) {
      arr = [];
      index.set(uid, arr);
    }
    arr.push(link);
  }
  return index;
}

/** Resolve a symbol name/file to its lbug node id. */
async function resolveEntrySymbol(
  repoId: string,
  target: string,
): Promise<{ id: string; name: string; type: string; filePath: string } | null> {
  // Try exact id match first
  let rows = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.id = $target
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
     LIMIT 1`,
    { target },
  );
  if (rows.length > 0) {
    const r = rows[0];
    return {
      id: r.id ?? r[0],
      name: r.name ?? r[1],
      type: r.type ?? r[2],
      filePath: r.filePath ?? r[3],
    };
  }

  // Try name match
  rows = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.name = $target
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
     LIMIT 1`,
    { target },
  );
  if (rows.length > 0) {
    const r = rows[0];
    return {
      id: r.id ?? r[0],
      name: r.name ?? r[1],
      type: r.type ?? r[2],
      filePath: r.filePath ?? r[3],
    };
  }

  return null;
}

/** Resolve a symbolUid to its lbug node (for cross-repo entry). */
async function resolveByUid(
  repoId: string,
  uid: string,
): Promise<{ id: string; name: string; type: string; filePath: string } | null> {
  const rows = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.id = $uid
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
     LIMIT 1`,
    { uid },
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id ?? r[0],
    name: r.name ?? r[1],
    type: r.type ?? r[2],
    filePath: r.filePath ?? r[3],
  };
}

/**
 * Run BFS within a single repo's lbug graph.
 * Returns visited nodes and any cross-repo hops discovered.
 */
async function intraRepoBFS(
  repoId: string,
  seedIds: string[],
  direction: 'downstream' | 'upstream',
  crossLinkIndex: Map<string, CrossLink[]>,
  opts: {
    maxDepth: number;
    relationTypes: string[];
    includeTests: boolean;
    minConfidence: number;
  },
): Promise<{ nodes: TraceNode[]; crossHops: TraceCrossHop[] }> {
  const { maxDepth, relationTypes, includeTests, minConfidence } = opts;
  const relTypeFilter = relationTypes.map((t) => `'${t}'`).join(', ');
  const confidenceFilter = minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : '';

  const visited = new Set<string>(seedIds);
  let frontier = [...seedIds];
  const nodes: TraceNode[] = [];
  const crossHops: TraceCrossHop[] = [];
  const seenHopKeys = new Set<string>();

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const idList = frontier.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');

    const query =
      direction === 'downstream'
        ? `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence`
        : `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence`;

    let related: any[];
    try {
      const { executeQuery } = await import('../lbug/pool-adapter.js');
      related = await executeQuery(repoId, query);
    } catch (e) {
      logger.warn(`[trace] BFS query failed at depth ${depth}: ${e}`);
      break;
    }

    const nextFrontier: string[] = [];
    for (const rel of related) {
      const relId = rel.id ?? rel[1];
      const filePath = rel.filePath ?? rel[4] ?? '';
      if (!includeTests && isTestFilePath(filePath)) continue;
      if (visited.has(relId)) continue;

      visited.add(relId);
      nextFrontier.push(relId);

      const relationType = rel.relType ?? rel[5];
      const storedConf = rel.confidence ?? rel[6];
      const effectiveConf = typeof storedConf === 'number' && storedConf > 0 ? storedConf : 1;

      nodes.push({
        id: relId,
        name: rel.name ?? rel[2],
        type: rel.type ?? rel[3],
        filePath,
        depth,
        relationType,
        confidence: effectiveConf,
      });
    }

    frontier = nextFrontier;
  }

  // Check all visited nodes (including seeds) against crossLink index
  for (const nodeId of visited) {
    const links = crossLinkIndex.get(nodeId);
    if (!links) continue;
    for (const link of links) {
      const hopKey = `${link.contractId}::${link.from.repo}->${link.to.repo}`;
      if (seenHopKeys.has(hopKey)) continue;
      seenHopKeys.add(hopKey);

      crossHops.push({
        contractId: link.contractId,
        contractType: link.type,
        matchType: link.matchType,
        linkConfidence: link.confidence,
        from: {
          repo: link.from.repo,
          symbolUid: link.from.symbolUid,
          symbolName: link.from.symbolRef?.name ?? '',
        },
        to: {
          repo: link.to.repo,
          symbolUid: link.to.symbolUid,
          symbolName: link.to.symbolRef?.name ?? '',
        },
      });
    }
  }

  return { nodes, crossHops };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a cross-repo call trace starting from a symbol in one repo,
 * following CALLS edges within each repo and jumping across repos
 * via CrossLinks.
 *
 * Decoupled from CLI — takes injected deps and returns a structured result.
 */
export async function runGroupTrace(
  deps: TraceDeps,
  params: TraceParams,
): Promise<TraceResult | { error: string }> {
  const {
    name,
    repo: entryRepoPath,
    target,
    direction = 'downstream',
    maxDepth = DEFAULT_MAX_DEPTH,
    maxCrossDepth = DEFAULT_MAX_CROSS_DEPTH,
    relationTypes = DEFAULT_RELATION_TYPES,
    includeTests = false,
    minConfidence = 0,
  } = params;

  if (!name) return { error: 'name is required' };
  if (!entryRepoPath) return { error: 'repo is required' };
  if (!target) return { error: 'target is required' };
  if (direction !== 'downstream' && direction !== 'upstream') {
    return { error: 'direction must be downstream or upstream' };
  }

  // Load group config
  const groupDir = getGroupDir(deps.gitnexusDir, name);
  let config: GroupConfig;
  try {
    config = await loadGroupConfig(groupDir);
  } catch (e) {
    if (e instanceof GroupNotFoundError) {
      return { error: `Group "${name}" not found. Run group_list to see configured groups.` };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }

  // Load contract registry
  const registry = await readContractRegistry(groupDir);
  if (!registry) {
    return { error: `No contracts.json for group "${name}". Run group_sync first.` };
  }

  // Resolve entry repo
  const entryRegistryName = config.repos[entryRepoPath];
  if (!entryRegistryName) {
    return { error: `Unknown repo path "${entryRepoPath}" in group "${name}".` };
  }

  let entryRepo: GroupRepoHandle;
  try {
    entryRepo = await deps.port.resolveRepo(entryRegistryName);
  } catch (e) {
    return { error: `Cannot resolve entry repo: ${e instanceof Error ? e.message : String(e)}` };
  }

  // State
  const segments: TraceRepoSegment[] = [];
  const skippedRepos: string[] = [];
  const visitedRepos = new Set<string>(); // repo + symbolUid to avoid cycles
  let truncated = false;

  // Queue: each item is a (repoPath, symbolUid) to trace into
  type QueueItem = { repoPath: string; symbolUid: string; crossDepth: number };
  const queue: QueueItem[] = [];

  // --- Phase 1: entry repo ---
  const openedRepoIds: string[] = [];
  try {
    // Init lbug for entry repo
    const entryDbPath = `${entryRepo.storagePath}/graph.lbug`;
    await initLbug(entryRepo.id, entryDbPath);
    openedRepoIds.push(entryRepo.id);

    // Resolve entry symbol
    const entrySym = await resolveEntrySymbol(entryRepo.id, target);
    if (!entrySym) {
      return { error: `Symbol "${target}" not found in repo "${entryRepoPath}".` };
    }

    // Build crossLink index for entry repo
    const crossIdx = buildCrossLinkIndex(registry.crossLinks, entryRepoPath, direction);

    // BFS
    const { nodes, crossHops } = await intraRepoBFS(
      entryRepo.id,
      [entrySym.id],
      direction,
      crossIdx,
      { maxDepth, relationTypes, includeTests, minConfidence },
    );

    segments.push({
      repo: entryRegistryName,
      repoPath: entryRepoPath,
      entrySymbolUid: entrySym.id,
      nodes,
      crossHops,
    });

    // Enqueue cross-repo targets
    for (const hop of crossHops) {
      const targetEndpoint = direction === 'downstream' ? hop.to : hop.from;
      const key = `${targetEndpoint.repo}::${targetEndpoint.symbolUid}`;
      if (!visitedRepos.has(key)) {
        visitedRepos.add(key);
        queue.push({
          repoPath: targetEndpoint.repo,
          symbolUid: targetEndpoint.symbolUid,
          crossDepth: 1,
        });
      }
    }

    // --- Phase 2+: cross-repo BFS ---
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.crossDepth > maxCrossDepth) {
        truncated = true;
        continue;
      }

      const regName = config.repos[item.repoPath];
      if (!regName) {
        skippedRepos.push(item.repoPath);
        continue;
      }

      let repoHandle: GroupRepoHandle;
      try {
        repoHandle = await deps.port.resolveRepo(regName);
      } catch {
        skippedRepos.push(item.repoPath);
        continue;
      }

      // Init lbug
      const dbPath = `${repoHandle.storagePath}/graph.lbug`;
      try {
        await initLbug(repoHandle.id, dbPath);
        if (!openedRepoIds.includes(repoHandle.id)) {
          openedRepoIds.push(repoHandle.id);
        }
      } catch {
        skippedRepos.push(item.repoPath);
        continue;
      }

      // Resolve the target symbolUid in this repo's lbug
      const targetSym = await resolveByUid(repoHandle.id, item.symbolUid);
      if (!targetSym) {
        logger.warn(
          `[trace] symbolUid "${item.symbolUid}" not found in lbug for repo "${item.repoPath}", skipping`,
        );
        skippedRepos.push(item.repoPath);
        continue;
      }

      // Build crossLink index for this repo
      const crossIdx = buildCrossLinkIndex(registry.crossLinks, item.repoPath, direction);

      // BFS
      const { nodes, crossHops } = await intraRepoBFS(
        repoHandle.id,
        [targetSym.id],
        direction,
        crossIdx,
        { maxDepth, relationTypes, includeTests, minConfidence },
      );

      segments.push({
        repo: regName,
        repoPath: item.repoPath,
        entrySymbolUid: targetSym.id,
        nodes,
        crossHops,
      });

      // Enqueue further cross-repo targets
      for (const hop of crossHops) {
        const nextEndpoint = direction === 'downstream' ? hop.to : hop.from;
        const key = `${nextEndpoint.repo}::${nextEndpoint.symbolUid}`;
        if (!visitedRepos.has(key)) {
          visitedRepos.add(key);
          queue.push({
            repoPath: nextEndpoint.repo,
            symbolUid: nextEndpoint.symbolUid,
            crossDepth: item.crossDepth + 1,
          });
        }
      }
    }
  } finally {
    // Close lbug connections opened by this trace
    // Note: closeLbug(repoId) only closes if we opened it; the pool adapter
    // handles ref-counting so we won't break other concurrent users.
    for (const rid of openedRepoIds) {
      await closeLbug(rid).catch(() => {});
    }
  }

  return {
    group: name,
    entryRepo: entryRepoPath,
    entryTarget: target,
    direction,
    segments,
    skippedRepos: [...new Set(skippedRepos)],
    truncated,
  };
}
