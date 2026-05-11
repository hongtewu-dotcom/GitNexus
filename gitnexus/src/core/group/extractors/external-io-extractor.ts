import { glob } from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { compilePatterns, runCompiledPatterns, unquoteLiteral, type LanguagePatterns } from './tree-sitter-scanner.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';

/**
 * External IO Extractor — detects outbound HTTP/Socket calls to external systems.
 *
 * Identifies external dependencies by scanning for:
 * 1. OkHttpClient calls (Request.Builder().url(...), okHttpClient.newCall(...))
 * 2. RestTemplate calls (getForObject, postForObject, exchange)
 * 3. HttpClient / HttpURLConnection (new URL("http://..."), HttpClient.newBuilder())
 * 4. Socket connections (new Socket("host", port)) — e.g. eterm/travelsky
 *
 * Additionally uses a "relaxed mode" that flags classes named *Client/*Connector/*Gateway/*Adapter
 * containing HTTP-related imports as external IO boundaries.
 *
 * All contracts are consumers (this service consumes the external system).
 * Contract format: `custom::external-io::<normalized-host-or-identifier>`
 */

// --- Pattern: String literals containing URLs ---
const URL_STRING_PATTERNS = compilePatterns({
  name: 'java-url-strings',
  language: Java,
  patterns: [
    {
      meta: { type: 'url_literal' },
      query: `
        (string_literal) @url_str (#match? @url_str "https?://")
      `,
    },
  ],
} satisfies LanguagePatterns<{ type: string }>);

// --- Pattern: RestTemplate method invocations ---
const REST_TEMPLATE_PATTERNS = compilePatterns({
  name: 'java-rest-template',
  language: Java,
  patterns: [
    {
      meta: { type: 'rest_template' },
      query: `
        (method_invocation
          object: (identifier) @obj (#match? @obj "^[rR]estTemplate$")
          name: (identifier) @method (#match? @method "^(getForObject|getForEntity|postForObject|postForEntity|exchange|put|delete|patchForObject)$")
          arguments: (argument_list) @args)
      `,
    },
  ],
} satisfies LanguagePatterns<{ type: string }>);

// --- Pattern: OkHttp Request.Builder ---
const OKHTTP_PATTERNS = compilePatterns({
  name: 'java-okhttp',
  language: Java,
  patterns: [
    {
      meta: { type: 'okhttp_call' },
      query: `
        (method_invocation
          object: (identifier) @obj
          name: (identifier) @method (#eq? @method "newCall"))
      `,
    },
    {
      meta: { type: 'okhttp_url' },
      query: `
        (method_invocation
          name: (identifier) @method (#eq? @method "url")
          arguments: (argument_list
            (string_literal) @url_arg))
      `,
    },
  ],
} satisfies LanguagePatterns<{ type: string }>);

// --- Pattern: Socket creation ---
const SOCKET_PATTERNS = compilePatterns({
  name: 'java-socket',
  language: Java,
  patterns: [
    {
      meta: { type: 'socket' },
      query: `
        (object_creation_expression
          type: (type_identifier) @type (#eq? @type "Socket")
          arguments: (argument_list
            (string_literal) @host))
      `,
    },
  ],
} satisfies LanguagePatterns<{ type: string }>);

// --- Pattern: new URL("http://...") ---
const URL_CREATION_PATTERNS = compilePatterns({
  name: 'java-url-creation',
  language: Java,
  patterns: [
    {
      meta: { type: 'url_creation' },
      query: `
        (object_creation_expression
          type: (type_identifier) @type (#eq? @type "URL")
          arguments: (argument_list
            (string_literal) @url_arg (#match? @url_arg "https?://")))
      `,
    },
  ],
} satisfies LanguagePatterns<{ type: string }>);

/** Class name patterns suggesting an external client boundary */
const CLIENT_CLASS_NAME_RE = /(?:Client|Connector|Gateway|Adapter|Caller|Invoker)$/;

/** HTTP-related import patterns */
const HTTP_IMPORT_RE = /(?:okhttp3|org\.apache\.http|java\.net\.http|org\.springframework\.web\.client|java\.net\.URL|java\.net\.Socket)/;

/**
 * Extract host from a URL string. Returns null if not parseable.
 */
