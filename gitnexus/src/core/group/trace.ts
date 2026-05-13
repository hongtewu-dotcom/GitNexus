/**
 * Cross-repo call trace — BFS within each repo's LadybugDB, jumping across
 * repos via contracts.json crossLinks.
 *
 * Core module, decoupled from CLI. Consumed by CLI and (future) MCP tool.
 *
 * Algorithm:
 *   1. Load contracts.json for the group (contains crossLinks with
 *      from/to symbolRef.filePath that can be matched against BFS-visited files).
 *   2. In the entry repo, resolve the entry symbol → BFS downstream via CALLS edges.
 *   3. Collect all visited file paths and match against crossLinks where
 *      from.repo == currentRepo and from.symbolRef.filePath is in the visited set.
 *   4. Open the target repo's lbug, resolve the target symbol by name, seed BFS, repeat.
 *   5. Recurse until maxCrossDepth is exhausted or no more hops are found.
 */

import type {
  ContractType,
  CrossLink,
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
  /** Max BFS depth within each repo. 0 = unlimited (BFS runs until frontier is empty). Default: 0. */
  maxDepth?: number;
  /** Max cross-repo hops. 0 = unlimited. Default: 10. */
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

const DEFAULT_MAX_DEPTH = 0; // 0 = unlimited (BFS terminates when frontier is empty)
const DEFAULT_MAX_CROSS_DEPTH = 10;
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

// ---------------------------------------------------------------------------
// Candidate scoring helpers (shared by resolveEntrySymbol & resolveByName)
// ---------------------------------------------------------------------------

type SymbolCandidate = { id: string; name: string; type: string; filePath: string };

/** Extract type from node id prefix (e.g. "Method:..." → "Method"). */
function effectiveType(c: SymbolCandidate): string {
  if (c.type) return c.type;
  const colonIdx = c.id.indexOf(':');
  if (colonIdx > 0) return c.id.slice(0, colonIdx);
  return '';
}

/** Detect utility/DTO/enum classes that are poor BFS entry points. */
function isUtilOrDto(c: SymbolCandidate): boolean {
  const idLower = c.id.toLowerCase();
  const fpLower = (c.filePath || '').toLowerCase();
  const combined = `${idLower}|${fpLower}`;
  return /utils?[./|]/.test(combined) ||
    /enum[./|]/.test(combined) ||
    /validate[./|]/.test(combined) ||
    /convert[./|]/.test(combined) ||
    /dto[./|]/.test(combined) ||
    /entity[./|]/.test(combined) ||
    /\.set[A-Z]/.test(c.id) ||
    /\.get[A-Z]/.test(c.id) ||
    /\.is[A-Z]/.test(c.id) ||
    combined.includes('jsonutils') ||
    combined.includes('paramvalidate') ||
    combined.includes('loggerutil') ||
    combined.includes('logutil');
}

/** Detect Thrift Iface / interface definitions (dead-end for BFS). */
function isIfaceOrThriftDef(c: SymbolCandidate): boolean {
  if (c.id.includes('Iface.') || c.id.includes(':Iface.')) return true;
  const fp = c.filePath || '';
  if (fp.includes('-thrift/') || fp.includes('_thrift/')) return true;
  return false;
}

/**
 * Score a candidate symbol for BFS entry quality.
 * Higher = better entry point.
 * @param classVariants  Optional class-name variants for fuzzy matching.
 * @param target  Optional original target name for semantic relevance scoring.
 */
function scoreCandidate(c: SymbolCandidate, classVariants?: string[], target?: string): number {
  let s = 0;
  const idAndPath = `${c.id}|${c.filePath}`;

  if (classVariants) {
    for (const variant of classVariants) {
      if (idAndPath.includes(variant)) { s += 100; break; }
    }
  }

  const nodeType = effectiveType(c);
  if (nodeType === 'Method') s += 10;

  if (c.filePath && (c.filePath.includes('-server/') || c.filePath.includes('-service/'))) {
    s += 50;
  }
  if (c.filePath && (c.filePath.toLowerCase().includes('impl') || c.filePath.includes('-impl/'))) {
    s += 20;
  }

  // Thrift server entry points: strongly prefer classes named *ThriftServer*,
  // *ThriftServiceImpl*, *RpcServiceImpl* — these are RPC entry facades.
  const idLowerForThrift = c.id.toLowerCase();
  if (idLowerForThrift.includes('thriftserver') || idLowerForThrift.includes('thriftserviceimpl') ||
      idLowerForThrift.includes('rpcserviceimpl')) {
    s += 30;
  }
  // Penalize gateway/delegate/adapter patterns (less likely primary entry)
  if (/gateway|delegate|adapter|proxy|wrapper/i.test(c.id)) {
    s -= 15;
  }

  // Semantic relevance: when a target name is provided, check if the class/file
  // name contains the PascalCase version of the target (e.g. target "secondCheck"
  // → PascalCase "SecondCheck" → prefer SecondCheckThriftServer over Reschedule*).
  if (target && target.length > 0) {
    const pascalTarget = target[0].toUpperCase() + target.slice(1); // "secondCheck" → "SecondCheck"
    if (idAndPath.includes(pascalTarget)) {
      s += 40;
    }
  }

  if (isIfaceOrThriftDef(c)) s -= 200;

  if (c.filePath && (c.filePath.includes('-client/') || c.filePath.includes('-client-'))) {
    s -= 60;
  }

  if (isUtilOrDto(c)) s -= 80;

  if (isTestFilePath(c.filePath)) s -= 50;

  return s;
}

/**
 * Given a Class/Interface/Constructor node, drill down to a Method node in the
 * same file that is a better BFS seed (because BFS follows CALLS edges which
 * only exist between Method nodes, not from Class nodes).
 *
 * For Thrift entry points (e.g. SecondCheckThriftServer), prefers the public
 * method whose name matches common RPC handler patterns. Falls back to any
 * Method in the file if no well-known handler is found.
 *
 * Returns the original node unchanged if it is already a Method, or if no
 * Method nodes exist in the same file.
 */
async function drillDownToMethod(
  repoId: string,
  node: { id: string; name: string; type: string; filePath: string },
): Promise<{ id: string; name: string; type: string; filePath: string }> {
  // Already a Method — nothing to do
  if (node.id.startsWith('Method:')) return node;
  if (!node.filePath) return node;

  const methods = await executeParameterized(
    repoId,
    `MATCH (m:Method) WHERE m.filePath = $fp
     RETURN m.id AS id, m.name AS name, labels(m)[0] AS type, m.filePath AS filePath`,
    { fp: node.filePath },
  );
  if (methods.length === 0) return node;

  // Well-known handler method names (covers Thrift RPC + MQ consumers)
  const handlerNames = new Set([
    'handleMessage', 'onRecvMessage', 'consume', 'onMessage',
    'process', 'execute', 'run',
    // Thrift RPC entry methods often share the service class name
    // but we don't know the exact name here — fall back to scoring
  ]);

  // Prefer handler methods, then score by implementation quality
  let bestMethod: Record<string, unknown> | null = null;
  let bestScore = -Infinity;

  for (const m of methods) {
    const mName = (m.name ?? m[1]) as string;
    const mId = (m.id ?? m[0]) as string;
    let score = 0;

    if (handlerNames.has(mName)) score += 100;
    // Prefer methods that contain the class name (e.g. secondCheck in SecondCheckThriftServer)
    if (mId.includes('Impl') || mId.includes('Server')) score += 20;
    // Penalize getters/setters/toString/hashCode
    if (/^(get|set|is|toString|hashCode|equals)/.test(mName)) score -= 50;
    // Penalize constructors leaked as Method nodes
    if (mName === '<init>' || mName === '<clinit>') score -= 100;

    if (score > bestScore) {
      bestScore = score;
      bestMethod = m;
    }
  }

  if (!bestMethod) bestMethod = methods[0];

  const result = {
    id: (bestMethod.id ?? bestMethod[0]) as string,
    name: (bestMethod.name ?? bestMethod[1]) as string,
    type: (bestMethod.type ?? bestMethod[2]) as string,
    filePath: (bestMethod.filePath ?? bestMethod[3]) as string,
  };

  logger.info(
    `[trace] drillDownToMethod: "${node.id}" → "${result.id}" (${methods.length} methods in file)`,
  );

  return result;
}

/** Resolve a symbol name/file to its lbug node id.
 *
 * When multiple candidates match by name, uses the same scoring logic as
 * resolveByName to prefer implementation classes over client interfaces,
 * Method nodes over Class nodes, and -server/ paths over -client/ paths.
 *
 * If the resolved symbol is a Class/Interface/Constructor node, automatically
 * drills down to a Method node in the same file so that BFS (which requires
 * CALLS edges) can proceed.
 */
async function resolveEntrySymbol(
  repoId: string,
  target: string,
): Promise<{ id: string; name: string; type: string; filePath: string } | null> {
  // Try exact id match first (unique, no scoring needed)
  const exactRows = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.id = $target
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
     LIMIT 1`,
    { target },
  );
  if (exactRows.length > 0) {
    const r = exactRows[0];
    const matched = {
      id: r.id ?? r[0],
      name: r.name ?? r[1],
      type: r.type ?? r[2],
      filePath: r.filePath ?? r[3],
    };
    return drillDownToMethod(repoId, matched);
  }

  // Fetch ALL candidates matching by name (no LIMIT 1)
  const nameRows = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.name = $target
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath`,
    { target },
  );
  if (nameRows.length === 0) return null;

  const candidates: SymbolCandidate[] = nameRows.map((r: Record<string, unknown>) => ({
    id: (r.id ?? r[0]) as string,
    name: (r.name ?? r[1]) as string,
    type: (r.type ?? r[2]) as string,
    filePath: (r.filePath ?? r[3]) as string,
  }));

  // Single candidate — no scoring needed
  if (candidates.length === 1) return drillDownToMethod(repoId, candidates[0]);

  // Score and pick the best candidate (pass target for semantic relevance)
  candidates.sort((a, b) => scoreCandidate(b, undefined, target) - scoreCandidate(a, undefined, target));

  const best = candidates[0];
  logger.info(
    `[trace] resolveEntrySymbol "${target}": ${candidates.length} candidates, ` +
    `selected "${best.id}" (score=${scoreCandidate(best, undefined, target)}) over ${candidates.slice(1, 4).map(c => `"${c.id}"(${scoreCandidate(c, undefined, target)})`).join(', ')}${candidates.length > 4 ? ` ... and ${candidates.length - 4} more` : ''}`,
  );

  return drillDownToMethod(repoId, best);
}

