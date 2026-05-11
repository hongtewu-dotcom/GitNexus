import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type CompiledPatterns,
  type LanguagePatterns,
  type PatternSpec,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * Node.js / TypeScript HTTP plugin family. Handles:
 *   - NestJS `@Controller('prefix')` classes with `@Get(':id')` methods
 *   - Express `router.get(...)` / `app.post(...)` providers
 *   - `fetch(url)` / `fetch(url, { method: 'POST' })` consumers
 *   - `axios.get(url)` / `axios.delete(url)` consumers
 *   - `axios({ method, url })` object-form consumers
 *   - jQuery `$.get(url)` / `$.post(url, ...)` shorthand consumers
 *   - jQuery `$.ajax({ url, method | type })` consumers
 *
 * Because the JavaScript and TypeScript tree-sitter grammars share
 * node type names for every construct we query, pattern sources are
 * defined once and compiled against each grammar variant. The plugin
 * exports three `HttpLanguagePlugin`s (JS, TS, TSX) that share the
 * same `scan` function but bind to different grammars.
 */

// ─── Provider: NestJS — class-level @Controller('prefix') ────────────
// In tree-sitter-typescript decorators are NOT children of
// class_declaration / method_definition — they're siblings in the
// surrounding class_body / program node. We therefore match the
// decorator standalone and walk to its related class/method in JS.
const NEST_CONTROLLER_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (decorator
      (call_expression
        function: (identifier) @dec (#eq? @dec "Controller")
        arguments: (arguments . [(string) (template_string)] @prefix))) @ctrl_decorator
  `,
};

// ─── Provider: NestJS — method-level @Get/@Post/... decorators ───────
// Matches either `@Get('path')` or `@Get()`. The `@path` capture is
// optional — when the first argument isn't a string, the plugin falls
// back to '/' for the method-level path.
const NEST_METHOD_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (decorator
      (call_expression
        function: (identifier) @dec (#match? @dec "^(Get|Post|Put|Delete|Patch)$")
        arguments: (arguments) @args)) @method_decorator
  `,
};

// ─── Provider: Express — router.get/app.post/... ─────────────────────
const EXPRESS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#match? @obj "^(router|app)$")
        property: (property_identifier) @http_method (#match? @http_method "^(get|post|put|delete|patch)$"))
      arguments: (arguments . [(string) (template_string)] @path))
  `,
};

// ─── Consumer: fetch(url) with NO options ─────────────────────────────
const FETCH_NO_OPTIONS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (identifier) @fn (#eq? @fn "fetch")
      arguments: (arguments . [(string) (template_string)] @path .))
  `,
};

// ─── Consumer: fetch(url, { method: 'X', ... }) ──────────────────────
const FETCH_WITH_OPTIONS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (identifier) @fn (#eq? @fn "fetch")
      arguments: (arguments
        . [(string) (template_string)] @path
        (object
          (pair
            key: (property_identifier) @key (#eq? @key "method")
            value: (string) @http_method))))
  `,
};

// ─── Consumer: axios.get/post/... ────────────────────────────────────
const AXIOS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#eq? @obj "axios")
        property: (property_identifier) @http_method (#match? @http_method "^(get|post|put|delete|patch)$"))
      arguments: (arguments . [(string) (template_string)] @path))
  `,
};

// ─── Consumer: jQuery shorthand $.get(url) / $.post(url, ...) ────────
// `$` is a valid JS identifier, so tree-sitter parses `$.get(...)` as a
// call_expression whose function is a member_expression on identifier `$`.
const JQUERY_SHORTHAND_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#eq? @obj "$")
        property: (property_identifier) @http_method (#match? @http_method "^(get|post)$"))
      arguments: (arguments . [(string) (template_string)] @path))
  `,
};

// ─── Consumer: jQuery $.ajax({ url, method|type }) ───────────────────
// The query captures the options object only; key/value pairs are read
// programmatically via `readStringProp` below, which tolerates any key
// order and accepts either `method:` or `type:` (jQuery supports both).
const JQUERY_AJAX_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#eq? @obj "$")
        property: (property_identifier) @fn (#eq? @fn "ajax"))
      arguments: (arguments (object) @options))
  `,
};