function extractHost(urlStr: string): string | null {
  const unquoted = unquoteLiteral(urlStr);
  if (!unquoted) return null;
  try {
    const match = unquoted.match(/^https?:\/\/([^/:?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function makeExternalIoContract(
  identifier: string,
  filePath: string,
  symbolName: string,
  confidence: number,
  meta: Record<string, unknown>,
): ExtractedContract {
  return {
    contractId: `custom::external-io::${identifier}`,
    type: 'custom',
    role: 'consumer',
    symbolUid: `external-io::consumer::${identifier}::${filePath}::${symbolName}`,
    symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: symbolName },
    symbolName,
    confidence,
    meta: { ...meta, extractionStrategy: 'external_io_scan' },
  };
}

export class ExternalIoExtractor implements ContractExtractor {
  type = 'custom' as const;

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

      const className = this.resolveClassName(tree);

      // --- Exact URL detection: RestTemplate calls ---
      this.extractRestTemplateCalls(tree, rel, className, out);

      // --- OkHttp URL detection ---
      this.extractOkHttpCalls(tree, rel, className, out);

      // --- Socket creation ---
      this.extractSocketCreation(tree, rel, className, out);

      // --- new URL("http://...") ---
      this.extractUrlCreation(tree, rel, className, out);

      // --- Relaxed mode: Client/Connector/Gateway class with HTTP imports ---
      this.extractRelaxedBoundary(content, rel, className, out);
    }

    return this.dedupe(out);
  }

  /**
   * Detect RestTemplate.getForObject/postForObject/exchange calls and extract URL from first argument.
   */
  private extractRestTemplateCalls(
    tree: Parser.Tree,
    filePath: string,
    className: string | null,
    out: ExtractedContract[],
  ): void {
    for (const match of runCompiledPatterns(REST_TEMPLATE_PATTERNS, tree)) {
      const method = match.captures.method?.text;
      const argsNode = match.captures.args;
      if (!method || !argsNode) continue;

      // Try to extract URL from first argument
      const firstArg = argsNode.namedChild(0);
      if (firstArg?.type === 'string_literal') {
        const host = extractHost(firstArg.text);
        if (host) {
          out.push(makeExternalIoContract(
            host,
            filePath,
            `${className ?? 'Unknown'}.restTemplate.${method}`,
            0.6,
            { source: 'rest_template', method, host },
          ));
          continue;
        }
      }

      // URL from variable — use class+method as identifier
      if (className) {
        out.push(makeExternalIoContract(
          `${className}.restTemplate.${method}`,
          filePath,
          `${className}.restTemplate.${method}`,
          0.4,
          { source: 'rest_template_variable', method },
        ));
      }
    }
  }

  /**
   * Detect OkHttp .url("...") calls with hardcoded URLs.
   */
  private extractOkHttpCalls(
    tree: Parser.Tree,
    filePath: string,
    className: string | null,
    out: ExtractedContract[],
  ): void {
    for (const match of runCompiledPatterns(OKHTTP_PATTERNS, tree)) {
      if (match.meta.type === 'okhttp_url') {
        const urlArg = match.captures.url_arg?.text;
        if (!urlArg) continue;
        const host = extractHost(urlArg);
        if (host) {
          out.push(makeExternalIoContract(
            host,
            filePath,
            `${className ?? 'Unknown'}.okhttp`,
            0.6,
            { source: 'okhttp', host },
          ));
        }
      } else if (match.meta.type === 'okhttp_call' && className) {
        // newCall without extractable URL — record with lower confidence
        out.push(makeExternalIoContract(
          `${className}.okhttp.newCall`,
          filePath,
          `${className}.okhttp.newCall`,
          0.35,
          { source: 'okhttp_newcall' },
        ));
      }
    }
  }

  /**
   * Detect new Socket("host", port) — common for eterm/travelsky connections.
   */
  private extractSocketCreation(
    tree: Parser.Tree,
    filePath: string,
    className: string | null,
    out: ExtractedContract[],
  ): void {
    for (const match of runCompiledPatterns(SOCKET_PATTERNS, tree)) {
      const hostLiteral = match.captures.host?.text;
      if (!hostLiteral) continue;

      const host = unquoteLiteral(hostLiteral);
      if (!host) continue;

      out.push(makeExternalIoContract(
        host,
        filePath,
        `${className ?? 'Unknown'}.Socket`,
        0.6,
        { source: 'socket', host },
      ));
    }
  }

  /**
   * Detect new URL("http://...") or new URL("https://...").
   */
  private extractUrlCreation(
    tree: Parser.Tree,
    filePath: string,
    className: string | null,
    out: ExtractedContract[],
  ): void {
    for (const match of runCompiledPatterns(URL_CREATION_PATTERNS, tree)) {
      const urlArg = match.captures.url_arg?.text;
      if (!urlArg) continue;

      const host = extractHost(urlArg);
      if (host) {
        out.push(makeExternalIoContract(
          host,
          filePath,
          `${className ?? 'Unknown'}.URL`,
          0.6,
          { source: 'url_creation', host },
        ));
      }
    }
  }

  /**
   * Relaxed mode: if a class is named *Client/*Connector/*Gateway/*Adapter
   * and has HTTP-related imports, flag it as an external IO boundary.
   */
  private extractRelaxedBoundary(
    content: string,
    filePath: string,
    className: string | null,
    out: ExtractedContract[],
  ): void {
    if (!className || !CLIENT_CLASS_NAME_RE.test(className)) return;
    if (!HTTP_IMPORT_RE.test(content)) return;

    out.push(makeExternalIoContract(
      className,
      filePath,
      className,
      0.3,
      { source: 'relaxed_boundary', reason: 'client_class_with_http_import' },
    ));
  }

  /**
   * Resolve the first/primary class name in the file.
   */
  private resolveClassName(tree: Parser.Tree): string | null {
    const root = tree.rootNode;
    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i);
      if (child?.type !== 'class_declaration') continue;
      const nameNode = child.childForFieldName('name');
      if (nameNode?.text) return nameNode.text;
    }
    return null;
  }

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    return items.filter((c) => {
      const key = `${c.contractId}|${c.symbolRef.filePath}|${c.symbolName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
