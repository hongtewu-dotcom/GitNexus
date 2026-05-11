import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runGroupTrace } from '../../../src/core/group/trace.js';
import type { TraceResult, TraceDeps } from '../../../src/core/group/trace.js';
import type { GroupToolPort, GroupRepoHandle } from '../../../src/core/group/service.js';
import type { ContractRegistry, CrossLink } from '../../../src/core/group/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpGroup(opts?: {
  repos?: Record<string, string>;
  contracts?: ContractRegistry;
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

  if (opts?.contracts) {
    fs.writeFileSync(
      path.join(groupDir, 'contracts.json'),
      JSON.stringify(opts.contracts, null, 2),
    );
  }

  return {
    tmpDir,
    groupDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function makeCrossLink(overrides: Partial<CrossLink> = {}): CrossLink {
  return {
    from: {
      repo: 'app/backend',
      symbolUid: 'be-consumer-uid',
      symbolRef: { filePath: 'src/client.ts', name: 'callFrontend' },
    },
    to: {
      repo: 'app/frontend',
      symbolUid: 'fe-provider-uid',
      symbolRef: { filePath: 'src/api.ts', name: 'handleRequest' },
    },
    type: 'http',
    contractId: 'http::GET::/api/data',
    matchType: 'exact',
    confidence: 1,
    ...overrides,
  };
}

function makeRegistry(crossLinks: CrossLink[] = []): ContractRegistry {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots: {},
    missingRepos: [],
    contracts: [],
    crossLinks,
  };
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

  it('returns error when contracts.json is missing', async () => {
    const { tmpDir, cleanup } = tmpGroup();
    try {
      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'foo',
      });
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('contracts.json');
    } finally {
      cleanup();
    }
  });

  it('returns error when repo path not in group', async () => {
    const { tmpDir, cleanup } = tmpGroup({ contracts: makeRegistry() });
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
    const { tmpDir, cleanup } = tmpGroup({ contracts: makeRegistry() });
    try {
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

  it('returns single-repo trace when no crossLinks match', async () => {
    const { tmpDir, cleanup } = tmpGroup({ contracts: makeRegistry() });
    try {
      const { executeParameterized, executeQuery } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // First call: resolve entry symbol by id
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'sym-1', name: 'myFunc', type: 'Function', filePath: 'src/main.ts' },
      ]);
      // Second call: resolve by name (won't be called since first succeeds)

      // BFS query returns one neighbor
      (executeQuery as any).mockResolvedValueOnce([
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
      (executeQuery as any).mockResolvedValueOnce([]);

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

  it('follows crossLink to second repo', async () => {
    const crossLink = makeCrossLink();
    const { tmpDir, cleanup } = tmpGroup({
      contracts: makeRegistry([crossLink]),
    });
    try {
      const { executeParameterized, executeQuery } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // Entry repo: resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'be-consumer-uid', name: 'callFrontend', type: 'Function', filePath: 'src/client.ts' },
      ]);

      // Entry repo BFS depth 1: no CALLS neighbors (the entry node itself matches crossLink)
      (executeQuery as any).mockResolvedValueOnce([]);

      // Target repo: resolve symbolUid
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'fe-provider-uid', name: 'handleRequest', type: 'Function', filePath: 'src/api.ts' },
      ]);

      // Target repo BFS depth 1: one neighbor
      (executeQuery as any).mockResolvedValueOnce([
        {
          sourceId: 'fe-provider-uid',
          id: 'fe-inner-uid',
          name: 'processData',
          type: 'Function',
          filePath: 'src/processor.ts',
          relType: 'CALLS',
          confidence: 0.9,
        },
      ]);
      // Target repo BFS depth 2: no more
      (executeQuery as any).mockResolvedValueOnce([]);

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-consumer-uid',
        maxDepth: 3,
        maxCrossDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      expect(trace.segments).toHaveLength(2);

      // First segment: entry repo
      expect(trace.segments[0].repoPath).toBe('app/backend');
      expect(trace.segments[0].crossHops).toHaveLength(1);
      expect(trace.segments[0].crossHops[0].contractId).toBe('http::GET::/api/data');

      // Second segment: target repo
      expect(trace.segments[1].repoPath).toBe('app/frontend');
      expect(trace.segments[1].entrySymbolUid).toBe('fe-provider-uid');
      expect(trace.segments[1].nodes).toHaveLength(1);
      expect(trace.segments[1].nodes[0].name).toBe('processData');
    } finally {
      cleanup();
    }
  });

  it('respects maxCrossDepth and sets truncated', async () => {
    const crossLink = makeCrossLink();
    const { tmpDir, cleanup } = tmpGroup({
      contracts: makeRegistry([crossLink]),
    });
    try {
      const { executeParameterized, executeQuery } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // Entry repo: resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'be-consumer-uid', name: 'callFrontend', type: 'Function', filePath: 'src/client.ts' },
      ]);

      // Entry repo BFS: no neighbors
      (executeQuery as any).mockResolvedValueOnce([]);

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-consumer-uid',
        maxCrossDepth: 0, // no cross-repo hops allowed
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      // Only entry repo segment
      expect(trace.segments).toHaveLength(1);
      expect(trace.truncated).toBe(true);
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
    const { tmpDir, cleanup } = tmpGroup({ contracts: makeRegistry() });
    try {
      const { executeParameterized, executeQuery } = await import(
        '../../../src/core/lbug/pool-adapter.js'
      );

      // Resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'sym-1', name: 'myFunc', type: 'Function', filePath: 'src/main.ts' },
      ]);

      // BFS returns a test file neighbor
      (executeQuery as any).mockResolvedValueOnce([
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