/**
 * Quick check: is this symbolName clearly NOT a resolvable Java symbol?
 * Returns true for synthetic names generated by non-RPC extractors (topic/mafka,
 * squirrel, crane) that will never exist in LadybugDB.
 *
 * Patterns rejected:
 *   - mafkaProducer(...) / mafkaConsumer(...)
 *   - kafkaListener, kafkaTemplate.send, rabbitTemplate.convertAndSend
 *   - MdpMafkaConsumer, MdpMafkaProducer, ConsumeMessage
 *   - squirrel property keys (contain dots but start with lowercase, e.g. "squirrel.fare.fd.category.name")
 *   - crane.task.xxx / methodName@taskName
 */
function isUnresolvableSymbolName(symbolName: string): boolean {
  // mafkaProducer(...) / mafkaConsumer(...)
  if (/^mafka(?:Producer|Consumer)\(/.test(symbolName)) return true;
  // Well-known topic extractor synthetic names
  if (
    symbolName === 'kafkaListener' ||
    symbolName === 'kafkaTemplate.send' ||
    symbolName === 'rabbitTemplate.convertAndSend' ||
    symbolName === 'MdpMafkaConsumer' ||
    symbolName === 'MdpMafkaProducer' ||
    symbolName === 'ConsumeMessage' ||
    symbolName === 'rabbitListener'
  ) return true;
  // crane: "methodName@taskName" or "crane.task.xxx"
  if (symbolName.includes('@') || symbolName.startsWith('crane.task.')) return true;
  // squirrel property keys: "squirrel.xxx" or multi-dot lowercase path (>= 3 dots)
  if (symbolName.startsWith('squirrel.')) return true;
  if ((symbolName.match(/\./g) ?? []).length >= 3 && symbolName[0] === symbolName[0].toLowerCase()) return true;
  return false;
}

/**
 * Tokenize a symbol name (PascalCase, camelCase, or snake_case) into lowercase tokens.
 * "Event_report_listener" → ["event", "report", "listener"]
 * "MOrderStatusChangeProcess" → ["m", "order", "status", "change", "process"]
 * "OrderStatusListener" → ["order", "status", "listener"]
 */
function tokenizeSymbolName(name: string): string[] {
  // Replace underscores with spaces, then split on PascalCase boundaries
  const normalized = name.replace(/_/g, ' ');
  const tokens = normalized
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
  return tokens;
}

/** Common suffixes to strip when comparing consumer/listener class names */
const CONSUMER_NOISE_TOKENS = new Set([
  'listener', 'consumer', 'process', 'processor', 'handler',
  'service', 'impl', 'mafka', 'mq', 'kafka', 'abstract', 'base',
]);

/**
 * Fuzzy-resolve a Mafka/MQ consumer class when the symbolName (from properties
 * listenerId) doesn't match any node exactly. Searches for Class/Interface nodes
 * in consumer/listener/mq directories and scores by token overlap.
 */
async function fuzzyResolveConsumerClass(
  repoId: string,
  symbolName: string,
  findHandlerMethodInFile: (cls: { id: string; name: string; type: string; filePath: string }) => Promise<{ id: string; name: string; type: string; filePath: string }>,
): Promise<{ id: string; name: string; type: string; filePath: string } | null> {
  // Tokenize input and remove noise tokens to get core business tokens
  const inputTokens = tokenizeSymbolName(symbolName);
  const coreTokens = inputTokens.filter((t) => !CONSUMER_NOISE_TOKENS.has(t));
  if (coreTokens.length === 0) return null;

  // Search for Class/Interface nodes in consumer/listener/mq directories.
  // Note: Kùzu doesn't support labels(c)[0] = 'X' in WHERE clause reliably,
  // so we filter by node ID prefix (which encodes the node type).
  const candidates = await executeParameterized(
    repoId,
    `MATCH (c) WHERE (c.id STARTS WITH 'Class:' OR c.id STARTS WITH 'Interface:')
     AND (c.filePath CONTAINS 'consumer' OR c.filePath CONTAINS 'Consumer'
          OR c.filePath CONTAINS 'listener' OR c.filePath CONTAINS 'Listener'
          OR c.filePath CONTAINS '/mq/' OR c.filePath CONTAINS 'mafka'
          OR c.filePath CONTAINS 'Mafka')
     AND NOT c.filePath CONTAINS 'test/'
     AND NOT c.filePath CONTAINS 'Test'
     AND NOT c.filePath CONTAINS '/model/'
     AND NOT c.filePath CONTAINS '/dto/'
     AND NOT c.filePath CONTAINS '/entity/'
     AND NOT c.filePath CONTAINS '/vo/'
     AND NOT c.filePath CONTAINS '/pojo/'
     RETURN c.id AS id, c.name AS name, c.filePath AS filePath`,
    {},
  );

  if (candidates.length === 0) return null;

  // Class name suffixes/substrings that indicate non-consumer classes
  const NON_CONSUMER_SUFFIXES = ['Model', 'Dto', 'DTO', 'VO', 'Entity', 'Request', 'Response', 'Result', 'Param', 'Config', 'Message'];
  // Class name substrings that indicate producers (not consumers)
  const PRODUCER_INDICATORS = ['Producer', 'Sender', 'Publisher'];

  // Score each candidate by token overlap with core tokens
  let bestScore = 0;
  let bestCandidate: { id: string; name: string; type: string; filePath: string } | null = null;

  for (const row of candidates) {
    const candidateName = (row.name ?? row[1]) as string;

    // Skip classes whose name ends with a non-consumer suffix or contains producer indicators
    if (NON_CONSUMER_SUFFIXES.some((suffix) => candidateName.endsWith(suffix))) continue;
    if (PRODUCER_INDICATORS.some((ind) => candidateName.includes(ind))) continue;

    const candidateTokens = tokenizeSymbolName(candidateName)
      .filter((t) => !CONSUMER_NOISE_TOKENS.has(t));

    // Count matching core tokens (case-insensitive)
    let matchCount = 0;
    for (const ct of coreTokens) {
      if (candidateTokens.includes(ct)) matchCount++;
    }

    // Score = matched / max(inputCore, candidateCore) to normalize
    const score = matchCount / Math.max(coreTokens.length, candidateTokens.length || 1);

    const nodeId = (row.id ?? row[0]) as string;
    const isClass = nodeId.startsWith('Class:');

    // Prefer higher score; on tie, prefer Impl class over Interface/abstract
    const isImpl = isClass && (candidateName.endsWith('Impl') || candidateName.includes('Impl'));
    const bestIsInterface = bestCandidate?.type === 'Interface' || (bestCandidate && !bestCandidate.name.includes('Impl'));
    if (score > bestScore || (score === bestScore && isImpl && bestIsInterface)) {
      bestScore = score;
      bestCandidate = {
        id: nodeId,
        name: candidateName,
        type: isClass ? 'Class' : 'Interface',
        filePath: (row.filePath ?? row[2]) as string,
      };
    }
  }

  // Require at least 40% token overlap to avoid false positives.
  // Exception: if there's only ONE viable consumer class in the repo,
  // use it as fallback (high confidence when the repo has a single consumer).
  if (!bestCandidate || bestScore < 0.4) {
    // Count viable candidates (those that passed suffix + producer filter)
    const viableCandidates = candidates.filter((row) => {
      const name = (row.name ?? row[1]) as string;
      if (NON_CONSUMER_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
      if (PRODUCER_INDICATORS.some((ind) => name.includes(ind))) return false;
      return true;
    });
    if (viableCandidates.length === 1) {
      const sole = viableCandidates[0];
      const soleId = (sole.id ?? sole[0]) as string;
      const soleName = (sole.name ?? sole[1]) as string;
      const soleCandidate = {
        id: soleId,
        name: soleName,
        type: soleId.startsWith('Class:') ? 'Class' : 'Interface',
        filePath: (sole.filePath ?? sole[2]) as string,
      };
      logger.info(
        `[trace] fuzzyResolveConsumerClass: "${symbolName}" → "${soleName}" ` +
        `(sole-consumer fallback, coreTokens=[${coreTokens.join(',')}])`,
      );
      return findHandlerMethodInFile(soleCandidate);
    }

    logger.info(
      `[trace] fuzzyResolveConsumerClass: no match for "${symbolName}" (best score=${bestScore.toFixed(2)}, ` +
      `coreTokens=[${coreTokens.join(',')}], viable=${viableCandidates.length}, candidates=${candidates.length})`,
    );
    return null;
  }

  logger.info(
    `[trace] fuzzyResolveConsumerClass: "${symbolName}" → "${bestCandidate.name}" ` +
    `(score=${bestScore.toFixed(2)}, coreTokens=[${coreTokens.join(',')}])`,
  );

  // Drill down to handler method for BFS
  return findHandlerMethodInFile(bestCandidate);
}

/** Resolve a symbol by name in a repo's lbug (for cross-repo entry).
 *
 * symbolName comes from contracts.json `to.symbolRef.name`, typically in
 * "ClassName.methodName" format (e.g. "SecondCheckThriftService.secondCheck").
 *
 * LadybugDB stores `n.name` as just the method name (e.g. "secondCheck"),
 * so the full qualified name will never match directly. When the short-name
 * fallback returns multiple candidates we disambiguate by:
 *   1. Preferring nodes whose id/filePath contains the class-name prefix
 *      (or a common variant like Service→Server, e.g. "SecondCheckThriftServer").
 *   2. Preferring Method nodes over Class/Interface nodes.
 *   3. Excluding test files.
 */
async function resolveByName(
  repoId: string,
  symbolName: string,
): Promise<{ id: string; name: string; type: string; filePath: string } | null> {
  // Fast-reject synthetic/non-Java symbol names that will never resolve in lbug
  if (isUnresolvableSymbolName(symbolName)) {
    logger.info(`[trace] resolveByName: skipping unresolvable symbol "${symbolName}"`);
    return null;
  }

  // Well-known handler method names for Mafka/MQ consumer classes.
  // When we resolve to a Class node, we prefer BFS from its handler method
  // (which has CALLS edges) rather than the Class itself (which only has HAS_METHOD edges).
  const handlerNames = new Set(['handleMessage', 'onRecvMessage', 'consume', 'onMessage', 'process', 'execute', 'run']);

  /**
   * Given a Class/Interface node, find its best handler Method for BFS seeding.
   * Returns the Method node if found, otherwise the original class node.
   */
  async function findHandlerMethodInFile(
    cls: { id: string; name: string; type: string; filePath: string },
  ): Promise<{ id: string; name: string; type: string; filePath: string }> {
    if (!cls.filePath) return cls;
    const methods = await executeParameterized(
      repoId,
      `MATCH (m:Method) WHERE m.filePath = $fp
       RETURN m.id AS id, m.name AS name, labels(m)[0] AS type, m.filePath AS filePath`,
      { fp: cls.filePath },
    );
    if (methods.length === 0) return cls;
    const handler = methods.find((m: Record<string, unknown>) => handlerNames.has((m.name ?? m[1]) as string));
    const best = handler ?? methods[0];
    return {
      id: (best.id ?? best[0]) as string,
      name: (best.name ?? best[1]) as string,
      type: (best.type ?? best[2]) as string,
      filePath: (best.filePath ?? best[3]) as string,
    };
  }

  // Try exact name match first (works when lbug stores qualified names)
  const rows = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.name = $name
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
     LIMIT 1`,
    { name: symbolName },
  );
  if (rows.length > 0) {
    const r = rows[0];
    const matched = {
      id: (r.id ?? r[0]) as string,
      name: (r.name ?? r[1]) as string,
      type: (r.type ?? r[2]) as string,
      filePath: (r.filePath ?? r[3]) as string,
    };
    // If exact match is a Method node, return directly — it has CALLS edges.
    // If it's a Class/Interface/Constructor, drill down to its handler method
    // because BFS only follows CALLS edges (not HAS_METHOD).
    const nodeId = matched.id;
    if (nodeId.startsWith('Method:')) {
      return matched;
    }
    // Class/Interface/Constructor — find the handler method in the same file
    return findHandlerMethodInFile(matched);
  }

  // Extract class prefix and short method name
  const lastDot = symbolName.lastIndexOf('.');
  if (lastDot < 0) {
    // No dot — treat as a class name. Find the Class node then its handler method.
    const classRow = await executeParameterized(
      repoId,
      `MATCH (c) WHERE c.name = $name
       RETURN c.id AS id, c.name AS name, labels(c)[0] AS type, c.filePath AS filePath
       LIMIT 1`,
      { name: symbolName },
    );
    if (classRow.length > 0) {
      const cls = classRow[0];
      const clsResult = {
        id: (cls.id ?? cls[0]) as string,
        name: (cls.name ?? cls[1]) as string,
        type: (cls.type ?? cls[2]) as string,
        filePath: (cls.filePath ?? cls[3]) as string,
      };
      return findHandlerMethodInFile(clsResult);
    }

    // Fuzzy fallback for Mafka/MQ bean names that don't match Java class names.
    // Strategy: tokenize the symbolName, search for Class nodes in consumer/listener/mq
    // directories, score by token overlap.
    const fuzzyResult = await fuzzyResolveConsumerClass(repoId, symbolName, findHandlerMethodInFile);
    if (fuzzyResult) return fuzzyResult;

    return null;
  }

  const classPrefix = symbolName.slice(0, lastDot);   // e.g. "SecondCheckThriftService"
  const shortName = symbolName.slice(lastDot + 1);     // e.g. "secondCheck"

  // Fetch ALL candidates with the short name (no LIMIT 1)
  const rows2 = await executeParameterized(
    repoId,
    `MATCH (n) WHERE n.name = $name
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath`,
    { name: shortName },
  );
  if (rows2.length === 0) return null;

  const candidates: SymbolCandidate[] = rows2.map((r: Record<string, unknown>) => ({
    id: (r.id ?? r[0]) as string,
    name: (r.name ?? r[1]) as string,
    type: (r.type ?? r[2]) as string,
    filePath: (r.filePath ?? r[3]) as string,
  }));

  // Build class-name variants for fuzzy matching:
  // "SecondCheckThriftService" → also try "SecondCheckThriftServer", "SecondCheckThrift"
  const classVariants = [classPrefix];
  if (classPrefix.endsWith('Service')) {
    classVariants.push(classPrefix.replace(/Service$/, 'Server'));
    classVariants.push(classPrefix.replace(/Service$/, 'Impl'));
    classVariants.push(classPrefix.replace(/Service$/, ''));
  } else if (classPrefix.endsWith('Server')) {
    classVariants.push(classPrefix.replace(/Server$/, 'Service'));
    classVariants.push(classPrefix.replace(/Server$/, 'Impl'));
    classVariants.push(classPrefix.replace(/Server$/, ''));
  } else if (classPrefix.endsWith('Impl')) {
    classVariants.push(classPrefix.replace(/Impl$/, 'Service'));
    classVariants.push(classPrefix.replace(/Impl$/, 'Server'));
    classVariants.push(classPrefix.replace(/Impl$/, ''));
  }

  candidates.sort((a, b) => scoreCandidate(b, classVariants) - scoreCandidate(a, classVariants));

  const best = candidates[0];
  if (candidates.length > 1) {
    logger.info(
      `[trace] resolveByName "${symbolName}": ${candidates.length} candidates for short name "${shortName}", ` +
      `selected "${best.id}" (score=${scoreCandidate(best, classVariants)}) over ${candidates.slice(1).map(c => `"${c.id}"(${scoreCandidate(c, classVariants)})`).join(', ')}`,
    );
  }

  return best;
}

/**
 * Run BFS within a single repo's lbug graph.
 * Returns visited nodes (and all visited file paths including seeds).
 */
async function intraRepoBFS(
  repoId: string,
  seedIds: string[],
  seedFilePaths: string[],
  direction: 'downstream' | 'upstream',
  opts: {
    maxDepth: number;
    relationTypes: string[];
    includeTests: boolean;
    minConfidence: number;
  },
): Promise<{ nodes: TraceNode[]; visitedIds: string[]; visitedFilePaths: Set<string> }> {
  const { maxDepth, relationTypes, includeTests, minConfidence } = opts;
  const relTypeFilter = relationTypes.map((t) => `'${t}'`).join(', ');
  const confidenceFilter = minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : '';

  const visited = new Set<string>(seedIds);
  const visitedFilePaths = new Set<string>(seedFilePaths);
  let frontier = [...seedIds];
  const nodes: TraceNode[] = [];

  for (let depth = 1; (maxDepth === 0 || depth <= maxDepth) && frontier.length > 0; depth++) {
    // Use parameterized query to avoid isWriteQuery false positives when
    // node IDs contain keywords like CREATE, SET, DELETE, etc.
    const query =
      direction === 'downstream'
        ? `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN $idList AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence`
        : `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN $idList AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence`;

    let related: any[];
    try {
      related = await executeParameterized(repoId, query, { idList: frontier });
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
      if (filePath) visitedFilePaths.add(filePath);
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

  return { nodes, visitedIds: [...visited], visitedFilePaths };
}

// ---------------------------------------------------------------------------
// CrossLinks index — pre-built once per trace for O(1) repo lookup
// ---------------------------------------------------------------------------

/**
 * Pre-indexed crossLinks grouped by (repo, direction-role).
 * For each repo, stores the subset of crossLinks where that repo is the
 * "local endpoint" (the side that matches during hop discovery).
 */
interface CrossLinksIndex {
  /** downstream RPC: from.repo → links[] */
  downstreamRpc: Map<string, CrossLink[]>;
  /** upstream RPC: to.repo → links[] */
  upstreamRpc: Map<string, CrossLink[]>;
  /** downstream topic: to.repo → links[] (producer side) */
  downstreamTopic: Map<string, CrossLink[]>;
  /** upstream topic: from.repo → links[] (consumer side) */
  upstreamTopic: Map<string, CrossLink[]>;
}

function buildCrossLinksIndex(crossLinks: CrossLink[]): CrossLinksIndex {
  const idx: CrossLinksIndex = {
    downstreamRpc: new Map(),
    upstreamRpc: new Map(),
    downstreamTopic: new Map(),
    upstreamTopic: new Map(),
  };
  for (const link of crossLinks) {
    if (link.type === 'topic') {
      // downstream topic: producer(to) is local → consumer(from) is remote
      const dtKey = link.to.repo;
      if (!idx.downstreamTopic.has(dtKey)) idx.downstreamTopic.set(dtKey, []);
      idx.downstreamTopic.get(dtKey)!.push(link);
      // upstream topic: consumer(from) is local → producer(to) is remote
      const utKey = link.from.repo;
      if (!idx.upstreamTopic.has(utKey)) idx.upstreamTopic.set(utKey, []);
      idx.upstreamTopic.get(utKey)!.push(link);
    } else {
      // downstream RPC: consumer(from) is local → provider(to) is remote
      const drKey = link.from.repo;
      if (!idx.downstreamRpc.has(drKey)) idx.downstreamRpc.set(drKey, []);
      idx.downstreamRpc.get(drKey)!.push(link);
      // upstream RPC: provider(to) is local → consumer(from) is remote
      const urKey = link.to.repo;
      if (!idx.upstreamRpc.has(urKey)) idx.upstreamRpc.set(urKey, []);
      idx.upstreamRpc.get(urKey)!.push(link);
    }
  }
  return idx;
}

/**
 * Find cross-repo hops by matching BFS-visited file paths against
 * contracts.json crossLinks (using pre-built index).
 *
 * For RPC (thrift/http/grpc):
 *   - downstream: from.repo == currentRepo (consumer calls provider)
 *   - upstream: to.repo == currentRepo (provider is called by consumer)
 *
 * For MQ (topic):
 *   - Data flows from producer (to) → consumer (from), opposite to RPC.
 *   - downstream: to.repo == currentRepo (producer sends to consumer)
 *   - upstream: from.repo == currentRepo (consumer receives from producer)
 *
 * Topic hop deduplication: For topic-type crossLinks, multiple consumers in the
 * same target repo (e.g. different consumer groups on the same topic) produce
 * duplicate hops.  We dedup by (contractType, targetRepo) for topics, keeping
 * only the first hop per target repo per topic contractId.
 */
function findCrossRepoHopsFromRegistry(
  crossLinksIndex: CrossLinksIndex,
  repoPath: string,
  visitedFilePaths: Set<string>,
  direction: 'downstream' | 'upstream',
): TraceCrossHop[] {
  const hops: TraceCrossHop[] = [];
  const seen = new Set<string>();

  // Gather only the links relevant to this repo+direction from the pre-built index
  const rpcLinks = direction === 'downstream'
    ? (crossLinksIndex.downstreamRpc.get(repoPath) ?? [])
    : (crossLinksIndex.upstreamRpc.get(repoPath) ?? []);
  const topicLinks = direction === 'downstream'
    ? (crossLinksIndex.downstreamTopic.get(repoPath) ?? [])
    : (crossLinksIndex.upstreamTopic.get(repoPath) ?? []);

  // Process RPC links
  for (const link of rpcLinks) {
    const localEndpoint = direction === 'downstream' ? link.from : link.to;
    const remoteEndpoint = direction === 'downstream' ? link.to : link.from;

    if (remoteEndpoint.repo === repoPath) continue; // skip self-links
    if (!visitedFilePaths.has(localEndpoint.symbolRef.filePath)) continue;

    const key = `${link.contractId}::${repoPath}->${remoteEndpoint.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hops.push({
      contractId: link.contractId,
      contractType: link.type,
      matchType: link.matchType,
      linkConfidence: link.confidence,
      from: { repo: link.from.repo, symbolUid: link.from.symbolUid, symbolName: link.from.symbolRef.name },
      to: { repo: link.to.repo, symbolUid: link.to.symbolUid, symbolName: link.to.symbolRef.name },
    });
  }

  // Process topic/MQ links (match at repo level, no file path check)
  for (const link of topicLinks) {
    const remoteEndpoint = direction === 'downstream' ? link.from : link.to;

    if (remoteEndpoint.repo === repoPath) continue; // skip self-links

    const key = `topic::${link.contractId}::${remoteEndpoint.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hops.push({
      contractId: link.contractId,
      contractType: link.type,
      matchType: link.matchType,
      linkConfidence: link.confidence,
      from: { repo: link.from.repo, symbolUid: link.from.symbolUid, symbolName: link.from.symbolRef.name },
      to: { repo: link.to.repo, symbolUid: link.to.symbolUid, symbolName: link.to.symbolRef.name },
    });
  }

  return hops;
}

// ---------------------------------------------------------------------------
// Segment processing (extracted for parallel execution)
// ---------------------------------------------------------------------------

type QueueItem = { repoPath: string; symbolName: string; crossDepth: number; isTopic?: boolean };

interface SegmentResult {
  repoPath: string;
  skipped: boolean;
  segment?: TraceRepoSegment;
}

/**
 * Process a single cross-repo segment: resolve repo → init lbug → resolve
 * symbol → BFS → find crossHops.  Does NOT close lbug — caller manages
 * pool lifecycle via openedRepoIds.
 */
async function processOneSegment(
  item: QueueItem,
  config: GroupConfig,
  deps: TraceDeps,
  crossLinksIndex: CrossLinksIndex,
  direction: 'downstream' | 'upstream',
  maxDepth: number,
  relationTypes: string[],
  includeTests: boolean,
  minConfidence: number,
  openedRepoIds: string[],
): Promise<SegmentResult> {
  const regName = config.repos[item.repoPath];
  if (!regName) {
    return { repoPath: item.repoPath, skipped: true };
  }

  let repoHandle: GroupRepoHandle;
  try {
    repoHandle = await deps.port.resolveRepo(regName);
  } catch {
    return { repoPath: item.repoPath, skipped: true };
  }

  // Init lbug
  const dbPath = `${repoHandle.storagePath}/lbug`;
  try {
    await initLbug(repoHandle.id, dbPath);
    if (!openedRepoIds.includes(repoHandle.id)) {
      openedRepoIds.push(repoHandle.id);
    }
  } catch {
    return { repoPath: item.repoPath, skipped: true };
  }

  try {
    // Resolve the target symbol by name in this repo's lbug.
    // For topic/MQ hops, symbolName is "mafkaConsumer(...)" or "mafkaProducer(...)"
    // which won't exist in LadybugDB (it stores Java symbols). In that case we
    // skip resolveByName and still add the repo as a segment (with empty nodes)
    // so we can discover further crossHops from this repo.
    let nodes: TraceNode[] = [];
    let visitedFilePaths: Set<string> = new Set();
    let entrySymbolUid = item.symbolName; // fallback for topic hops

    if (item.isTopic && !isUnresolvableSymbolName(item.symbolName)) {
      // Topic hop WITH a real method/class name (from enriched TopicExtractor).
      // Attempt to resolve and BFS like a normal RPC hop. If resolution fails,
      // fall back to the empty-segment behaviour (still discover crossHops).
      const targetSym = await resolveByName(repoHandle.id, item.symbolName);
      if (targetSym) {
        logger.info(
          `[trace] topic hop resolved "${item.symbolName}" in "${item.repoPath}" → BFS from ${targetSym.id}`,
        );
        entrySymbolUid = targetSym.id;
        const bfsResult = await intraRepoBFS(
          repoHandle.id,
          [targetSym.id],
          targetSym.filePath ? [targetSym.filePath] : [],
          direction,
          { maxDepth, relationTypes, includeTests, minConfidence },
        );
        nodes = bfsResult.nodes;
        visitedFilePaths = bfsResult.visitedFilePaths;
      } else {
        logger.info(
          `[trace] topic hop to repo "${item.repoPath}" — "${item.symbolName}" not found in lbug, empty segment`,
        );
      }
    } else if (item.isTopic) {
      // Topic hop with unresolvable symbol name (e.g. "mafkaConsumer(topicName)")
      // — no BFS possible, but still discover crossHops at repo level
      logger.info(
        `[trace] topic hop to repo "${item.repoPath}" — skipping resolveByName for "${item.symbolName}"`,
      );
    } else {
      const targetSym = await resolveByName(repoHandle.id, item.symbolName);
      if (!targetSym) {
        logger.warn(
          `[trace] symbol "${item.symbolName}" not found in lbug for repo "${item.repoPath}", skipping`,
        );
        return { repoPath: item.repoPath, skipped: true };
      }

      entrySymbolUid = targetSym.id;

      // BFS within this repo
      const bfsResult = await intraRepoBFS(
        repoHandle.id,
        [targetSym.id],
        targetSym.filePath ? [targetSym.filePath] : [],
        direction,
        { maxDepth, relationTypes, includeTests, minConfidence },
      );
      nodes = bfsResult.nodes;
      visitedFilePaths = bfsResult.visitedFilePaths;
    }

    // Find cross-repo hops via pre-built index
    const crossHops = findCrossRepoHopsFromRegistry(
      crossLinksIndex, item.repoPath, visitedFilePaths, direction,
    );

    return {
      repoPath: item.repoPath,
      skipped: false,
      segment: {
        repo: regName,
        repoPath: item.repoPath,
        entrySymbolUid,
        nodes,
        crossHops,
      },
    };
  } finally {
    // Don't close here — trace maintains all opened repos until runGroupTrace
    // completes, then closes them all. LRU eviction handles pool pressure
    // (MAX_POOL_SIZE=5). Some segments may lose their pool entry mid-BFS,
    // causing partial traversal (warn + break) which is acceptable.
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a cross-repo call trace starting from a symbol in one repo,
 * following CALLS edges within each repo and jumping across repos
 * via contracts.json crossLinks.
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

  // Load contracts.json for cross-repo lookups and build index
  const registry = await readContractRegistry(groupDir);
  const crossLinks = registry?.crossLinks ?? [];
  if (crossLinks.length === 0) {
    logger.warn(`[trace] No crossLinks in contracts.json for group "${name}". Cross-repo hops disabled.`);
  }
  const crossLinksIndex = buildCrossLinksIndex(crossLinks);

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
  const visitedRepos = new Set<string>(); // repo + symbolName to avoid cycles
  let truncated = false;

  // Queue: each item is a (repoPath, symbolName) to trace into
  const queue: QueueItem[] = [];

  // Track all opened repos for cleanup at end of trace
  const openedRepoIds: string[] = [];

  try {
  // --- Phase 1: entry repo ---
  const entryDbPath = `${entryRepo.storagePath}/lbug`;
  await initLbug(entryRepo.id, entryDbPath);
  openedRepoIds.push(entryRepo.id);

  // Resolve entry symbol
  const entrySym = await resolveEntrySymbol(entryRepo.id, target);
  if (!entrySym) {
    return { error: `Symbol "${target}" not found in repo "${entryRepoPath}".` };
  }

  // BFS within entry repo
  const bfsResult = await intraRepoBFS(
    entryRepo.id,
    [entrySym.id],
    entrySym.filePath ? [entrySym.filePath] : [],
    direction,
    { maxDepth, relationTypes, includeTests, minConfidence },
  );
  const entryNodes = bfsResult.nodes;
  const entryVisitedFilePaths = bfsResult.visitedFilePaths;

  // Find cross-repo hops via pre-built index
  const entryCrossHops = findCrossRepoHopsFromRegistry(
    crossLinksIndex, entryRepoPath, entryVisitedFilePaths, direction,
  );

  segments.push({
    repo: entryRegistryName,
    repoPath: entryRepoPath,
    entrySymbolUid: entrySym.id,
    nodes: entryNodes,
    crossHops: entryCrossHops,
  });

  // Enqueue cross-repo targets
  for (const hop of entryCrossHops) {
    const isTopic = hop.contractType === 'topic';
    const targetEndpoint = isTopic
      ? (direction === 'downstream' ? hop.from : hop.to)
      : (direction === 'downstream' ? hop.to : hop.from);
    const key = isTopic
      ? `topic::${targetEndpoint.repo}`
      : `${targetEndpoint.repo}::${targetEndpoint.symbolName}`;
    if (!visitedRepos.has(key)) {
      visitedRepos.add(key);
      queue.push({
        repoPath: targetEndpoint.repo,
        symbolName: targetEndpoint.symbolName,
        crossDepth: 1,
        isTopic,
      });
    }
  }

  // --- Phase 2+: cross-repo BFS (layer-parallel) ---
  // Process segments in parallel batches. PARALLEL_LIMIT=4 leaves 1 pool
  // slot for the entry repo (still in pool from Phase 1). LRU eviction
  // may close idle repos mid-BFS (causing partial traversal at deeper
  // depths) but this is tolerable — the main speedup comes from:
  //   1. CrossLinks index: O(1) repo lookup vs O(N=2354) full scan
  //   2. Parallelism: 4 segments BFS concurrently
  const PARALLEL_LIMIT = 4;

  while (queue.length > 0) {
    // Drain current layer (all items at the same crossDepth)
    const currentDepth = queue[0].crossDepth;
    const layer: QueueItem[] = [];
    while (queue.length > 0 && queue[0].crossDepth === currentDepth) {
      layer.push(queue.shift()!);
    }

    if (maxCrossDepth > 0 && currentDepth > maxCrossDepth) {
      truncated = true;
      continue; // skip entire layer
    }

    // Group layer items by repoPath to batch-process same-repo items together.
    // This avoids redundant initLbug/eviction cycles: all items for a given
    // repo share one init, and different repo-groups run in parallel batches.
    const repoGroups = new Map<string, QueueItem[]>();
    for (const item of layer) {
      const existing = repoGroups.get(item.repoPath);
      if (existing) existing.push(item);
      else repoGroups.set(item.repoPath, [item]);
    }
    const groupKeys = [...repoGroups.keys()];

    // Process repo-groups in parallel batches of PARALLEL_LIMIT.
    // Each group may contain multiple items for the same repo — they are
    // processed sequentially within the group (single init, multiple BFS).
    for (let batchStart = 0; batchStart < groupKeys.length; batchStart += PARALLEL_LIMIT) {
      const batchKeys = groupKeys.slice(batchStart, batchStart + PARALLEL_LIMIT);

      const batchResults = await Promise.all(
        batchKeys.map(async (repoPath) => {
          const items = repoGroups.get(repoPath)!;
          const results: SegmentResult[] = [];
          for (const item of items) {
            results.push(await processOneSegment(
              item, config, deps, crossLinksIndex, direction,
              maxDepth, relationTypes, includeTests, minConfidence,
              openedRepoIds,
            ));
          }
          return results;
        }),
      );

      // Collect results and enqueue next-layer items
      for (const groupResults of batchResults) {
        for (const result of groupResults) {
          if (result.skipped) {
            skippedRepos.push(result.repoPath);
            continue;
          }
          if (result.segment) {
            segments.push(result.segment);
          }
          // Enqueue further cross-repo targets for the NEXT layer
          for (const hop of (result.segment?.crossHops ?? [])) {
            const isTopicHop = hop.contractType === 'topic';
            const nextEndpoint = isTopicHop
              ? (direction === 'downstream' ? hop.from : hop.to)
              : (direction === 'downstream' ? hop.to : hop.from);
            const key = isTopicHop
              ? `topic::${nextEndpoint.repo}`
              : `${nextEndpoint.repo}::${nextEndpoint.symbolName}`;
            if (!visitedRepos.has(key)) {
              visitedRepos.add(key);
              queue.push({
                repoPath: nextEndpoint.repo,
                symbolName: nextEndpoint.symbolName,
                crossDepth: currentDepth + 1,
                isTopic: isTopicHop,
              });
            }
          }
        }
      }
    }
  }

  } finally {
    // Close all lbug connections opened during this trace
    for (const rid of openedRepoIds) {
      await closeLbug(rid).catch(() => {});
    }
  }

  // Filter out repos that actually produced segments (avoid false "skipped" reports
  // when a repo is entered multiple times with different symbols — some succeed, some fail).
  const reposWithSegments = new Set(segments.map((s) => s.repoPath));
  const actuallySkipped = [...new Set(skippedRepos)].filter((r) => !reposWithSegments.has(r));

  return {
    group: name,
    entryRepo: entryRepoPath,
    entryTarget: target,
    direction,
    segments,
    skippedRepos: actuallySkipped,
    truncated,
  };
}