// ─── Consumer: axios({ method, url }) object form ────────────────────
// Distinct from AXIOS_SPEC above because the call target is an identifier
// (`axios`) rather than a member expression (`axios.get`). As with the
// jQuery ajax form, option keys are resolved programmatically.
const AXIOS_OBJECT_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (identifier) @fn (#eq? @fn "axios")
      arguments: (arguments (object) @options))
  `,
};

// ─── Consumer: chain-style wrapper().chain().METHOD() ─────────────────
// Matches patterns like `FlightNetwork(path).params(x).POST()` where
// the terminator method name is a well-known HTTP verb in UPPER-CASE.
// The tree-sitter query captures the outermost call_expression whose
// function is a member_expression with property matching the verb.
// The actual path is resolved programmatically by walking the chain
// inward to find the root call that receives a string/template literal.
const CHAIN_STYLE_CONSUMER_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        property: (property_identifier) @http_method (#match? @http_method "^(GET|POST|PUT|DELETE|PATCH)$"))
      arguments: (arguments)) @chain_call
  `,
};

interface NodePatternBundle {
  controller: CompiledPatterns<Record<string, never>>;
  methodDecorator: CompiledPatterns<Record<string, never>>;
  express: CompiledPatterns<Record<string, never>>;
  fetchNoOptions: CompiledPatterns<Record<string, never>>;
  fetchWithOptions: CompiledPatterns<Record<string, never>>;
  axios: CompiledPatterns<Record<string, never>>;
  jqueryShorthand: CompiledPatterns<Record<string, never>>;
  jqueryAjax: CompiledPatterns<Record<string, never>>;
  axiosObject: CompiledPatterns<Record<string, never>>;
  chainStyle: CompiledPatterns<Record<string, never>>;
}

function compileBundle(language: unknown, name: string): NodePatternBundle {
  const mk = (spec: PatternSpec<Record<string, never>>, suffix: string) =>
    compilePatterns({
      name: `${name}-${suffix}`,
      language,
      patterns: [spec],
    } satisfies LanguagePatterns<Record<string, never>>);
  return {
    controller: mk(NEST_CONTROLLER_SPEC, 'nest-controller'),
    methodDecorator: mk(NEST_METHOD_SPEC, 'nest-method-decorator'),
    express: mk(EXPRESS_SPEC, 'express'),
    fetchNoOptions: mk(FETCH_NO_OPTIONS_SPEC, 'fetch-no-options'),
    fetchWithOptions: mk(FETCH_WITH_OPTIONS_SPEC, 'fetch-with-options'),
    axios: mk(AXIOS_SPEC, 'axios'),
    jqueryShorthand: mk(JQUERY_SHORTHAND_SPEC, 'jquery-shorthand'),
    jqueryAjax: mk(JQUERY_AJAX_SPEC, 'jquery-ajax'),
    axiosObject: mk(AXIOS_OBJECT_SPEC, 'axios-object'),
    chainStyle: mk(CHAIN_STYLE_CONSUMER_SPEC, 'chain-style'),
  };
}

const JAVASCRIPT_BUNDLE = compileBundle(JavaScript, 'javascript-http');
const TYPESCRIPT_BUNDLE = compileBundle(TypeScript.typescript, 'typescript-http');
const TSX_BUNDLE = compileBundle(TypeScript.tsx, 'tsx-http');

const NEST_DECORATOR_TO_HTTP: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Delete: 'DELETE',
  Patch: 'PATCH',
};

/**
 * Find the nearest enclosing class_declaration for a node, or null.
 */
function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

function joinPath(prefix: string, sub: string): string {
  const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanSub = sub.replace(/^\/+/, '');
  if (!cleanPrefix) return `/${cleanSub}`;
  return `/${cleanPrefix}/${cleanSub}`;
}

/**
 * Walk `pair` children of an `object` literal and return the unquoted
 * string/template_string value for the first pair whose key matches one
 * of `keyNames`. Returns null when no matching pair is present or the
 * value is not a string literal. Used by the jQuery ajax / axios object
 * consumers to resolve `url` / `method` / `type` keys in any order.
 */
function readStringProp(objectNode: Parser.SyntaxNode, keyNames: readonly string[]): string | null {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const pair = objectNode.namedChild(i);
    if (!pair || pair.type !== 'pair') continue;
    const keyNode = pair.childForFieldName('key');
    const valueNode = pair.childForFieldName('value');
    if (!keyNode || !valueNode) continue;
    if (!keyNames.includes(keyNode.text)) continue;
    if (valueNode.type !== 'string' && valueNode.type !== 'template_string') continue;
    const lit = unquoteLiteral(valueNode.text);
    if (lit !== null) return lit;
  }
  return null;
}

/**
 * For a standalone `decorator` node (child of class_body / program),
 * find the related `class_declaration` node that it decorates. In
 * tree-sitter-typescript the decorator is placed before the class
 * declaration as a sibling (when decorating a class) or inside the
 * class_body before a method_definition (when decorating a method);
 * we walk the parent chain until we find the enclosing class.
 */
