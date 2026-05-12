import { glob } from 'glob';
import Parser from 'tree-sitter';
import { createIgnoreFilter } from '../../../config/ignore-service.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import { scanFile, unquoteLiteral } from './tree-sitter-scanner.js';
import {
  TOPIC_SCAN_GLOB,
  getProviderForFile,
  type Broker,
  type TopicMeta,
} from './topic-patterns/index.js';

/**
 * Walk up the AST parent chain from `startNode` looking for the enclosing
 * method and class declarations. Returns "ClassName.methodName" if both are
 * found, or partial forms ("ClassName" / "methodName") if only one is.
 * Returns `null` when neither is reachable.
 */
function resolveEnclosingSymbol(startNode: Parser.SyntaxNode): string | null {
  let methodName: string | null = null;
  let className: string | null = null;
  let current: Parser.SyntaxNode | null = startNode;

  while (current) {
    if (
      !methodName &&
      (current.type === 'method_declaration' || current.type === 'function_declaration')
    ) {
      const nameNode = current.childForFieldName('name');
      if (nameNode) methodName = nameNode.text;
    }
    if (
      !className &&
      (current.type === 'class_declaration' ||
        current.type === 'interface_declaration' ||
        current.type === 'enum_declaration')
    ) {
      const nameNode = current.childForFieldName('name');
      if (nameNode) className = nameNode.text;
    }
    if (methodName && className) break;
    current = current.parent;
  }

  if (className && methodName) return `${className}.${methodName}`;
  if (className) return className;
  if (methodName) return methodName;
  return null;
}

/**
 * Language-agnostic orchestrator for topic (message broker) contract
 * extraction. All grammar-specific knowledge lives in `topic-patterns/*`
 * — this file must not import any tree-sitter grammar directly.
 *
 * Flow per file:
 *   1. `getProviderForFile(rel)` → compiled plugin (or `undefined` if the
 *      file's extension isn't registered, in which case we skip it).
 *   2. `scanFile(parser, provider, content)` → list of `{meta, valueText}`
 *      pairs, one per matched literal.
 *   3. `unquoteLiteral(valueText)` → the raw topic string.
 *   4. `makeContract(topic, meta, relPath)` → `ExtractedContract`.
 *
 * Adding a new language is a one-file edit in `topic-patterns/index.ts`.
 */

function makeContract(topicName: string, meta: TopicMeta, filePath: string): ExtractedContract {
  return {
    contractId: `topic::${topicName}`,
    type: 'topic',
    role: meta.role,
    symbolUid: '',
    symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: meta.symbolName },
    symbolName: meta.symbolName,
    confidence: meta.confidence,
    meta: {
      broker: meta.broker satisfies Broker,
      topicName,
      extractionStrategy: 'tree_sitter',
    },
  };
}

export class TopicExtractor implements ContractExtractor {
  type = 'topic' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    // Honour `.gitnexusignore` / `.gitignore` via the shared IgnoreService —
    // mirrors `filesystem-walker.ts`. The 5-name hardcoded list
    // (`node_modules, .git, vendor, dist, build`) is preserved because every
    // entry is in `DEFAULT_IGNORE_LIST`, so default behaviour is unchanged
    // (#1185). The Go-specific `**/*_test.go` filter is layered on top via a
    // small wrapper so glob-level pruning is preserved (we never read those
    // files); the wrapper short-circuits before calling the base filter.
    const baseFilter = await createIgnoreFilter(repoPath);
    const ignoreFilter: typeof baseFilter = {
      ignored: (p) => p.relative().endsWith('_test.go') || baseFilter.ignored(p),
      childrenIgnored: (p) => baseFilter.childrenIgnored(p),
    };
    const files = await glob(TOPIC_SCAN_GLOB, {
      cwd: repoPath,
      ignore: ignoreFilter,
      nodir: true,
    });

    // One parser reused across files; the scanner calls `setLanguage` per
    // file based on which plugin the registry returns.
    const parser = new Parser();
    const out: ExtractedContract[] = [];

    for (const rel of files) {
      const provider = getProviderForFile(rel);
      if (!provider) continue;

      const content = readSafe(repoPath, rel);
      if (!content) continue;

      const matches = scanFile(parser, provider, content);
      for (const match of matches) {
        const valueNode = match.captures.value;
        if (!valueNode) continue;
        const topicName = unquoteLiteral(valueNode.text);
        if (!topicName) continue;

        // Enrich meta with actual enclosing method/class name from the AST.
        // This allows cross-repo hops to resolve the consumer method in LadybugDB
        // instead of producing an unresolvable "mafkaConsumer(topic)" symbol.
        const enclosing = resolveEnclosingSymbol(valueNode);
        const enrichedMeta: TopicMeta = enclosing
          ? { ...match.meta, symbolName: enclosing }
          : match.meta;

        out.push(makeContract(topicName, enrichedMeta, rel));
      }
    }

    return this.dedupe(out);
  }

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    const out: ExtractedContract[] = [];
    for (const c of items) {
      const k = `${c.contractId}|${c.role}|${c.symbolRef.filePath}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }
}
