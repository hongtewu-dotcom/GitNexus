#!/usr/bin/env npx tsx
/**
 * Benchmark for cross-repo call trace (runGroupTraceWithResolver).
 *
 * Uses only the public API exported from src/core/group/trace.ts and
 * src/core/group/service.ts — no dependency on LocalBackend internals.
 *
 * The port implementation is a minimal shim: it resolves repos directly
 * from ~/.gitnexus/registry.json and opens LadybugDB via initLbug, which
 * is exactly what the BFS engine needs and nothing more.
 *
 * Measures (all with maxCrossDepth=1 unless noted):
 *   1. Cold start  — first call, module-level mtime caches empty, lbug
 *                    connections not yet open
 *   2. Warm runs   — subsequent calls, contracts.json + group.yaml
 *                    mtime-cached, lbug connection pool warm
 *   3. Cross-depth sweep — wall time vs maxCrossDepth (1 2 3 4 5)
 *                    using the primary target
 *   4. Multi-target — three representative entry points at depth=1
 *                    to show results generalise beyond a single symbol
 *
 * Usage:
 *   npx tsx scripts/bench-group-trace.ts
 *
 * Env overrides:
 *   BENCH_GROUP        group name            (default: my-group)
 *   BENCH_ITERS        warm iterations       (default: 5)
 *   BENCH_MAX_DEPTH    intra-repo BFS depth  (default: 0 = unlimited)
 */

import {
  runGroupTraceWithResolver,
  type TraceDeps,
  type TraceParams,
} from '../src/core/group/trace.js';
import type { GroupRepoHandle, GroupToolPort } from '../src/core/group/service.js';
import { DefaultSymbolResolver } from '../src/core/group/trace-resolver.js';
import { listRegisteredRepos } from '../src/storage/repo-manager.js';
import { closeLbug, setMaxPoolSize } from '../src/core/lbug/pool-adapter.js';
import { getDefaultGitnexusDir } from '../src/core/group/storage.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const GROUP = process.env.BENCH_GROUP ?? 'my-group';
const ITERS = Number(process.env.BENCH_ITERS ?? '5');
const MAX_DEPTH = Number(process.env.BENCH_MAX_DEPTH ?? '0');

/**
 * Entry points to benchmark. Replace these with symbols from your own indexed
 * group — each should exercise a different call-graph shape (shallow, wide,
 * different repo cluster) to show how performance scales with fan-out.
 *
 * Example (replace with your own):
 *   { repo: 'service-a', target: 'entryMethodA', label: 'service-a::entryMethodA' },
 *   { repo: 'service-a', target: 'entryMethodB', label: 'service-a::entryMethodB' },
 *   { repo: 'service-b', target: 'entryMethodC', label: 'service-b::entryMethodC' },
 */
const TARGETS: Array<{ repo: string; target: string; label: string }> = [
  {
    repo: process.env.BENCH_REPO_A ?? 'service-a',
    target: process.env.BENCH_TARGET_A ?? 'entryMethodA',
    label: 'service-a::entryMethodA',
  },
  {
    repo: process.env.BENCH_REPO_B ?? 'service-a',
    target: process.env.BENCH_TARGET_B ?? 'entryMethodB',
    label: 'service-a::entryMethodB',
  },
  {
    repo: process.env.BENCH_REPO_C ?? 'service-b',
    target: process.env.BENCH_TARGET_C ?? 'entryMethodC',
    label: 'service-b::entryMethodC',
  },
];

const PRIMARY = TARGETS[0]!; // used for cold-start, warm, and depth sweep

// ─── Minimal GroupToolPort ────────────────────────────────────────────────────
//
// Resolves repos directly from ~/.gitnexus/registry.json.
// impact / query / context / impactByUid are not called by the BFS engine;
// they are stubbed only to satisfy the interface.

async function buildPort(): Promise<GroupToolPort> {
  const entries = await listRegisteredRepos({ validate: true });
  const byName = new Map(entries.map((e) => [e.name, e]));

  const toHandle = (registryName: string): GroupRepoHandle => {
    const e = byName.get(registryName);
    if (!e) throw new Error(`Repo not found in registry: "${registryName}"`);
    return {
      id: registryName,
      name: e.name,
      repoPath: e.path,
      storagePath: e.storagePath,
      indexedAt: e.indexedAt,
      lastCommit: e.lastCommit,
    };
  };

  return {
    resolveRepo: async (p = '') => toHandle(p),
    impact: async () => ({}),
    query: async () => ({}),
    context: async () => ({}),
    impactByUid: async () => null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (ms: number) => `${ms.toFixed(0)} ms`;
const pad = (s: string, n: number) => s.padEnd(n);

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, v) => a + v, 0) / s.length;
  return {
    min: s[0]!,
    p50: s[Math.floor(s.length / 2)]!,
    p95: s[Math.floor(s.length * 0.95)]!,
    max: s[s.length - 1]!,
    mean: Math.round(mean),
    stddev: Math.round(
      Math.sqrt(s.map((v) => (v - mean) ** 2).reduce((a, v) => a + v, 0) / s.length),
    ),
  };
}