function findDecoratedClass(decoratorNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const parent = decoratorNode.parent;
  if (!parent) return null;
  // Case 1: decorator is a sibling of the class_declaration at program /
  // export_statement level. Walk forward through siblings until we find
  // the class_declaration this decorator belongs to.
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child && child.id === decoratorNode.id) {
      for (let j = i + 1; j < parent.namedChildCount; j++) {
        const next = parent.namedChild(j);
        if (!next) continue;
        if (next.type === 'decorator') continue; // adjacent decorators stack
        if (next.type === 'class_declaration') return next;
        if (next.type === 'export_statement') {
          // `export class Foo { ... }` wraps the declaration.
          for (let k = 0; k < next.namedChildCount; k++) {
            const inner = next.namedChild(k);
            if (inner?.type === 'class_declaration') return inner;
          }
        }
        break;
      }
      break;
    }
  }
  // Case 2: decorator is inside a class_body (decorating a method) —
  // walk up to the enclosing class_declaration.
  return findEnclosingClass(decoratorNode);
}

/**
 * For a method-level decorator node (child of class_body before a
 * method_definition), find the method_definition it decorates.
 */
function findDecoratedMethod(decoratorNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const parent = decoratorNode.parent;
  if (!parent || parent.type !== 'class_body') return null;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child && child.id === decoratorNode.id) {
      for (let j = i + 1; j < parent.namedChildCount; j++) {
        const next = parent.namedChild(j);
        if (!next) continue;
        if (next.type === 'decorator') continue;
        if (next.type === 'method_definition') return next;
        return null;
      }
      return null;
    }
  }
  return null;
}

