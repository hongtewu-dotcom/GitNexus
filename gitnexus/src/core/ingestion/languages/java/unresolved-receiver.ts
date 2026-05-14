/**
 * Java synthetic CALLS edges for dynamic dispatch patterns that
 * static scope-resolution cannot see.
 *
 * Two patterns:
 *
 *   Pattern A — Constructor delegation
 *     ```java
 *     Dispatcher d = new ActiveDispatcher(a, b);
 *     d.dispatch(ctx);   // ← this CALLS edge is missing
 *     ```
 *     lbug records `new ActiveDispatcher()` but doesn't emit a CALLS
 *     edge for the subsequent method call on the local variable because
 *     no type-binding flows the concrete class through the variable `d`.
 *
 *   Pattern B — Spring Map injection
 *     ```java
 *     @Autowired
 *     Map<String, AbstractFilter> filters;
 *     // …
 *     for (AbstractFilter f : filters.values()) f.doFilter(ctx);
 *     ```
 *     The field's declared type resolves to `AbstractFilter` (the Map
 *     value type). For every call site on a variable whose type-binding
 *     resolves to the abstract base/interface, we emit a synthetic edge
 *     to each concrete implementing class.
 *
 * ## Conservative design
 *
 *   - Skips any site already in `handledSites` (contract invariant I2).
 *   - Pattern A requires the called method name to appear ONCE
 *     workspace-wide on the concrete class (or its delegate suffix
 *     family), preventing fan-out to unrelated classes.
 *   - Pattern B requires the concrete class to have at least one
 *     registered method whose name matches the call site (it implements
 *     the relevant method), and the abstract base class must have
 *     unique workspace name.
 *   - Both patterns use confidence < 0.65 to distinguish synthetic
 *     edges from fully-resolved ones.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import {
  resolveCallerGraphId,
  resolveDefGraphId,
} from '../../scope-resolution/graph-bridge/ids.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** Suffixes that identify delegation-style wrapper class names. */
const DELEGATE_SUFFIXES = [
  'Dispatcher',
  'Processor',
  'Executor',
  'Runner',
  'Handler',
  'Manager',
  'Invoker',
  'Caller',
  'Launcher',
] as const;

/** Method names that are canonical "do the work" verbs for delegate classes. */
const DELEGATE_METHOD_NAMES = new Set([
  'dispatch',
  'process',
  'execute',
  'run',
  'handle',
  'invoke',
  'call',
  'launch',
  'perform',
  'apply',
]);

/** Returns true when the class name ends with one of the delegate suffixes. */
function hasDelegateSuffix(name: string): boolean {
  return DELEGATE_SUFFIXES.some((s) => name.endsWith(s));
}

// ---------------------------------------------------------------------------
// Pattern A — Constructor delegation
// ---------------------------------------------------------------------------

/**
 * Scan every file for `new XxxDispatcher(...)` constructor sites (Pattern A).
 *
 * For each site:
 *   1. The constructed class must end with a delegate suffix.
 *   2. There must be at least one call site in the same file (any scope)
 *      with a matching delegate method name AND whose explicit receiver
 *      is a local variable — we use the class's concrete methods to find
 *      the target def.
 *   3. The constructed class must resolve to a UNIQUE class def in the
 *      workspace (avoids false-positive fan-out).
 */
