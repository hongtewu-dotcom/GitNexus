import { glob } from 'glob';
import fs from 'node:fs';
import path from 'node:path';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';

/**
 * CraneExtractor — scans Java source files for @Crane("task-name") annotations
 * and emits `custom` contracts (role: provider) for each discovered task.
 *
 * Crane is Meituan's internal distributed job scheduling framework.
 * Each @Crane annotation registers a scheduled task with a unique string key.
 *
 * Contract format: `custom::crane::<task-name>`
 * Role: always `provider` (the annotated method *provides* the task implementation)
 *
 * Matching: two repos that declare the same task name will be cross-linked.
 * In practice, a task name should be unique across the group, so cross-links
 * indicate shared/duplicated task definitions worth investigating.
 */

const CRANE_ANNOTATION_RE = /@Crane\s*\(\s*["']([^"']+)["']\s*\)/g;

function makeContract(taskName: string, filePath: string, symbolName: string): ExtractedContract {
  return {
    contractId: `custom::crane::${taskName}`,
    type: 'custom',
    role: 'provider',
    symbolUid: '',
    symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: symbolName },
    symbolName,
    confidence: 0.95,
    meta: {
      framework: 'crane',
      taskName,
      extractionStrategy: 'regex_scan',
    },
  };
}

export class CraneExtractor implements ContractExtractor {
  type = 'custom' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(_dbExecutor: CypherExecutor, repoPath: string, _repo: RepoHandle): Promise<ExtractedContract[]> {
    const javaFiles = await glob('**/*.java', {
      cwd: repoPath,
      ignore: [
        '**/node_modules/**',
        '**/.git/**',
        '**/target/**',
        '**/build/**',
        '**/dist/**',
        '**/*Test.java',
        '**/*Tests.java',
      ],
      nodir: true,
    });

    const out: ExtractedContract[] = [];

    for (const rel of javaFiles) {
      const absPath = path.join(repoPath, rel);
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      // Reset lastIndex before each file scan
      CRANE_ANNOTATION_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CRANE_ANNOTATION_RE.exec(content)) !== null) {
        const taskName = match[1].trim();
        if (!taskName) continue;

        // Try to extract the enclosing method name for a better symbolName
        const beforeMatch = content.slice(0, match.index);
        const methodMatch = beforeMatch.match(
          /(?:public|protected|private|void|\w+)\s+(\w+)\s*\([^)]*\)\s*(?:throws[^{]*)?\s*\{?\s*$/,
        );
        const symbolName = methodMatch ? `${methodMatch[1]}@${taskName}` : `crane.task.${taskName}`;

        out.push(makeContract(taskName, rel, symbolName));
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
