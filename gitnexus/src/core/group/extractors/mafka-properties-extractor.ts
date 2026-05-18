import { glob } from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';

/**
 * Extracts Mafka topic contracts from MDP .properties files.
 *
 * MDP projects configure Mafka consumers/producers in:
 *   - profiles/{env}/mafka.properties
 *   - mafka.properties (root or app module)
 *   - application.properties (some projects inline mafka config here)
 *
 * Property patterns:
 *   mdp.mafka.consumers[N].topicName = <topic>
 *   mdp.mafka.consumers[N].listenerId = <beanName>
 *   mdp.mafka.producers[N].topicName = <topic>
 *
 * When `listenerId` is present, it is used as the symbolName (PascalCase
 * class name), enabling cross-repo resolution in LadybugDB. Otherwise
 * falls back to the synthetic "mafkaConsumer(topic)" format.
 */

/** Matches dbus-related topic names */
const DBUS_TOPIC_RE = /\b(dbus|databus|dts)\b/i;

/** Matches any mdp.mafka.{role}[N].{prop} = {value} line */
const PROP_PATTERN = /^mdp\.mafka\.(consumers?|producers?)\[(\d+)\]\.(\w+)\s*=\s*(.+)$/;

/**
 * Capitalize first letter: "otaEiChangeConsumer" → "OtaEiChangeConsumer".
 * This maps the Spring Bean name (camelCase) to the Java class name (PascalCase).
 */
function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the actual Java class name from a Spring bean ID by scanning source
 * files for @Component("beanId") / @Service("beanId") / @Named("beanId").
 *
 * This handles cases where the bean name differs from the class name, e.g.:
 *   - snake_case: @Component("flight_coupon_change_listener") class CouponIssueConsumer
 *   - arbitrary:  @Service("businessMafkaListener") class MafkaConsumerListener
 */
async function resolveClassNameFromBeanId(
  repoPath: string,
  beanId: string,
): Promise<{ className: string; filePath: string } | null> {
  // Only scan likely consumer/listener directories for performance
  const javaFiles = await glob('**/src/main/java/**/*.java', {
    cwd: repoPath,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**', '**/test/**'],
  });

  const annotationRe = new RegExp(
    `@(?:Component|Service|Named)\\s*\\(\\s*(?:value\\s*=\\s*)?"${escapeRegex(beanId)}"\\s*\\)`,
  );
  const classRe = /(?:public\s+)?class\s+(\w+)/;

  for (const rel of javaFiles) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, rel), 'utf-8');
    } catch {
      continue;
    }
    if (annotationRe.test(content)) {
      const m = classRe.exec(content);
      if (m) return { className: m[1], filePath: rel.replace(/\\/g, '/') };
    }
  }
  return null;
}

function makeContract(
  topicName: string,
  role: 'provider' | 'consumer',
  filePath: string,
  symbolName: string,
): ExtractedContract {
  return {
    contractId: `topic::${topicName}`,
    type: 'topic',
    role,
    symbolUid: '',
    symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: symbolName },
    symbolName,
    confidence: 0.9,
    meta: {
      broker: 'mafka',
      topicName,
      isDbusTopic: DBUS_TOPIC_RE.test(topicName),
      extractionStrategy: 'properties_scan',
    },
  };
}

interface MafkaEntry {
  role: 'provider' | 'consumer';
  topicName?: string;
  listenerId?: string;
}

export class MafkaPropertiesExtractor implements ContractExtractor {
  type = 'topic' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    // Scan mafka.properties AND application.properties (some projects inline
    // mdp.mafka.* config in application.properties instead of a separate file)
    const files = await glob('**/{mafka,application}.properties', {
      cwd: repoPath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**'],
    });

    const out: ExtractedContract[] = [];
    const seen = new Set<string>();

    for (const rel of files) {
      const absPath = path.join(repoPath, rel);
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      // Group properties by role+index → collect topicName + listenerId together
      const entries = new Map<string, MafkaEntry>();

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const match = PROP_PATTERN.exec(trimmed);
        if (!match) continue;

        const roleStr = match[1].toLowerCase();
        const index = match[2];
        const prop = match[3];
        const value = match[4].trim();

        const role: 'provider' | 'consumer' = roleStr.startsWith('producer')
          ? 'provider'
          : 'consumer';
        const key = `${roleStr}[${index}]`;

        let entry = entries.get(key);
        if (!entry) {
          entry = { role };
          entries.set(key, entry);
        }

        if (prop === 'topicName' && value && !value.startsWith('${')) {
          entry.topicName = value;
        } else if (prop === 'listenerId' && value) {
          entry.listenerId = value;
        }
      }

      // Emit contracts from grouped entries
      for (const entry of entries.values()) {
        if (!entry.topicName) continue;

        const dedupeKey = `${entry.topicName}|${entry.role}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // Use listenerId to derive symbolName for LadybugDB resolution.
        // First try to resolve the actual class name from @Component/@Service
        // annotations (handles bean name ≠ class name cases), then fall back
        // to capitalizeFirst(listenerId), then to synthetic format.
        let symbolName: string;
        let contractFilePath = rel;
        if (entry.listenerId && entry.role === 'consumer') {
          const resolved = await resolveClassNameFromBeanId(repoPath, entry.listenerId);
          if (resolved) {
            symbolName = resolved.className;
            contractFilePath = resolved.filePath;
          } else {
            symbolName = capitalizeFirst(entry.listenerId);
          }
        } else if (entry.role === 'provider') {
          symbolName = `mafkaProducer(${entry.topicName})`;
        } else {
          symbolName = `mafkaConsumer(${entry.topicName})`;
        }

        out.push(makeContract(entry.topicName, entry.role, contractFilePath, symbolName));
      }
    }

    return out;
  }
}