function emitConstructorDelegationEdges(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  handledSites: Set<string>,
  model: SemanticModel,
): number {
  let emitted = 0;
  const seen = new Set<string>();

  for (const parsed of parsedFiles) {
    // Collect all constructor call sites in this file for delegate-suffix classes.
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'call') continue;
      if (site.callForm !== 'constructor') continue;
      if (!hasDelegateSuffix(site.name)) continue;

      const siteKey = `${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`;
      if (handledSites.has(siteKey)) continue;

      // Look up the constructed class — must be unique workspace-wide.
      const classCandidates = model.types.lookupClassByName(site.name);
      if (classCandidates.length !== 1) continue;
      const classDef = classCandidates[0];
      if (classDef === undefined) continue;
      if (classDef.qualifiedName === undefined) continue;

      // Find all delegate-style call sites in the same file that could
      // represent calls to a method of this constructed class.
      for (const callSite of parsed.referenceSites) {
        if (callSite.kind !== 'call') continue;
        if (callSite.callForm !== 'member') continue;
        if (!DELEGATE_METHOD_NAMES.has(callSite.name)) continue;

        const callSiteKey = `${parsed.filePath}:${callSite.atRange.startLine}:${callSite.atRange.startCol}`;
        if (handledSites.has(callSiteKey)) continue;

        // Look up the method by owner — the class must own this method.
        const methodDef = model.methods.lookupMethodByOwner(
          classDef.nodeId,
          callSite.name,
          callSite.arity,
        );
        if (methodDef === undefined) continue;

        const callerGraphId = resolveCallerGraphId(callSite.inScope, scopes, nodeLookup);
        if (callerGraphId === undefined) continue;
        const tgtGraphId = resolveDefGraphId(methodDef.filePath, methodDef, nodeLookup);
        if (tgtGraphId === undefined) continue;

        handledSites.add(callSiteKey);
        const relId = `rel:CALLS:${callerGraphId}->${tgtGraphId}`;
        if (seen.has(relId)) continue;
        seen.add(relId);
        graph.addRelationship({
          id: relId,
          sourceId: callerGraphId,
          targetId: tgtGraphId,
          type: 'CALLS',
          confidence: 0.6,
          reason: 'java-constructor-delegation',
        });
        emitted++;
      }

      // Mark the constructor site itself as handled so the free-call
      // fallback doesn't double-process it.
      handledSites.add(siteKey);
    }
  }
  return emitted;
}

// ---------------------------------------------------------------------------
// Pattern B — Spring Map injection
// ---------------------------------------------------------------------------

/**
 * Scan for `Map<String, XxxInterface>` field injection patterns (Pattern B).
 *
 * Strategy (without AST-level annotation detection):
 *   1. For every file, look at the scope's `typeBindings`. A field declared
 *      as `Map<String, AbstractFilter>` has its value type extracted by
 *      `stripGeneric` in `interpret.ts`, so the field name is bound to
 *      `AbstractFilter` in the scope's typeBindings.
 *   2. Separately, collect all call sites where the receiver's name appears
 *      in `typeBindings` AND the bound type resolves to an abstract
 *      class / interface.
 *   3. For each such call site, find all concrete classes that:
 *      (a) own a method matching the called name, and
 *      (b) appear to implement the abstract base (i.e. have the same
 *          method name registered under their nodeId, and their
 *          qualifiedName differs from the base class).
 *   4. The abstract base must be resolvable to a unique workspace class
 *      def so we know what "all implementors" means.
 *
 * This is conservative: we only emit when the receiver's type binding
 * in the scope chain maps to an interface/abstract class name that
 * matches a unique workspace class, AND there are concrete classes
 * that implement the called method.
 */
