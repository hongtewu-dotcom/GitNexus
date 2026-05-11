import { glob } from 'glob';
import fs from 'node:fs';
import path from 'node:path';
import Parser from 'tree-sitter';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import {
  scanSquirrelJava,
  classInfoToDetections,
  SQUIRREL_JAVA_LANGUAGE,
  type SquirrelDetection,
} from './squirrel-patterns/java.js';

/**
 * SquirrelExtractor — scans MDP squirrel.properties files AND Java source
 * code to produce directional Squirrel Redis contracts at category granularity.
 *
 * Two-phase extraction:
 *
 * Phase 1 (Properties): Extract {cluster, category, propertyKey} tuples from
 * squirrel.properties — this tells us WHICH categories a service declares.
 *
 * Phase 2 (Source Scan): Use tree-sitter to scan Java files for
 * RedisStoreClient method calls, classifying each class as reader, writer,
 * or readwrite based on the Redis methods it invokes.
 *
 * The two phases are joined on the category property key (the @Value
 * annotation key matches the properties key). The final role is:
 *   - writer only  → role: 'provider' (data producer)
 *   - reader only  → role: 'consumer' (data consumer)
 *   - readwrite    → emit BOTH provider + consumer contracts
 *
 * If source scanning finds no role info for a category (e.g. no Java files,
 * or the category is only declared in properties but not used via RedisStoreClient
 * in scanned code), we fall back to emitting role='consumer' (safe default:
 * the service at least reads from Redis).
 *
 * Contract format: `custom::squirrel::<cluster>::<category>`
 * No category → no contract (cluster-level alone is meaningless noise).
 */

// Matches both indexed (mdp.squirrel[0].clusterName) and plain (mdp.squirrel.clusterName) formats
const CLUSTER_PATTERN = /^\s*mdp\.(?:s|S)quirrel(?:\[\d+\])?\.clusterName\s*=\s*(.+)$/mg;

/**
 * Matches category declarations in properties files.
 * Captures the full property key AND the category value.
 * E.g. "squirrel.fare.fd.category.name=flight-fare-fd" → key="squirrel.fare.fd.category.name", value="flight-fare-fd"
 */
const CATEGORY_PATTERN = /^\s*([\w.]+\.category(?:\.name)?)\s*=\s*(.+)$/mg;

function makeCategoryContract(
  clusterName: string,
  category: string,
  role: 'provider' | 'consumer',
  filePath: string,
  source: string,
  confidence: number,
): ExtractedContract {
  return {
    contractId: `custom::squirrel::${clusterName}::${category}`,
    type: 'custom',
    role,
    symbolUid: '',
    symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: category },
    symbolName: category,
    confidence,
    meta: {
      framework: 'squirrel',
      clusterName,
      category,
      extractionStrategy: source,
    },
  };
}

interface CategoryDeclaration {
  propertyKey: string; // e.g. "squirrel.fare.fd.category.name"
  categoryValue: string; // e.g. "flight-fare-fd"
  filePath: string;
}

export class SquirrelExtractor implements ContractExtractor {
  type = 'custom' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    // ─── Phase 1: Properties scan ────────────────────────────────────────
    // Prefer prod/onlinepc profiles; fall back to any squirrel.properties if none found
    let propFiles = await glob('**/profiles/{prod,onlinepc}/squirrel.properties', {
      cwd: repoPath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**'],
    });
    if (propFiles.length === 0) {
      propFiles = await glob('**/squirrel.properties', {
        cwd: repoPath,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**'],
      });
    }

    const clusters: string[] = [];
    const categoryDecls: CategoryDeclaration[] = [];

    for (const rel of propFiles) {
      const absPath = path.join(repoPath, rel);
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      // Extract cluster names
      CLUSTER_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CLUSTER_PATTERN.exec(content)) !== null) {
        const clusterName = match[1].trim();
        if (!clusterName || clusterName.startsWith('${')) continue;
        if (!clusters.includes(clusterName)) {
          clusters.push(clusterName);
        }
      }

      // Extract category declarations (with full property key)
      CATEGORY_PATTERN.lastIndex = 0;
      while ((match = CATEGORY_PATTERN.exec(content)) !== null) {
        const propertyKey = match[1].trim();
        const categoryValue = match[2].trim();
        if (!categoryValue || categoryValue.startsWith('${')) continue;
        categoryDecls.push({ propertyKey, categoryValue, filePath: rel });
      }
    }

    // If no categories or no clusters, nothing to emit
    if (categoryDecls.length === 0 || clusters.length === 0) return [];

    // ─── Phase 2: Java source scan for read/write classification ─────────
    const rolesByPropertyKey = await this.scanJavaSources(repoPath);

    // ─── Phase 3: Join and emit contracts ────────────────────────────────
    const out: ExtractedContract[] = [];
    const seen = new Set<string>();

    for (const cluster of clusters) {
      for (const decl of categoryDecls) {
        const roles = rolesByPropertyKey.get(decl.propertyKey);

        if (roles && roles.size > 0) {
          // Source scan found concrete roles for this category
          for (const role of roles) {
            const key = `${cluster}::${decl.categoryValue}::${role}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(makeCategoryContract(
              cluster,
              decl.categoryValue,
              role,
              decl.filePath,
              'properties_scan+source_scan',
              0.9,
            ));
          }
        } else {
          // No source scan data — fall back to consumer (safe default)
          const key = `${cluster}::${decl.categoryValue}::consumer`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(makeCategoryContract(
            cluster,
            decl.categoryValue,
            'consumer',
            decl.filePath,
            'properties_scan',
            0.75,
          ));
        }
      }
    }

    return out;
  }

  /**
   * Scan Java source files for RedisStoreClient usage patterns.
   * Returns a map: propertyKey → Set<'provider' | 'consumer'>
   */
  private async scanJavaSources(
    repoPath: string,
  ): Promise<Map<string, Set<'provider' | 'consumer'>>> {
    const roleMap = new Map<string, Set<'provider' | 'consumer'>>();

    const javaFiles = await glob('**/*.java', {
      cwd: repoPath,
      nodir: true,
      ignore: [
        '**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**',
        '**/test/**', '**/tests/**', '**/src/test/**',
      ],
    });

    const parser = new Parser();
    parser.setLanguage(SQUIRREL_JAVA_LANGUAGE);

    for (const rel of javaFiles) {
      const content = readSafe(repoPath, rel);
      if (!content) continue;

      // Quick pre-filter: skip files that don't mention Redis client types
      if (!content.includes('RedisStoreClient') &&
          !content.includes('RedisClusterClient') &&
          !content.includes('StoreClient')) {
        continue;
      }

      let tree: Parser.Tree;
      try {
        tree = parser.parse(content);
      } catch {
        continue;
      }

      const classInfos = scanSquirrelJava(tree);
      if (classInfos.length === 0) continue;

      const detections = classInfoToDetections(classInfos);
      for (const det of detections) {
        const existing = roleMap.get(det.categoryPropertyKey) ?? new Set();
        existing.add(det.role);
        roleMap.set(det.categoryPropertyKey, existing);
      }
    }

    return roleMap;
  }
}
