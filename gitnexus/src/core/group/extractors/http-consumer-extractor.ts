import { glob } from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { compilePatterns, runCompiledPatterns, unquoteLiteral, type LanguagePatterns } from './tree-sitter-scanner.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { normalizeHttpPath } from './http-route-extractor.js';

/**
 * HTTP Consumer Extractor — detects Java code that **calls** other microservices
 * via HTTP, producing role='consumer' contracts that pair with providers found
 * by `HttpRouteExtractor`.
 *
 * Detected patterns:
 *   1. @FeignClient interface declarations with @GetMapping/@PostMapping/... methods
 *   2. RestTemplate.getForObject / postForObject / ... invocations
 *   3. @LoadBalanced WebClient .get()/.post().uri("...") chains
 *
 * The contractId format is `http::<METHOD>::<normalized_path>`, identical to the
 * provider side produced by `HttpRouteExtractor`, so the matching engine can pair
 * them via exact match.
 */

// ─── Feign: class-level @FeignClient path prefix ──────────────────────

const FEIGN_CLIENT_PREFIX_PATTERNS = compilePatterns({
  name: 'java-feign-client-prefix',
  language: Java,
  patterns: [
    // @FeignClient(...)  — capture the interface, then extract path manually
    {
      meta: {},
      query: `
        (interface_declaration
          (modifiers
            (annotation
              name: (identifier) @ann (#eq? @ann "FeignClient")))
          name: (identifier) @iface_name) @iface
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Feign: method-level @XxxMapping annotations inside interface ──────

const FEIGN_METHOD_PATTERNS = compilePatterns({
  name: 'java-feign-method',
  language: Java,
  patterns: [
    // @GetMapping("/detail/{id}")
    {
      meta: {},
      query: `
        (method_declaration
          (modifiers
            (annotation
              name: (identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Mapping$")
              arguments: (annotation_argument_list (string_literal) @path)))
          name: (identifier) @method_name) @method
      `,
    },
    // @RequestMapping(value = "/path", method = RequestMethod.GET)
    {
      meta: {},
      query: `
        (method_declaration
          (modifiers
            (annotation
              name: (identifier) @ann (#eq? @ann "RequestMapping")
              arguments: (annotation_argument_list
                (element_value_pair
                  key: (identifier) @val_key (#eq? @val_key "value")
                  value: (string_literal) @path))))
          name: (identifier) @method_name) @method
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── RestTemplate invocations ─────────────────────────────────────────

const REST_TEMPLATE_METHOD_MAP: Record<string, string> = {
  getForObject: 'GET',
  getForEntity: 'GET',
  exchange: 'GET', // conservative default; exchange can be any method
  postForObject: 'POST',
  postForEntity: 'POST',
  postForLocation: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patchForObject: 'PATCH',
};

const REST_TEMPLATE_PATTERNS = compilePatterns({
  name: 'java-http-consumer-rest-template',
  language: Java,
  patterns: [
    // restTemplate.getForObject("http://service/path", ...)
    {
      meta: {},
      query: `
        (method_invocation
          object: (identifier) @obj
          name: (identifier) @method
          arguments: (argument_list . (string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── WebClient fluent API (get/post/put/delete/patch → uri) ───────────

const WEB_CLIENT_FLUENT_PATTERNS = compilePatterns({
  name: 'java-http-consumer-webclient-fluent',
  language: Java,
  patterns: [
    // webClient.get().uri("/path/to/resource")
    {
      meta: {},
      query: `
        (method_invocation
          object: (method_invocation
            object: (method_invocation
              object: (identifier) @obj
              name: (identifier) @http_method)
            name: (identifier) @retrieve_or_uri_caller)
          name: (identifier) @uri_method (#eq? @uri_method "uri")
          arguments: (argument_list . (string_literal) @path))
      `,
    },
    // webClient.get().uri("/path") — simpler 2-level chain
    {
      meta: {},
      query: `
        (method_invocation
          object: (method_invocation
            object: (identifier) @obj
            name: (identifier) @http_method)
          name: (identifier) @uri_method (#eq? @uri_method "uri")
          arguments: (argument_list . (string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const WEBCLIENT_METHOD_MAP: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
};

// ─── Annotation→method mapping ────────────────────────────────────────

const ANNOTATION_TO_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'GET', // default when method attr not specified
};

// ─── Path normalization (consumer-side) ───────────────────────────────

/**
 * Normalize a consumer-side URL path to match the provider contractId format.
 * Strips protocol+host, collapses path params to `{param}`, and normalizes
 * numeric segments to `{param}`.
 */
function normalizeConsumerUrl(url: string): string {
  let pathOnly = url.trim();

  // Strip protocol + host for absolute URLs like "http://service-name/path"
  if (/^https?:\/\//i.test(pathOnly)) {
    try {
      pathOnly = new URL(pathOnly).pathname;
    } catch {
      pathOnly = pathOnly.replace(/^https?:\/\/[^/]+/i, '');
    }
  }

  // Use the shared normalizer which handles {id}, :id, [id] → {param}
  const normalized = normalizeHttpPath(pathOnly || '/');

  // Additionally collapse pure-numeric segments → {param}
  const segments = normalized
    .split('/')
    .filter(Boolean)
    .map((seg) => (/^\d+$/.test(seg) ? '{param}' : seg));

  return `/${segments.join('/')}`.replace(/\/+$/, '') || '/';
}

function contractIdFor(method: string, pathNorm: string): string {
  return `http::${method.toUpperCase()}::${pathNorm}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Walk up the tree to find the enclosing interface_declaration node.
 */
function findEnclosingInterface(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'interface_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract the `path` element value from an @FeignClient annotation's argument list.
 * Handles both `@FeignClient(path = "/prefix")` and similar patterns.
 */
function extractFeignPath(ifaceNode: Parser.SyntaxNode): string {
  // Walk through modifiers → annotations to find @FeignClient with path= attribute
  const modifiers = ifaceNode.childForFieldName('modifiers') ?? ifaceNode.children.find(c => c.type === 'modifiers');
  if (!modifiers) return '';

  for (const child of modifiers.children) {
    if (child.type !== 'annotation') continue;
    const nameNode = child.childForFieldName('name');
    if (!nameNode || nameNode.text !== 'FeignClient') continue;

    const args = child.children.find(c => c.type === 'annotation_argument_list');
    if (!args) continue;

    for (const pair of args.children) {
      if (pair.type !== 'element_value_pair') continue;
      const key = pair.childForFieldName('key');
      const value = pair.childForFieldName('value');
      if (key?.text === 'path' && value) {
        return unquoteLiteral(value.text) ?? '';
      }
    }
  }
  return '';
}

/**
 * Join a class/interface-level prefix with a method-level path, ensuring
 * a single leading slash and no double slashes.
 */
function joinPath(prefix: string, methodPath: string): string {
  const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanSub = methodPath.replace(/^\/+/, '');
  if (!cleanPrefix) return `/${cleanSub}`;
  return `/${cleanPrefix}/${cleanSub}`;
}

// ─── Extractor ────────────────────────────────────────────────────────

export class HttpConsumerExtractor implements ContractExtractor {
  type = 'http' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const files = await glob('**/*.java', {
      cwd: repoPath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**', '**/test/**', '**/tests/**'],
    });

    const parser = new Parser();
    parser.setLanguage(Java);
    const out: ExtractedContract[] = [];

    for (const rel of files) {
      const absPath = path.join(repoPath, rel);
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      let tree: Parser.Tree;
      try {
        tree = parser.parse(content);
      } catch {
        continue;
      }

      this.extractFeignContracts(tree, rel, out);
      this.extractRestTemplateContracts(tree, rel, out);
      this.extractWebClientContracts(tree, rel, out);
    }

    return this.dedupe(out);
  }

  // ─── @FeignClient interface declarations ────────────────────────────

  private extractFeignContracts(
    tree: Parser.Tree,
    filePath: string,
    out: ExtractedContract[],
  ): void {
    // Collect interface-level prefixes from @FeignClient(path = "...")
    const prefixByIfaceId = new Map<number, string>();

    for (const match of runCompiledPatterns(FEIGN_CLIENT_PREFIX_PATTERNS, tree)) {
      const ifaceNode = match.captures.iface;
      if (!ifaceNode) continue;

      // Extract path prefix from @FeignClient annotation manually
      const prefix = extractFeignPath(ifaceNode);
      prefixByIfaceId.set(ifaceNode.id, prefix);
    }

    // If no Feign interfaces detected, skip method scanning
    if (prefixByIfaceId.size === 0) return;

    // Scan method-level annotations inside interfaces
    for (const match of runCompiledPatterns(FEIGN_METHOD_PATTERNS, tree)) {
      const annNode = match.captures.ann;
      const pathNode = match.captures.path;
      const nameNode = match.captures.method_name;
      const methodNode = match.captures.method;
      if (!annNode || !pathNode || !methodNode) continue;

      // Must be inside a known @FeignClient interface
      const enclosingIface = findEnclosingInterface(methodNode);
      if (!enclosingIface || !prefixByIfaceId.has(enclosingIface.id)) continue;

      const httpMethod = ANNOTATION_TO_HTTP[annNode.text] ?? 'GET';
      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;

      const prefix = prefixByIfaceId.get(enclosingIface.id) ?? '';
      const fullPath = joinPath(prefix, rawPath);
      const pathNorm = normalizeConsumerUrl(fullPath);
      const cid = contractIdFor(httpMethod, pathNorm);

      out.push({
        contractId: cid,
        type: 'http',
        role: 'consumer',
        symbolUid: `http-consumer::feign::${filePath}::${nameNode?.text ?? 'unknown'}`,
        symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: nameNode?.text ?? 'feignMethod' },
        symbolName: nameNode?.text ?? 'feignMethod',
        confidence: 0.85,
        meta: {
          method: httpMethod,
          path: pathNorm,
          framework: 'spring-feign',
          extractionStrategy: 'http_consumer_scan',
        },
      });
    }
  }

  // ─── RestTemplate invocations ───────────────────────────────────────

  private extractRestTemplateContracts(
    tree: Parser.Tree,
    filePath: string,
    out: ExtractedContract[],
  ): void {
    for (const match of runCompiledPatterns(REST_TEMPLATE_PATTERNS, tree)) {
      const objNode = match.captures.obj;
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!objNode || !methodNode || !pathNode) continue;

      // Only match identifiers that look like a RestTemplate instance
      if (!/restTemplate|restClient/i.test(objNode.text)) continue;

      const httpMethod = REST_TEMPLATE_METHOD_MAP[methodNode.text];
      if (!httpMethod) continue;

      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;

      const pathNorm = normalizeConsumerUrl(rawPath);
      const cid = contractIdFor(httpMethod, pathNorm);

      out.push({
        contractId: cid,
        type: 'http',
        role: 'consumer',
        symbolUid: `http-consumer::rest-template::${filePath}::${methodNode.text}`,
        symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: methodNode.text },
        symbolName: methodNode.text,
        confidence: 0.75,
        meta: {
          method: httpMethod,
          path: pathNorm,
          framework: 'spring-rest-template',
          extractionStrategy: 'http_consumer_scan',
        },
      });
    }
  }

  // ─── WebClient fluent API ───────────────────────────────────────────

  private extractWebClientContracts(
    tree: Parser.Tree,
    filePath: string,
    out: ExtractedContract[],
  ): void {
    for (const match of runCompiledPatterns(WEB_CLIENT_FLUENT_PATTERNS, tree)) {
      const objNode = match.captures.obj;
      const httpMethodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!httpMethodNode || !pathNode) continue;

      // Only match identifiers that look like a WebClient instance
      if (objNode && !/webClient|client/i.test(objNode.text)) continue;

      const httpMethod = WEBCLIENT_METHOD_MAP[httpMethodNode.text];
      if (!httpMethod) continue;

      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;

      const pathNorm = normalizeConsumerUrl(rawPath);
      const cid = contractIdFor(httpMethod, pathNorm);

      out.push({
        contractId: cid,
        type: 'http',
        role: 'consumer',
        symbolUid: `http-consumer::webclient::${filePath}::${httpMethodNode.text}`,
        symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: httpMethodNode.text },
        symbolName: httpMethodNode.text,
        confidence: 0.75,
        meta: {
          method: httpMethod,
          path: pathNorm,
          framework: 'spring-webclient',
          extractionStrategy: 'http_consumer_scan',
        },
      });
    }
  }

  // ─── Deduplication ──────────────────────────────────────────────────

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    return items.filter((c) => {
      const key = `${c.contractId}|${c.role}|${c.symbolRef.filePath}|${c.symbolRef.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