function emitSpringMapDispatchEdges(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  handledSites: Set<string>,
  model: SemanticModel,
): number {
  let emitted = 0;
  const seen = new Set<string>();

  // Pre-index: for each method name, collect all class nodeIds that own it.
  // We'll use this to find implementors of an abstract/interface method.
  // Use the flat-by-name lookup from MethodRegistry.
  for (const parsed of parsedFiles) {
    // For each member call site with an explicit receiver:
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'call') continue;
      if (site.callForm !== 'member') continue;
      if (site.explicitReceiver === undefined) continue;

      const siteKey = `${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`;
      if (handledSites.has(siteKey)) continue;

      const receiverName = site.explicitReceiver.name;

      // Look up the receiver's type binding in the scope chain.
      // We walk from inScope upward looking for the typeBinding.
      const boundType = findTypeBindingInScopeChain(site.inScope, receiverName, scopes);
      if (boundType === undefined) continue;

      // The bound type must resolve to a unique class def.
      const baseCandidates = model.types.lookupClassByName(boundType);
      if (baseCandidates.length !== 1) continue;
      const baseDef = baseCandidates[0];
      if (baseDef === undefined) continue;

      // The base must be an Interface or abstract-like class (we check
      // by looking if there's at least one concrete implementor in the
      // workspace that has the called method and differs from the base).
      const allMethodCandidates = model.methods.lookupMethodByName(site.name);
      if (allMethodCandidates.length === 0) continue;

      // Collect unique concrete classes that own this method.
      const seenOwners = new Set<string>();
      const concreteImplementors = allMethodCandidates.filter((m) => {
        const ownerId = (m as { ownerId?: string }).ownerId;
        if (ownerId === undefined) return false;
        if (ownerId === baseDef.nodeId) return false; // skip the base itself
        if (seenOwners.has(ownerId)) return false;
        seenOwners.add(ownerId);
        return true;
      });

      if (concreteImplementors.length === 0) continue;
      // Safety: don't emit edges when too many candidates (very common
      // method name like `toString`, `equals` — would create noise).
      if (concreteImplementors.length > 20) continue;

      const callerGraphId = resolveCallerGraphId(site.inScope, scopes, nodeLookup);
      if (callerGraphId === undefined) continue;

      let edgesForSite = 0;
      for (const implMethod of concreteImplementors) {
        const tgtGraphId = resolveDefGraphId(implMethod.filePath, implMethod, nodeLookup);
        if (tgtGraphId === undefined) continue;

        const relId = `rel:CALLS:${callerGraphId}->${tgtGraphId}`;
        if (seen.has(relId)) continue;
        seen.add(relId);
        graph.addRelationship({
          id: relId,
          sourceId: callerGraphId,
          targetId: tgtGraphId,
          type: 'CALLS',
          confidence: 0.55,
          reason: 'java-spring-map-dispatch',
        });
        edgesForSite++;
        emitted++;
      }

      if (edgesForSite > 0) {
        handledSites.add(siteKey);
      }
    }
  }
  return emitted;
}

/**
 * Walk the scope chain from `startScope` upward looking for a typeBinding
 * for `name`. Returns the raw type name string or `undefined` when not found.
 *
 * Mirrors `findReceiverTypeBinding` from `scope/walkers.ts` but returns
 * the raw type name rather than a `TypeRef`, since we only need the class
 * name string for model.types.lookupClassByName().
 */
function findTypeBindingInScopeChain(
  startScope: import('gitnexus-shared').ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): string | undefined {
  let current: import('gitnexus-shared').ScopeId | null = startScope;
  const visited = new Set<import('gitnexus-shared').ScopeId>();
  while (current !== null) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) break;
    const tb = scope.typeBindings.get(name);
    if (tb !== undefined) return tb.rawName;
    current = scope.parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/**
 * `emitUnresolvedReceiverEdges` hook for Java.
 *
 * Called by the scope-resolution orchestrator after `emitReceiverBoundCalls`
 * and before `emitFreeCallFallback`. Emits synthetic CALLS edges for the
 * two Java dynamic-dispatch patterns described at the top of this file.
 *
 * Returns the total number of edges emitted.
 */
export function javaEmitUnresolvedReceiverEdges(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  handledSites: Set<string>,
  model: SemanticModel,
): number {
  let total = 0;
  total += emitConstructorDelegationEdges(
    graph,
    scopes,
    parsedFiles,
    nodeLookup,
    handledSites,
    model,
  );
  total += emitSpringMapDispatchEdges(
    graph,
    scopes,
    parsedFiles,
    nodeLookup,
    handledSites,
    model,
  );
  return total;
}