function scanBundle(bundle: NodePatternBundle, tree: Parser.Tree): HttpDetection[] {
  const out: HttpDetection[] = [];

  // NestJS: collect `@Controller('prefix')` class decorators, keyed by
  // the `class_declaration` they decorate.
  const prefixByClassId = new Map<number, string>();
  for (const match of runCompiledPatterns(bundle.controller, tree)) {
    const prefixNode = match.captures.prefix;
    const decoratorNode = match.captures.ctrl_decorator;
    if (!prefixNode || !decoratorNode) continue;
    const prefix = unquoteLiteral(prefixNode.text);
    if (prefix === null) continue;
    const classNode = findDecoratedClass(decoratorNode);
    if (!classNode) continue;
    prefixByClassId.set(classNode.id, prefix);
  }

  // NestJS: method-level @Get/@Post/... decorators. The decorator's
  // arguments list may be empty (`@Get()`), a string (`@Get('path')`),
  // or something else (which we skip).
  for (const match of runCompiledPatterns(bundle.methodDecorator, tree)) {
    const decNode = match.captures.dec;
    const argsNode = match.captures.args;
    const decoratorNode = match.captures.method_decorator;
    if (!decNode || !argsNode || !decoratorNode) continue;
    const httpMethod = NEST_DECORATOR_TO_HTTP[decNode.text];
    if (!httpMethod) continue;
    const methodNode = findDecoratedMethod(decoratorNode);
    if (!methodNode) continue;
    const enclosingClass = findEnclosingClass(methodNode);
    // Only emit NestJS detections when the class actually has a
    // @Controller decorator — without it, the match is almost certainly
    // something else (e.g. an unrelated library using similar names).
    if (!enclosingClass || !prefixByClassId.has(enclosingClass.id)) continue;
    const prefix = prefixByClassId.get(enclosingClass.id) ?? '';

    let rawPath = '/';
    const firstArg = argsNode.namedChild(0);
    if (firstArg && (firstArg.type === 'string' || firstArg.type === 'template_string')) {
      const unquoted = unquoteLiteral(firstArg.text);
      if (unquoted !== null) rawPath = unquoted;
    }

    // Get the method name from the decorated method_definition.
    const methodNameNode = methodNode.childForFieldName('name');
    const name = methodNameNode?.text ?? null;

    out.push({
      role: 'provider',
      framework: 'nest',
      method: httpMethod,
      path: joinPath(prefix, rawPath),
      name,
      confidence: 0.8,
    });
  }

  // Express: router/app.<verb>(...)
  for (const match of runCompiledPatterns(bundle.express, tree)) {
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    if (!methodNode || !pathNode) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'provider',
      framework: 'express',
      method: methodNode.text.toUpperCase(),
      path,
      name: 'handler',
      confidence: 0.8,
    });
  }

  // Consumer: fetch with options { method: 'X' }
  const fetchSeen = new Set<number>();
  for (const match of runCompiledPatterns(bundle.fetchWithOptions, tree)) {
    const pathNode = match.captures.path;
    const methodNode = match.captures.http_method;
    if (!pathNode || !methodNode) continue;
    const path = unquoteLiteral(pathNode.text);
    const method = unquoteLiteral(methodNode.text);
    if (path === null || method === null) continue;
    fetchSeen.add(pathNode.id);
    out.push({
      role: 'consumer',
      framework: 'fetch',
      method: method.toUpperCase(),
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: plain fetch(path) — default GET. Skip path nodes we already
  // matched with the options variant so we don't double-emit.
  for (const match of runCompiledPatterns(bundle.fetchNoOptions, tree)) {
    const pathNode = match.captures.path;
    if (!pathNode) continue;
    if (fetchSeen.has(pathNode.id)) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'consumer',
      framework: 'fetch',
      method: 'GET',
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: axios.<verb>(url)
  for (const match of runCompiledPatterns(bundle.axios, tree)) {
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    if (!methodNode || !pathNode) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'consumer',
      framework: 'axios',
      method: methodNode.text.toUpperCase(),
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: jQuery shorthand $.get(url) / $.post(url, ...)
  for (const match of runCompiledPatterns(bundle.jqueryShorthand, tree)) {
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    if (!methodNode || !pathNode) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'consumer',
      framework: 'jquery',
      method: methodNode.text.toUpperCase(),
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: jQuery $.ajax({ url, method|type }). jQuery accepts either
  // `method:` or `type:`; both default to GET when absent.
  for (const match of runCompiledPatterns(bundle.jqueryAjax, tree)) {
    const optionsNode = match.captures.options;
    if (!optionsNode) continue;
    const path = readStringProp(optionsNode, ['url']);
    if (path === null) continue;
    const rawMethod = readStringProp(optionsNode, ['method', 'type']);
    const method = (rawMethod ?? 'GET').toUpperCase();
    out.push({
      role: 'consumer',
      framework: 'jquery',
      method,
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: axios({ method, url }) object form. Structurally distinct
  // from axios.<verb>(url) (identifier vs member_expression call), so no
  // dedup against the member-form loop above is required.
  for (const match of runCompiledPatterns(bundle.axiosObject, tree)) {
    const optionsNode = match.captures.options;
    if (!optionsNode) continue;
    const path = readStringProp(optionsNode, ['url']);
    if (path === null) continue;
    const rawMethod = readStringProp(optionsNode, ['method']);
    const method = (rawMethod ?? 'GET').toUpperCase();
    out.push({
      role: 'consumer',
      framework: 'axios',
      method,
      path,
      name: null,
      confidence: 0.7,
    });
  }

  // Consumer: chain-style Wrapper(path).chain().METHOD(). Walk inward
  // from the outermost `.METHOD()` call to find the root call that
  // receives a string/template_string literal as its first argument.
  for (const match of runCompiledPatterns(bundle.chainStyle, tree)) {
    const methodNode = match.captures.http_method;
    const chainCallNode = match.captures.chain_call;
    if (!methodNode || !chainCallNode) continue;
    const method = methodNode.text.toUpperCase();

    // Walk the member_expression chain inward: each link is
    // call_expression → member_expression → object (next call_expression)
    // until we reach a call_expression whose function is an identifier.
    const path = resolveChainPath(chainCallNode);
    if (path === null) continue;

    out.push({
      role: 'consumer',
      framework: 'chain',
      method,
      path,
      name: null,
      confidence: 0.7,
    });
  }

  return out;
}

/**
 * Walk a chain-style call expression inward to find the root call that
 * has a string/template_string as its first argument. The structure is:
 *
 *   call(.POST args)
 *     member_expression
 *       object: call(.params args)
 *         member_expression
 *           object: call(FlightNetwork args=(path))  ← root
 *             function: identifier
 *             arguments: (string @path)
 *
 * When the root call's first argument is an identifier (variable reference),
 * we do a simple intra-scope lookup: walk backward through sibling statements
 * to find `const/let/var <name> = '...'` and extract the literal value.
 *
 * For template strings like `/flightpricecheck${FTK_Request_Common_Path}`,
 * we extract only the leading static segment before the first interpolation.
 *
 * We traverse at most 10 levels deep to avoid infinite loops.
 */
function resolveChainPath(outerCall: Parser.SyntaxNode): string | null {
  let cur: Parser.SyntaxNode | null = outerCall;
  for (let depth = 0; depth < 10 && cur; depth++) {
    // The function of a chain call is a member_expression
    const fn = cur.childForFieldName('function');
    if (!fn) return null;

    if (fn.type === 'member_expression') {
      // object of the member_expression is the next link in the chain
      const obj = fn.childForFieldName('object');
      if (!obj) return null;
      if (obj.type === 'call_expression') {
        // Check if this call has a string literal first arg (it's the root)
        const resolved = resolveRootCallPath(obj);
        if (resolved !== null) return resolved;
        // Not the root yet — continue traversal
        cur = obj;
        continue;
      }
      // object is something else (identifier = direct member call, not a chain)
      return null;
    }

    // function is an identifier: this is the root call, check its first arg
    if (fn.type === 'identifier') {
      return resolveRootCallPath(cur);
    }

    return null;
  }
  return null;
}

/**
 * Given a call_expression node, try to resolve a path string from its first
 * argument. Handles: string literal, template_string, or identifier (variable
 * reference with intra-scope lookup).
 */
function resolveRootCallPath(callNode: Parser.SyntaxNode): string | null {
  const args = callNode.childForFieldName('arguments');
  if (!args || args.namedChildCount === 0) return null;
  const firstArg = args.namedChild(0);
  if (!firstArg) return null;

  if (firstArg.type === 'string') {
    return unquoteLiteral(firstArg.text);
  }
  if (firstArg.type === 'template_string') {
    return extractTemplateLiteral(firstArg);
  }
  // Variable reference — try intra-scope lookup
  if (firstArg.type === 'identifier') {
    return resolveVariableInScope(firstArg.text, callNode);
  }
  return null;
}

/**
 * Extract the leading static portion of a template_string node.
 * For `` `/flightpricecheck${suffix}` ``, returns "/flightpricecheck".
 * For a fully-static template (no interpolation), returns the whole string.
 */
function extractTemplateLiteral(node: Parser.SyntaxNode): string | null {
  // A template_string's children alternate between string fragments and
  // template_substitution nodes. The first child after ` is a fragment.
  const text = node.text;
  // Strip backticks
  const inner = text.slice(1, -1);
  // Find first ${ — take everything before it
  const interpIdx = inner.indexOf('${');
  if (interpIdx === -1) {
    // No interpolation — fully static
    return inner || null;
  }
  const prefix = inner.slice(0, interpIdx);
  return prefix || null;
}

/**
 * Simple intra-scope variable resolution: given `varName` used in a statement
 * at `usageNode`, walk backward through preceding sibling statements in the
 * same block to find `const/let/var varName = <literal>` and return the value.
 * Only resolves one level (no transitive lookups).
 */
function resolveVariableInScope(varName: string, usageNode: Parser.SyntaxNode): string | null {
  // Find the statement containing usageNode (walk up to statement_block / program child)
  let stmtNode: Parser.SyntaxNode | null = usageNode;
  while (stmtNode && stmtNode.parent && stmtNode.parent.type !== 'statement_block' && stmtNode.parent.type !== 'program' && stmtNode.parent.type !== 'class_body') {
    stmtNode = stmtNode.parent;
  }
  if (!stmtNode || !stmtNode.parent) return null;

  const block = stmtNode.parent;
  // Walk backward through children of the block
  for (let i = 0; i < block.namedChildCount; i++) {
    const child = block.namedChild(i);
    if (!child) continue;
    if (child.id === stmtNode.id) break; // reached our statement, stop looking
    // Look for variable declarations: lexical_declaration or variable_declaration
    if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
      // Each declaration can have multiple declarators
      for (let j = 0; j < child.namedChildCount; j++) {
        const declarator = child.namedChild(j);
        if (!declarator || declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        const valueNode = declarator.childForFieldName('value');
        if (!nameNode || !valueNode) continue;
        if (nameNode.text !== varName) continue;
        // Found the declaration — extract value
        if (valueNode.type === 'string') {
          return unquoteLiteral(valueNode.text);
        }
        if (valueNode.type === 'template_string') {
          return extractTemplateLiteral(valueNode);
        }
      }
    }
  }
  return null;
}

export const JAVASCRIPT_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'javascript-http',
  language: JavaScript,
  scan: (tree) => scanBundle(JAVASCRIPT_BUNDLE, tree),
};

export const TYPESCRIPT_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'typescript-http',
  language: TypeScript.typescript,
  scan: (tree) => scanBundle(TYPESCRIPT_BUNDLE, tree),
};

export const TSX_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'tsx-http',
  language: TypeScript.tsx,
  scan: (tree) => scanBundle(TSX_BUNDLE, tree),
};
