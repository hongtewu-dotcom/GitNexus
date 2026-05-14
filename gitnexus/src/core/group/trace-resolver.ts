/**
 * Meituan-specific symbol resolver for cross-repo trace.
 *
 * This module contains all framework-aware logic (Thrift / Mafka / Crane /
 * Squirrel naming conventions) that would otherwise be hard-coded inside
 * trace.ts.  trace.ts itself remains framework-agnostic: it calls the
 * SymbolResolver interface and knows nothing about concrete framework patterns.
 *
 * To support a new middleware or RPC framework, implement SymbolResolver and
 * pass it to runGroupTraceWithResolver — no changes to the BFS engine needed.
 */

import { executeParameterized } from '../lbug/pool-adapter.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SymbolCandidate = { id: string; name: string; type: string; filePath: string };
export type ResolvedSymbol  = { id: string; name: string; type: string; filePath: string };

/**
 * Context passed to resolveSymbolByName.
 * Carries hints extracted from contracts.json so the resolver can skip
 * heuristic scoring when precise data is available.
 */
export interface ResolveContext {
  /** contracts.json symbolRef.filePath for the target endpoint (may be client-side) */
  hintFilePath?: string;
  /** true when the hop originates from a topic/MQ crossLink */
  isTopic?: boolean;
}

/**
 * Pluggable symbol-resolution strategy.
 *
 * All methods are optional.  When a method is absent the BFS engine falls back
 * to a minimal built-in behaviour described in each comment.
 */
export interface SymbolResolver {
  /**
   * Return true when symbolName is a synthetic, non-Java identifier that will
   * never exist in LadybugDB (e.g. "mafkaConsumer(topic)", "crane.task.foo").
   * Fallback: always return false (attempt resolution for every name).
   */
  isUnresolvableSymbolName?: (symbolName: string) => boolean;

  /**
   * Score a candidate symbol node for BFS entry quality.
   * Higher score = better entry point.
   * Fallback: all candidates score 0 (first candidate in DB order is used).
   */
  scoreCandidate?: (
    candidate: SymbolCandidate,
    classVariants?: string[],
    targetName?: string,
  ) => number;

  /**
   * Resolve a cross-repo hop symbolName to a concrete lbug Method node.
   * Called by processOneSegment for each non-entry hop.
   *
   * Return null to skip this segment (treated as unresolvable).
   * Fallback: exact n.name match with LIMIT 1.
   */
  resolveSymbolByName?: (
    repoId: string,
    symbolName: string,
    context: ResolveContext,
  ) => Promise<ResolvedSymbol | null>;

  /**
   * Given a class/interface node, return the best Method node in the same file
   * for BFS seeding.  Called from resolveEntrySymbols when a candidate is a
   * non-Method node.
   * Fallback: return the node unchanged.
   */
  drillDownToMethod?: (
    repoId: string,
    node: SymbolCandidate,
    preferredMethodName?: string,
  ) => Promise<ResolvedSymbol>;
}

// ---------------------------------------------------------------------------
// DefaultSymbolResolver — Meituan-specific implementation
// ---------------------------------------------------------------------------

/** Detect Thrift Iface / interface definitions (dead-end for BFS). */
function isIfaceOrThriftDef(c: SymbolCandidate): boolean {
  if (c.id.includes('Iface.') || c.id.includes(':Iface.')) return true;
  const fp = c.filePath || '';
  if (fp.includes('-thrift/') || fp.includes('_thrift/')) return true;
  return false;
}

