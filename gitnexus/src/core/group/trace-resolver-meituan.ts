/**
 * Meituan-internal symbol resolver for cross-repo trace.
 *
 * Extends DefaultSymbolResolver with Meituan-specific framework patterns:
 * Thrift / Mafka / Crane / Squirrel / MDP naming conventions.
 *
 * Not submitted to the upstream gitnexus repository. Internal use only.
 */

import { executeParameterized } from '../lbug/pool-adapter.js';
import { logger } from '../logger.js';
import { DefaultSymbolResolver } from './trace-resolver.js';
import type { SymbolCandidate, ResolvedSymbol, ResolveContext } from './trace-resolver.js';

// ---------------------------------------------------------------------------
// Helpers (Meituan-specific)
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

export class MeituanSymbolResolver extends DefaultSymbolResolver {

  // ---- isClientPath (Meituan: adds -thrift-common/ and -thrift-inner/) ----

  protected override isClientPath(fp: string): boolean {
    if (super.isClientPath(fp)) return true;
    const f = (fp || '').toLowerCase();
    return f.includes('-thrift-common/') || f.includes('-thrift-inner/');
  }

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

  override scoreCandidate(c: SymbolCandidate, classVariants?: string[], target?: string): number {
    let s = super.scoreCandidate(c, classVariants, target);

    // Thrift server entry points
    const idLower = c.id.toLowerCase();
    if (idLower.includes('thriftserver') || idLower.includes('thriftserviceimpl') || idLower.includes('rpcserviceimpl')) {
      s += 30;
    }
    if (isIfaceOrThriftDef(c)) s -= 200;

    // Meituan client/IDL module penalty (covers -thrift-common/, -thrift-inner/, versioned jars)
    if (this.isClientPath(c.filePath)) s -= 100;

    // Internal utility patterns
    const combined = `${c.id.toLowerCase()}|${(c.filePath || '').toLowerCase()}`;
    if (
      combined.includes('jsonutils') || combined.includes('paramvalidate') ||
      combined.includes('loggerutil') || combined.includes('logutil')
    ) s -= 80;

    return s;
  }

  // ---- resolveSymbolByName ----

  override async resolveSymbolByName(
    repoId: string,
    symbolName: string,
    context: ResolveContext,
  ): Promise<ResolvedSymbol | null> {
    // Delegate to parent for standard resolution first
    const result = await super.resolveSymbolByName(repoId, symbolName, context);
    if (result) {
      // If resolved to a client/IDL module, try server-impl fallback
      if (this.isClientPath(result.filePath)) {
        logger.info(`[trace] resolveSymbolByName "${symbolName}": resolved to client path, trying server-impl fallback`);
        const serverSym = await this._resolveServerImpl(repoId, symbolName);
        if (serverSym) return serverSym;
      }
      return result;
    }

    // Meituan fallback: fuzzy MQ consumer resolution (no-dot symbolName only)
    const lastDot = symbolName.lastIndexOf('.');
    if (lastDot >= 0) return null;

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

    return fuzzyResolveConsumerClass(repoId, symbolName, findHandlerMethodInFile);
  }

  /** Server-side implementation fallback: when resolveSymbolByName resolves to a
   *  client/IDL module, re-search by short name and prefer -server/-service paths. */
  private async _resolveServerImpl(
    repoId: string,
    symbolName: string,
  ): Promise<ResolvedSymbol | null> {
    const lastDot = symbolName.lastIndexOf('.');
    const shortName = lastDot >= 0 ? symbolName.slice(lastDot + 1) : symbolName;
    if (!shortName) return null;

    const rows = await executeParameterized(
      repoId,
      `MATCH (n) WHERE n.name = $name
       RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath`,
      { name: shortName },
    );
    if (rows.length === 0) return null;

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
      .filter((c) => !this.isClientPath(c.filePath) && !isTestPath(c.filePath));

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
    const drilled = await this.drillDownToMethod(repoId, best, shortName);
    logger.info(
      `[trace] resolveServerImpl fallback: "${symbolName}" → "${drilled.id}" ` +
      `(score=${best.score}, ${scored.length} server candidates from ${rows.length} total)`,
    );
    return drilled;
  }
}
