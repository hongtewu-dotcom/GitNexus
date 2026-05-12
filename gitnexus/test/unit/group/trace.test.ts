import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runGroupTrace } from '../../../src/core/group/trace.js';
import type { TraceResult, TraceDeps } from '../../../src/core/group/trace.js';
import type { GroupToolPort, GroupRepoHandle } from '../../../src/core/group/service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpGroup(opts?: {
  repos?: Record<string, string>;
}): { tmpDir: string; groupDir: string; cleanup: () => void } {
  const tmpDir = path.join(os.tmpdir(), `gitnexus-trace-${Date.now()}-${Math.random()}`);
  const groupDir = path.join(tmpDir, 'groups', 'g1');
  fs.mkdirSync(groupDir, { recursive: true });

  const repos = opts?.repos ?? { 'app/backend': 'reg-be', 'app/frontend': 'reg-fe' };
  const reposYaml = Object.entries(repos)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  fs.writeFileSync(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: g1
description: ""
repos:
${reposYaml}
links: []
packages: {}
detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: true
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
  );

  return {
    tmpDir,
    groupDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** Write a contracts.json file into the group directory. */
function writeContractsJson(
  groupDir: string,
  crossLinks: any[] = [],
  contracts: any[] = [],
): void {
  fs.writeFileSync(
    path.join(groupDir, 'contracts.json'),
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      repoSnapshots: {},
      missingRepos: [],
      contracts,
      crossLinks,
    }),
  );
}

function makePort(overrides: Partial<GroupToolPort> = {}): GroupToolPort {
  return {
    resolveRepo: vi.fn(async (name?: string): Promise<GroupRepoHandle> => ({
      id: name ?? 'unknown',
      name: name ?? 'unknown',
      repoPath: `/tmp/repos/${name}`,
      storagePath: `/tmp/storage/${name}`,
    })),
    impact: vi.fn(async () => ({})),
    query: vi.fn(async () => ({})),
    impactByUid: vi.fn(async () => null),
    context: vi.fn(async () => ({})),
    ...overrides,
  };
}

function makeDeps(
  port: GroupToolPort,
  gitnexusDir: string,
): TraceDeps {
  return { port, gitnexusDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Mock lbug pool-adapter so we don't need a real LadybugDB
vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(async () => {}),
  closeLbug: vi.fn(async () => {}),
  executeParameterized: vi.fn(async () => []),
  executeQuery: vi.fn(async () => []),
}));