async function runTrace(
  deps: TraceDeps,
  repo: string,
  target: string,
  maxCrossDepth: number,
): Promise<{ ms: number; crossHops: number }> {
  const params: TraceParams = {
    name: GROUP,
    repo,
    target,
    direction: 'downstream',
    maxDepth: MAX_DEPTH,
    maxCrossDepth,
  };
  const resolver = new DefaultSymbolResolver();
  const t0 = process.hrtime.bigint();
  const result = await runGroupTraceWithResolver(deps, params, resolver);
  const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`trace error: ${(result as { error: string }).error}`);
  }
  const r = result as { segments?: Array<{ crossHops?: unknown[] }> };
  const crossHops = r.segments?.reduce((n, s) => n + (s.crossHops?.length ?? 0), 0) ?? 0;
  return { ms, crossHops };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  setMaxPoolSize(30);

  const port = await buildPort();
  const deps: TraceDeps = { port, gitnexusDir: getDefaultGitnexusDir() };

  console.log(`\nbench-group-trace`);
  console.log(
    `  group=${GROUP}  iters=${ITERS}  maxDepth=${MAX_DEPTH}  resolver=DefaultSymbolResolver`,
  );
  console.log(`  primary=${PRIMARY.label}  maxCrossDepth=1\n`);

  // ── 1. Cold start ────────────────────────────────────────────────────────
  console.log('── 1. Cold start  (empty module cache, no open lbug connections) ──');
  const cold = await runTrace(deps, PRIMARY.repo, PRIMARY.target, 1);
  console.log(`  ${PRIMARY.label}: ${fmt(cold.ms)}  (${cold.crossHops} cross-hops visited)\n`);

  // ── 2. Warm runs ─────────────────────────────────────────────────────────
  console.log(
    `── 2. Warm runs ×${ITERS}  (contracts.json + group.yaml mtime-cached, lbug pool warm) ──`,
  );
  const warmSamples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const { ms } = await runTrace(deps, PRIMARY.repo, PRIMARY.target, 1);
    warmSamples.push(ms);
    console.log(`  iter ${i + 1}: ${fmt(ms)}`);
  }
  const w = stats(warmSamples);
  console.log(
    `  → min ${fmt(w.min)}  p50 ${fmt(w.p50)}  p95 ${fmt(w.p95)}  max ${fmt(w.max)}  σ ±${fmt(w.stddev)}`,
  );
  console.log(`  → mtime-cache speedup vs cold: ${(cold.ms / w.p50).toFixed(1)}×\n`);

  // ── 3. Cross-depth sweep ─────────────────────────────────────────────────
  console.log('── 3. maxCrossDepth sweep  (warm cache, primary target) ────────────');
  console.log(`  ${'depth'.padEnd(6)}  ${'time'.padEnd(9)}  cross-hops`);
  console.log(`  ${'─'.repeat(30)}`);
  const depthRows: { depth: number; ms: number; crossHops: number }[] = [];
  for (const depth of [1, 2, 3, 4, 5]) {
    await runTrace(deps, PRIMARY.repo, PRIMARY.target, depth); // warm-up this depth
    const { ms, crossHops } = await runTrace(deps, PRIMARY.repo, PRIMARY.target, depth);
    depthRows.push({ depth, ms, crossHops });
    console.log(`  ${String(depth).padEnd(6)}  ${fmt(ms).padEnd(9)}  ${crossHops}`);
  }
  console.log();

  // ── 4. Multi-target warm ─────────────────────────────────────────────────
  console.log(`── 4. Multi-target  (${ITERS} warm iters each, maxCrossDepth=1) ─────────`);
  const colW = Math.max(...TARGETS.map((t) => t.label.length)) + 2;
  console.log(`  ${'target'.padEnd(colW)}  ${'p50'.padEnd(9)}  ${'p95'.padEnd(9)}  σ`);
  console.log(`  ${'─'.repeat(colW + 30)}`);
  const multiRows: {
    label: string;
    p50: number;
    p95: number;
    stddev: number;
    crossHops: number;
  }[] = [];
  for (const tgt of TARGETS) {
    const samples: number[] = [];
    let crossHops = 0;
    for (let i = 0; i < ITERS; i++) {
      const r = await runTrace(deps, tgt.repo, tgt.target, 1);
      samples.push(r.ms);
      crossHops = r.crossHops;
    }
    const s = stats(samples);
    multiRows.push({ label: tgt.label, p50: s.p50, p95: s.p95, stddev: s.stddev, crossHops });
    console.log(
      `  ${pad(tgt.label, colW)}  ${fmt(s.p50).padEnd(9)}  ${fmt(s.p95).padEnd(9)}  ±${fmt(s.stddev)}  (${crossHops} cross-hops)`,
    );
  }
  console.log();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('══ Summary ═════════════════════════════════════════════════════════');
  console.log(`  Group size          : ${GROUP}`);
  console.log(`  Cold start          : ${fmt(cold.ms)}`);
  console.log(`  Warm p50 / p95      : ${fmt(w.p50)} / ${fmt(w.p95)}`);
  console.log(`  mtime-cache speedup : ${(cold.ms / w.p50).toFixed(1)}×`);
  console.log(
    `  Depth 1→5 range     : ${fmt(Math.min(...depthRows.map((r) => r.ms)))}–${fmt(Math.max(...depthRows.map((r) => r.ms)))}`,
  );
  console.log(
    `  Multi-target p50    : ${fmt(Math.min(...multiRows.map((r) => r.p50)))}–${fmt(Math.max(...multiRows.map((r) => r.p50)))}`,
  );
  console.log();

  await closeLbug();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
