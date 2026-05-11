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
 *
 * Property patterns:
 *   mdp.mafka.consumers[N].topicName = <topic>
 *   mdp.mafka.producers[N].topicName = <topic>
 */

const TOPIC_PATTERN = /^mdp\.mafka\.(consumers?|producers?)\[\d+\]\.topicName\s*=\s*(.+)$/;

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
      extractionStrategy: 'properties_scan',
    },
  };
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
    const files = await glob('**/mafka.properties', {
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

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const match = TOPIC_PATTERN.exec(trimmed);
        if (!match) continue;

        const roleStr = match[1].toLowerCase();
        const topicName = match[2].trim();
        if (!topicName || topicName.startsWith('${')) continue;

        const role: 'provider' | 'consumer' = roleStr.startsWith('producer')
          ? 'provider'
          : 'consumer';
        const key = `${topicName}|${role}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const symbolName = role === 'provider'
          ? `mafkaProducer(${topicName})`
          : `mafkaConsumer(${topicName})`;
        out.push(makeContract(topicName, role, rel, symbolName));
      }
    }

    return out;
  }
}