describe('runGroupTrace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when name is missing', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp'), {
      name: '',
      repo: 'app/backend',
      target: 'foo',
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('name');
  });

  it('returns error when repo is missing', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp'), {
      name: 'g1',
      repo: '',
      target: 'foo',
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('repo');
  });

  it('returns error when target is missing', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp'), {
      name: 'g1',
      repo: 'app/backend',
      target: '',
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('target');
  });

  it('returns error when group not found', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp/nonexistent'), {
      name: 'g1',
      repo: 'app/backend',
      target: 'foo',
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('not found');
  });

  it('returns error when repo path not in group', async () => {
    const { tmpDir, cleanup } = tmpGroup();
    try {
      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/nonexistent',
        target: 'foo',
      });
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Unknown repo path');
    } finally {
      cleanup();
    }
  });

  it('returns error when entry symbol not found in lbug', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      writeContractsJson(groupDir);
      // executeParameterized returns [] for all queries → symbol not found
      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'nonExistentSymbol',
      });
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('not found');
    } finally {
      cleanup();
    }
  });

  it('returns single-repo trace when no crossLinks exist', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      writeContractsJson(groupDir); // empty crossLinks

      const { executeParameterized, executeQuery } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // Resolve entry symbol by id
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'sym-1', name: 'myFunc', type: 'Function', filePath: 'src/main.ts' },
      ]);

      // BFS query returns one neighbor (now uses executeParameterized)
      (executeParameterized as any).mockResolvedValueOnce([
        {
          sourceId: 'sym-1',
          id: 'sym-2',
          name: 'helperFunc',
          type: 'Function',
          filePath: 'src/helper.ts',
          relType: 'CALLS',
          confidence: 1,
        },
      ]);
      // Next depth: no more neighbors
      (executeParameterized as any).mockResolvedValueOnce([]);

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'sym-1',
        maxDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      expect(trace.segments).toHaveLength(1);
      expect(trace.segments[0].repo).toBe('reg-be');
      expect(trace.segments[0].nodes).toHaveLength(1);
      expect(trace.segments[0].nodes[0].name).toBe('helperFunc');
      expect(trace.segments[0].crossHops).toHaveLength(0);
      expect(trace.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('follows cross-repo hop via contracts.json crossLinks', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      // Write contracts.json with a crossLink from app/backend → app/frontend
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/backend',
            symbolUid: 'source-scan::thrift::consumer::FrontendService/handleRequest',
            symbolRef: { filePath: 'src/client.ts', name: 'FrontendService.handleRequest' },
          },
          to: {
            repo: 'app/frontend',
            symbolUid: 'source-scan::thrift::provider::FrontendService/handleRequest',
            symbolRef: { filePath: 'src/api.ts', name: 'FrontendService.handleRequest' },
          },
          type: 'thrift',
          contractId: 'thrift::FrontendService/handleRequest',
          matchType: 'exact',
          confidence: 1,
        },
      ]);

      const { executeParameterized, executeQuery } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // Entry repo: resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'be-sym-1', name: 'callFrontend', type: 'Function', filePath: 'src/client.ts' },
      ]);

      // Entry repo BFS depth 1: no CALLS neighbors (now uses executeParameterized)
      (executeParameterized as any).mockResolvedValueOnce([]);

      // Target repo: resolve symbol by name "FrontendService.handleRequest"
      (executeParameterized as any)
        .mockResolvedValueOnce([
          { id: 'fe-sym-1', name: 'handleRequest', type: 'Function', filePath: 'src/api.ts' },
        ]);

      // Target repo BFS depth 1: one neighbor (now uses executeParameterized)
      (executeParameterized as any).mockResolvedValueOnce([
        {
          sourceId: 'fe-sym-1',
          id: 'fe-sym-2',
          name: 'processData',
          type: 'Function',
          filePath: 'src/processor.ts',
          relType: 'CALLS',
          confidence: 0.9,
        },
      ]);
      // Target repo BFS depth 2: no more
      (executeParameterized as any).mockResolvedValueOnce([]);

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-sym-1',
        maxDepth: 3,
        maxCrossDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      expect(trace.segments).toHaveLength(2);

      // First segment: entry repo
      expect(trace.segments[0].repoPath).toBe('app/backend');
      expect(trace.segments[0].crossHops).toHaveLength(1);
      expect(trace.segments[0].crossHops[0].contractId).toBe('thrift::FrontendService/handleRequest');

      // Second segment: target repo
      expect(trace.segments[1].repoPath).toBe('app/frontend');
      expect(trace.segments[1].nodes).toHaveLength(1);
      expect(trace.segments[1].nodes[0].name).toBe('processData');
    } finally {
      cleanup();
    }
  });

  it('follows cross-repo hop via topic crossLink (MQ direction reversed)', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      // For MQ/topic crossLinks: from=consumer, to=producer.
      // When tracing downstream from the producer (app/backend),
      // the fix should match link.to.repo === currentRepo and jump to link.from.repo.
      // symbolRef.name uses real mafka format: "mafkaConsumer(...)" / "mafkaProducer(...)"
      // which won't exist in LadybugDB — the isTopic flag skips resolveByName.
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/frontend', // consumer
            symbolUid: 'source-scan::topic::consumer::order_created',
            symbolRef: { filePath: 'mafka.properties', name: 'mafkaConsumer(order_created)' },
          },
          to: {
            repo: 'app/backend', // producer
            symbolUid: 'source-scan::topic::provider::order_created',
            symbolRef: { filePath: 'mafka.properties', name: 'mafkaProducer(order_created)' },
          },
          type: 'topic',
          contractId: 'topic::order_created',
          matchType: 'exact',
          confidence: 1,
        },
      ]);

      const { executeParameterized } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // Entry repo (app/backend): resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'be-producer', name: 'OrderCreatedProducer', type: 'Class', filePath: 'src/producer.ts' },
      ]);

      // Entry repo BFS depth 1: no CALLS neighbors
      (executeParameterized as any).mockResolvedValueOnce([]);

      // Consumer repo (app/frontend): topic hop — resolveByName is SKIPPED.
      // No mock needed for resolveByName. Only need empty BFS results won't be called either.
      // The segment will have empty nodes but still be added.

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-producer',
        maxDepth: 3,
        maxCrossDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      expect(trace.segments).toHaveLength(2);

      // First segment: producer repo (app/backend)
      expect(trace.segments[0].repoPath).toBe('app/backend');
      expect(trace.segments[0].crossHops).toHaveLength(1);
      expect(trace.segments[0].crossHops[0].contractId).toBe('topic::order_created');
      expect(trace.segments[0].crossHops[0].contractType).toBe('topic');

      // Second segment: consumer repo (app/frontend) — added via topic hop, no BFS
      expect(trace.segments[1].repoPath).toBe('app/frontend');
      expect(trace.segments[1].nodes).toHaveLength(0); // no BFS for topic hops
      // Crucially: NOT in skippedRepos
      expect(trace.skippedRepos).not.toContain('app/frontend');
    } finally {
      cleanup();
    }
  });

  it('deduplicates multiple topic hops to the same target repo', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      // Two topic crossLinks from app/backend → app/frontend (different topics)
      // Should produce only ONE segment for app/frontend (deduped by repo).
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/frontend',
            symbolUid: 'source-scan::topic::consumer::topic_a',
            symbolRef: { filePath: 'mafka.properties', name: 'mafkaConsumer(topic_a)' },
          },
          to: {
            repo: 'app/backend',
            symbolUid: 'source-scan::topic::provider::topic_a',
            symbolRef: { filePath: 'mafka.properties', name: 'mafkaProducer(topic_a)' },
          },
          type: 'topic',
          contractId: 'topic::topic_a',
          matchType: 'exact',
          confidence: 1,
        },
        {
          from: {
            repo: 'app/frontend',
            symbolUid: 'source-scan::topic::consumer::topic_b',
            symbolRef: { filePath: 'mafka.properties', name: 'mafkaConsumer(topic_b)' },
          },
          to: {
            repo: 'app/backend',
            symbolUid: 'source-scan::topic::provider::topic_b',
            symbolRef: { filePath: 'mafka.properties', name: 'mafkaProducer(topic_b)' },
          },
          type: 'topic',
          contractId: 'topic::topic_b',
          matchType: 'exact',
          confidence: 1,
        },
      ]);

      const { executeParameterized } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // Entry repo: resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'be-1', name: 'ProducerService', type: 'Class', filePath: 'src/producer.ts' },
      ]);
      // Entry repo BFS: no neighbors
      (executeParameterized as any).mockResolvedValueOnce([]);

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-1',
        maxDepth: 2,
        maxCrossDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      // Should be exactly 2 segments: entry + ONE for app/frontend (not two)
      expect(trace.segments).toHaveLength(2);
      expect(trace.segments[1].repoPath).toBe('app/frontend');
    } finally {
      cleanup();
    }
  });

  it('skips resolveByName for unresolvable synthetic symbol names', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      // RPC crossLink with a squirrel-style symbolName that won't exist in lbug
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/backend',
            symbolUid: 'squirrel::consumer::fare.fd',
            symbolRef: { filePath: 'src/cache.ts', name: 'squirrel.fare.fd.category.name' },
          },
          to: {
            repo: 'app/frontend',
            symbolUid: 'squirrel::provider::fare.fd',
            symbolRef: { filePath: 'squirrel.properties', name: 'squirrel.fare.fd.category.name' },
          },
          type: 'custom',
          contractId: 'custom::squirrel::fare.fd',
          matchType: 'exact',
          confidence: 0.8,
        },
      ]);

      const { executeParameterized } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // Entry repo: resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'be-1', name: 'CacheService', type: 'Class', filePath: 'src/cache.ts' },
      ]);
      // Entry repo BFS depth 1: returns the file that matches crossLink
      (executeParameterized as any).mockResolvedValueOnce([
        {
          sourceId: 'be-1',
          id: 'be-2',
          name: 'readCache',
          type: 'Method',
          filePath: 'src/cache.ts',
          relType: 'CALLS',
          confidence: 1,
        },
      ]);
      // Entry repo BFS depth 2: no more
      (executeParameterized as any).mockResolvedValueOnce([]);

      // Target repo: since symbolName is "squirrel.fare.fd.category.name",
      // isUnresolvableSymbolName should return true → no lbug query fired →
      // repo is skipped (returns null from resolveByName → skipped).

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-1',
        maxDepth: 3,
        maxCrossDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      // Entry segment should have the crossHop
      expect(trace.segments[0].crossHops).toHaveLength(1);
      // Target repo should be SKIPPED (resolveByName returned null for unresolvable name)
      expect(trace.skippedRepos).toContain('app/frontend');
      // Only 1 segment (the entry repo)
      expect(trace.segments).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('returns error for invalid direction', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp'), {
      name: 'g1',
      repo: 'app/backend',
      target: 'foo',
      direction: 'sideways' as any,
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('direction');
  });

  it('skips test files when includeTests is false', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      writeContractsJson(groupDir);

      const { executeParameterized, executeQuery } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // Resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'sym-1', name: 'myFunc', type: 'Function', filePath: 'src/main.ts' },
      ]);

      // BFS returns a test file neighbor (now uses executeParameterized)
      (executeParameterized as any).mockResolvedValueOnce([
        {
          sourceId: 'sym-1',
          id: 'test-sym',
          name: 'testMyFunc',
          type: 'Function',
          filePath: 'src/__tests__/main.test.ts',
          relType: 'CALLS',
          confidence: 1,
        },
      ]);

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'sym-1',
        includeTests: false,
        maxDepth: 1,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      // Test file should be filtered out
      expect(trace.segments[0].nodes).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