/** Tokenize a symbol name (PascalCase / camelCase / snake_case) into lowercase tokens. */
function tokenizeSymbolName(name: string): string[] {
  const normalized = name.replace(/_/g, ' ');
  return normalized
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

const CONSUMER_NOISE_TOKENS = new Set([
  'listener', 'consumer', 'process', 'processor', 'handler',
  'service', 'impl', 'mafka', 'mq', 'kafka', 'abstract', 'base',
]);

/**
 * Fuzzy-resolve a Mafka/MQ consumer class when symbolName (from properties
 * listenerId) doesn't match any node exactly.
 */
async function fuzzyResolveConsumerClass(
  repoId: string,
  symbolName: string,
  findHandlerMethodInFile: (cls: SymbolCandidate) => Promise<ResolvedSymbol>,
): Promise<ResolvedSymbol | null> {
  const inputTokens = tokenizeSymbolName(symbolName);
  const coreTokens = inputTokens.filter((t) => !CONSUMER_NOISE_TOKENS.has(t));
  if (coreTokens.length === 0) return null;

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

  const NON_CONSUMER_SUFFIXES = ['Model', 'Dto', 'DTO', 'VO', 'Entity', 'Request', 'Response', 'Result', 'Param', 'Config', 'Message'];
  const PRODUCER_INDICATORS = ['Producer', 'Sender', 'Publisher'];

  let bestScore = 0;
  let bestCandidate: SymbolCandidate | null = null;

  for (const row of candidates) {
    const candidateName = (row.name ?? row[1]) as string;
    if (NON_CONSUMER_SUFFIXES.some((s) => candidateName.endsWith(s))) continue;
    if (PRODUCER_INDICATORS.some((ind) => candidateName.includes(ind))) continue;

    const candidateTokens = tokenizeSymbolName(candidateName).filter((t) => !CONSUMER_NOISE_TOKENS.has(t));
    let matchCount = 0;
    for (const ct of coreTokens) {
      if (candidateTokens.includes(ct)) matchCount++;
    }
    const score = matchCount / Math.max(coreTokens.length, candidateTokens.length || 1);

    const nodeId = (row.id ?? row[0]) as string;
    const isClass = nodeId.startsWith('Class:');
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

  if (!bestCandidate || bestScore < 0.4) {
    const viable = candidates.filter((row) => {
      const name = (row.name ?? row[1]) as string;
      if (NON_CONSUMER_SUFFIXES.some((s) => name.endsWith(s))) return false;
      if (PRODUCER_INDICATORS.some((ind) => name.includes(ind))) return false;
      return true;
    });
    if (viable.length === 1) {
      const sole = viable[0];
      const soleId = (sole.id ?? sole[0]) as string;
      const soleName = (sole.name ?? sole[1]) as string;
      const soleCandidate: SymbolCandidate = {
        id: soleId, name: soleName,
        type: soleId.startsWith('Class:') ? 'Class' : 'Interface',
        filePath: (sole.filePath ?? sole[2]) as string,
      };
      logger.info(`[trace] fuzzyResolveConsumerClass: "${symbolName}" → "${soleName}" (sole-consumer fallback)`);
      return findHandlerMethodInFile(soleCandidate);
    }
    logger.info(
      `[trace] fuzzyResolveConsumerClass: no match for "${symbolName}" ` +
      `(best=${bestScore.toFixed(2)}, coreTokens=[${coreTokens.join(',')}], viable=${viable.length})`,
    );
    return null;
  }

  logger.info(`[trace] fuzzyResolveConsumerClass: "${symbolName}" → "${bestCandidate.name}" (score=${bestScore.toFixed(2)})`);
  return findHandlerMethodInFile(bestCandidate);
}

// ---------------------------------------------------------------------------

export class DefaultSymbolResolver implements SymbolResolver {

  // ---- isUnresolvableSymbolName ----

  isUnresolvableSymbolName(symbolName: string): boolean {
    if (/^mafka(?:Producer|Consumer)\(/.test(symbolName)) return true;
    if (
      symbolName === 'kafkaListener' ||
      symbolName === 'kafkaTemplate.send' ||
      symbolName === 'rabbitTemplate.convertAndSend' ||
      symbolName === 'MdpMafkaConsumer' ||
      symbolName === 'MdpMafkaProducer' ||
      symbolName === 'ConsumeMessage' ||
      symbolName === 'rabbitListener'
    ) return true;
    if (symbolName.includes('@') || symbolName.startsWith('crane.task.')) return true;
    if (symbolName.startsWith('squirrel.')) return true;
    if ((symbolName.match(/\./g) ?? []).length >= 3 && symbolName[0] === symbolName[0].toLowerCase()) return true;
    return false;
  }

  // ---- scoreCandidate ----

  scoreCandidate(c: SymbolCandidate, classVariants?: string[], target?: string): number {
    let s = 0;
    const idAndPath = `${c.id}|${c.filePath}`;

    if (classVariants) {
      for (const variant of classVariants) {
        if (idAndPath.includes(variant)) { s += 100; break; }
      }
    }

    // Method nodes are preferred over Class/Interface nodes
    const nodeType = c.type || (c.id.indexOf(':') > 0 ? c.id.slice(0, c.id.indexOf(':')) : '');
    if (nodeType === 'Method') s += 10;

    if (c.filePath && (c.filePath.includes('-server/') || c.filePath.includes('-service/'))) s += 50;
    if (c.filePath && (c.filePath.toLowerCase().includes('impl') || c.filePath.includes('-impl/'))) s += 20;

    // Thrift server entry points
    const idLower = c.id.toLowerCase();
    if (idLower.includes('thriftserver') || idLower.includes('thriftserviceimpl') || idLower.includes('rpcserviceimpl')) {
      s += 30;
    }
    if (/gateway|delegate|adapter|proxy|wrapper/i.test(c.id)) s -= 15;

    // Semantic relevance via PascalCase target name
    if (target && target.length > 0) {
      const pascalTarget = target[0].toUpperCase() + target.slice(1);
      if (idAndPath.includes(pascalTarget)) s += 40;
    }

    if (isIfaceOrThriftDef(c)) s -= 200;
    if (c.filePath && (c.filePath.includes('-client/') || c.filePath.includes('-client-'))) s -= 60;

    // Utility / DTO penalty (reuse logic inline to avoid importing from trace.ts)
    const combined = `${c.id.toLowerCase()}|${(c.filePath || '').toLowerCase()}`;
    if (
      /utils?[./|]/.test(combined) || /enum[./|]/.test(combined) ||
      /validate[./|]/.test(combined) || /convert[./|]/.test(combined) ||
      /dto[./|]/.test(combined) || /entity[./|]/.test(combined) ||
      /\.set[A-Z]/.test(c.id) || /\.get[A-Z]/.test(c.id) || /\.is[A-Z]/.test(c.id) ||
      combined.includes('jsonutils') || combined.includes('paramvalidate') ||
      combined.includes('loggerutil') || combined.includes('logutil')
    ) s -= 80;

    // Test file penalty
    const lower = (c.filePath || '').toLowerCase();
    if (
      lower.includes('/test/') || lower.includes('/tests/') || lower.includes('/__tests__/') ||
      lower.includes('.test.') || lower.includes('.spec.') || lower.includes('_test.')
    ) s -= 50;

    return s;
  }

  // ---- drillDownToMethod ----

  async drillDownToMethod(
    repoId: string,
    node: SymbolCandidate,
    preferredMethodName?: string,
  ): Promise<ResolvedSymbol> {
    if (node.id.startsWith('Method:')) return node;
    if (!node.filePath) return node;

    const methods = await executeParameterized(
      repoId,
      `MATCH (m:Method) WHERE m.filePath = $fp
       RETURN m.id AS id, m.name AS name, labels(m)[0] AS type, m.filePath AS filePath`,
      { fp: node.filePath },
    );
    if (methods.length === 0) return node;

    const handlerNames = new Set([
      'handleMessage', 'onRecvMessage', 'consume', 'onMessage',
      'process', 'execute', 'run',
    ]);

    let bestMethod: Record<string, unknown> | null = null;
    let bestScore = -Infinity;

    for (const m of methods) {
      const mName = (m.name ?? m[1]) as string;
      const mId   = (m.id   ?? m[0]) as string;
      let score = 0;
      if (preferredMethodName && mName === preferredMethodName) score += 200;
      if (handlerNames.has(mName)) score += 100;
      if (mId.includes('Impl') || mId.includes('Server')) score += 20;
      if (/^(get|set|is|toString|hashCode|equals)/.test(mName)) score -= 50;
      if (mName === '<init>' || mName === '<clinit>') score -= 100;
      if (score > bestScore) { bestScore = score; bestMethod = m; }
    }
    if (!bestMethod) bestMethod = methods[0];

    const result: ResolvedSymbol = {
      id:       (bestMethod.id       ?? bestMethod[0]) as string,
      name:     (bestMethod.name     ?? bestMethod[1]) as string,
      type:     (bestMethod.type     ?? bestMethod[2]) as string,
      filePath: (bestMethod.filePath ?? bestMethod[3]) as string,
    };
    logger.info(`[trace] drillDownToMethod: "${node.id}" → "${result.id}" (${methods.length} methods in file)`);
    return result;
  }

  // ---- resolveSymbolByName ----

  async resolveSymbolByName(
    repoId: string,
    symbolName: string,
    context: ResolveContext,
  ): Promise<ResolvedSymbol | null> {
    const { hintFilePath } = context;

    // isClientModulePath check (inline to avoid circular import from trace.ts)
    const isClientPath = (fp: string) => {
      if (!fp) return false;
      const f = fp.toLowerCase();
      return f.includes('-client/') || f.includes('-client-') || f.includes('_client/') ||
        f.includes('-thrift-common/') || f.includes('-thrift-inner/') ||
        f.includes('/idl/') || f.endsWith('.thrift') ||
        /-api\//.test(f) || /[_-]client\d/.test(f);
    };

    // MQ handler names — used by findHandlerMethodInFile and drillDownToMethod
    const handlerNames = new Set(['handleMessage', 'onRecvMessage', 'consume', 'onMessage', 'process', 'execute', 'run']);

    const findHandlerMethodInFile = async (cls: SymbolCandidate): Promise<ResolvedSymbol> => {
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
        id:       (best.id       ?? best[0]) as string,
        name:     (best.name     ?? best[1]) as string,
        type:     (best.type     ?? best[2]) as string,
        filePath: (best.filePath ?? best[3]) as string,
      };
    };

    // Exact full-name match (rare — lbug usually stores short names)
    const rows = await executeParameterized(
      repoId,
      `MATCH (n) WHERE n.name = $name
       RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
       LIMIT 1`,
      { name: symbolName },
    );
    if (rows.length > 0) {
      const r = rows[0];
      const matched: SymbolCandidate = {
        id:       (r.id       ?? r[0]) as string,
        name:     (r.name     ?? r[1]) as string,
        type:     (r.type     ?? r[2]) as string,
        filePath: (r.filePath ?? r[3]) as string,
      };
      if (matched.id.startsWith('Method:')) return matched;
      return findHandlerMethodInFile(matched);
    }

    const lastDot = symbolName.lastIndexOf('.');
    if (lastDot < 0) {
      // No dot — treat as class name
      const classRow = await executeParameterized(
        repoId,
        `MATCH (c) WHERE c.name = $name
         RETURN c.id AS id, c.name AS name, labels(c)[0] AS type, c.filePath AS filePath
         LIMIT 1`,
        { name: symbolName },
      );
      if (classRow.length > 0) {
        const cls = classRow[0];
        return findHandlerMethodInFile({
          id:       (cls.id       ?? cls[0]) as string,
          name:     (cls.name     ?? cls[1]) as string,
          type:     (cls.type     ?? cls[2]) as string,
          filePath: (cls.filePath ?? cls[3]) as string,
        });
      }
      const fuzzy = await fuzzyResolveConsumerClass(repoId, symbolName, findHandlerMethodInFile);
      return fuzzy;
    }

    const classPrefix = symbolName.slice(0, lastDot);
    const shortName   = symbolName.slice(lastDot + 1);

    const rows2 = await executeParameterized(
      repoId,
      `MATCH (n) WHERE n.name = $name
       RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath`,
      { name: shortName },
    );
    if (rows2.length === 0) {
      // Fallback: search for server-side impl directly
      return this._resolveServerImpl(repoId, symbolName, shortName);
    }

    const candidates: SymbolCandidate[] = rows2.map((r: Record<string, unknown>) => ({
      id:       (r.id       ?? r[0]) as string,
      name:     (r.name     ?? r[1]) as string,
      type:     (r.type     ?? r[2]) as string,
      filePath: (r.filePath ?? r[3]) as string,
    }));

    // Fast path: use hintFilePath to pinpoint server-side candidate directly
    if (hintFilePath && !isClientPath(hintFilePath)) {
      const pinned = candidates.find((c) => c.filePath === hintFilePath);
      if (pinned) {
        logger.info(`[trace] resolveSymbolByName "${symbolName}": pinned via hintFilePath`);
        return this.drillDownToMethod!(repoId, pinned, shortName);
      }
    }

    // Build class-name variants: Service ↔ Server ↔ Impl
    const classVariants = [classPrefix];
    if (classPrefix.endsWith('Service')) {
      classVariants.push(classPrefix.replace(/Service$/, 'Server'), classPrefix.replace(/Service$/, 'Impl'), classPrefix.replace(/Service$/, ''));
    } else if (classPrefix.endsWith('Server')) {
      classVariants.push(classPrefix.replace(/Server$/, 'Service'), classPrefix.replace(/Server$/, 'Impl'), classPrefix.replace(/Server$/, ''));
    } else if (classPrefix.endsWith('Impl')) {
      classVariants.push(classPrefix.replace(/Impl$/, 'Service'), classPrefix.replace(/Impl$/, 'Server'), classPrefix.replace(/Impl$/, ''));
    }

    candidates.sort((a, b) => this.scoreCandidate!(b, classVariants) - this.scoreCandidate!(a, classVariants));

    const best = candidates[0];
    if (candidates.length > 1) {
      logger.info(
        `[trace] resolveSymbolByName "${symbolName}": ${candidates.length} candidates, ` +
        `selected "${best.id}" (score=${this.scoreCandidate!(best, classVariants)}) over ` +
        `${candidates.slice(1).map(c => `"${c.id}"(${this.scoreCandidate!(c, classVariants)})`).join(', ')}`,
      );
    }

    const result = await this.drillDownToMethod!(repoId, best, shortName);

    // If resolved to a client-module symbol and BFS would be empty, try server-side fallback
    if (isClientPath(result.filePath)) {
      logger.info(`[trace] resolveSymbolByName "${symbolName}": resolved to client path, trying server-impl fallback`);
      const serverSym = await this._resolveServerImpl(repoId, symbolName, shortName);
      if (serverSym) return serverSym;
    }

    return result;
  }

  /** Server-side implementation fallback (previously resolveServerImpl). */
  private async _resolveServerImpl(
    repoId: string,
    symbolName: string,
    shortName: string,
  ): Promise<ResolvedSymbol | null> {
    const rows = await executeParameterized(
      repoId,
      `MATCH (n) WHERE n.name = $name
       RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath`,
      { name: shortName },
    );
    if (rows.length === 0) return null;

    const isClientPath = (fp: string) => {
      if (!fp) return false;
      const f = fp.toLowerCase();
      return f.includes('-client/') || f.includes('-client-') || f.includes('_client/') ||
        f.includes('-thrift-common/') || f.includes('-thrift-inner/') ||
        f.includes('/idl/') || f.endsWith('.thrift') || /-api\//.test(f) || /[_-]client\d/.test(f);
    };
    const isTestPath = (fp: string) => {
      const l = (fp || '').toLowerCase();
      return l.includes('/test/') || l.includes('/tests/') || l.includes('_test.');
    };

    const serverCandidates = rows
      .map((r: Record<string, unknown>) => ({
        id:       (r.id       ?? r[0]) as string,
        name:     (r.name     ?? r[1]) as string,
        type:     (r.type     ?? r[2]) as string,
        filePath: (r.filePath ?? r[3]) as string,
      }))
      .filter((c) => !isClientPath(c.filePath) && !isTestPath(c.filePath));

    if (serverCandidates.length === 0) return null;

    const scored = serverCandidates.map((c) => {
      let score = 0;
      if (c.filePath.includes('-server/') || c.filePath.includes('-service/') ||
          c.filePath.includes('_server/') || c.filePath.includes('_service/')) score += 50;
      if (c.id.startsWith('Method:')) score += 10;
      if (c.id.toLowerCase().includes('impl')) score += 20;
      if (c.id.toLowerCase().includes('thriftserver') || c.id.toLowerCase().includes('thriftserviceimpl')) score += 30;
      return { ...c, score };
    });
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    const drilled = await this.drillDownToMethod!(repoId, best, shortName);
    logger.info(
      `[trace] resolveServerImpl fallback: "${symbolName}" → "${drilled.id}" ` +
      `(score=${best.score}, ${scored.length} server candidates from ${rows.length} total)`,
    );
    return drilled;
  }
}
