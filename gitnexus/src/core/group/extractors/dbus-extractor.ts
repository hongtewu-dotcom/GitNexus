import { glob } from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';

/**
 * DbusExtractor — scans for DBus CDC (Change Data Capture) consumers.
 *
 * Supports two consumption patterns:
 *
 * **Mode A (Mafka Consumer)**:
 *   - Identifies dbus topics in mafka.properties (topic name contains dbus|databus|dts)
 *   - Resolves the listener class from listenerId bean name
 *   - Extracts tableNames from switch-case, static constants, or DbusUtils usage
 *
 * **Mode B (Thrift Server)**:
 *   - Finds classes implementing DataBusEventServiceV2.Iface
 *   - Extracts tableNames from handleUpdate/handleInsert/handleDelete method bodies
 *   - Identifies @MdpThriftServer or @MdpThriftService annotations
 *
 * References:
 *   - mafka-properties-extractor.ts for bean ID resolution logic
 *   - crane-extractor.ts for annotation scanning patterns
 */

/** Matches dbus-related topic names in mafka.properties */
const DBUS_TOPIC_RE = /\b(dbus|databus|dts|cdc)\b/i;

/** Matches switch-case table names: case "table_name" */
const SWITCH_CASE_RE = /case\s+"([^"]+)"/g;

/** Matches static TABLE_* constants: private static final String TABLE_FOO = "table_name" */
const TABLE_CONST_RE = /\b(?:private|public|protected)?\s+static\s+final\s+String\s+(TABLE_\w+)\s*=\s*"([^"]+)"/g;

/** Matches DbusUtils.getTableName() usage */
const DBUS_TABLE_UTIL_RE = /DbusUtils\.getTableName\s*\(\s*\)\.equals\s*\(\s*"([^"]+)"\s*\)/g;

/** Matches TableEnum value declarations: ORDER("tb_order", ...) */
const TABLE_ENUM_RE = /\b\w+\s*\(\s*"([^"]+)"\s*(?:,|\))/g;

/** Matches tableMap.put("schema.table", ...) — anchored to tableMap/TABLE_MAP variable */
const TABLE_MAP_PUT_RE = /\b(?:tableMap|TABLE_MAP)\s*\.put\s*\(\s*"([^"]+)"\s*,/g;

/** Matches @MdpThriftServer(port = NNNN) */
const MDP_THRIFT_SERVER_RE = /@MdpThriftServer\s*\(\s*port\s*=\s*(\d+)\s*\)/g;

/** Matches @MdpThriftService("ServiceName") */
const MDP_THRIFT_SERVICE_RE = /@MdpThriftService\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/g;

/** Matches implements DataBusEventServiceV2.Iface */
const DATABUS_SERVICE_IMPL_RE = /implements\s+DataBusEventServiceV2\.Iface/g;

/** Matches DbusSyncHandler or DbusEventHandler pattern in constructor/field */
const DBUS_HANDLER_RE = /(?:new\s+)?(?:DbusSyncHandler|DbusEventHandler)\s*<[^>]+>\s*\([^)]*\)/g;

/** Mafka properties pattern (same as mafka-properties-extractor.ts) */
const PROP_PATTERN = /^mdp\.mafka\.(consumers?)\[(\d+)\]\.(\w+)\s*=\s*(.+)$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Capitalize first letter: "otaEiChangeConsumer" → "OtaEiChangeConsumer"
 */
function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * Resolve the actual Java class name from a Spring bean ID by scanning source
 * files for @Component("beanId") / @Service("beanId") / @Named("beanId").
 */
async function resolveClassNameFromBeanId(
  repoPath: string,
  beanId: string,
): Promise<{ className: string; filePath: string } | null> {
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

/**
 * Extract all table names from a listener class content.
 * Supports: switch-case, TABLE_* static constants, DbusUtils.getTableName() usage.
 */
function extractTableNamesFromClass(content: string): string[] {
  const tables = new Set<string>();
  // Table names are lowercase with underscores, optionally prefixed by schema (schema.table).
  // This filter rejects business-status strings (e.g. case "SUCCESS") and config keys.
  // Table names are lowercase, contain only word chars and at most one dot (schema.table).
  // This rejects business-status strings ("SUCCESS"), config keys ("spring.datasource.url").
  const isTableName = (s: string) =>
    /^[\w.]+$/.test(s) && s === s.toLowerCase() && s.split('.').length <= 2;

  // Priority 1: switch-case branches
  let m: RegExpExecArray | null;
  SWITCH_CASE_RE.lastIndex = 0;
  while ((m = SWITCH_CASE_RE.exec(content)) !== null) {
    const table = m[1].trim();
    if (table && isTableName(table)) tables.add(table);
  }

  // Priority 2: static TABLE_* constants
  TABLE_CONST_RE.lastIndex = 0;
  while ((m = TABLE_CONST_RE.exec(content)) !== null) {
    const table = m[2].trim();
    if (table && isTableName(table)) tables.add(table);
  }

  // Priority 3: DbusUtils.getTableName().equals("table_name")
  DBUS_TABLE_UTIL_RE.lastIndex = 0;
  while ((m = DBUS_TABLE_UTIL_RE.exec(content)) !== null) {
    const table = m[1].trim();
    if (table && isTableName(table)) tables.add(table);
  }

  return [...tables];
}

/**
 * Extract database name from table name (e.g., "qos.quote_channel" → "qos")
 */
function extractDbName(tableName: string): string {
  const dotIdx = tableName.indexOf('.');
  return dotIdx > 0 ? tableName.substring(0, dotIdx) : tableName;
}

/**
 * Infer thrift service name from class name (remove Impl suffix)
 */
function inferThriftServiceName(className: string): string {
  if (className.endsWith('Impl')) {
    return className.slice(0, -4);
  }
  return className;
}

interface MafkaConsumerEntry {
  topicName: string;
  listenerId?: string;
}

function makeDbusContract(
  symbolName: string,
  filePath: string,
  tableNames: string[],
  broker: 'mafka' | 'thrift',
  opts: {
    topicName?: string;
    thriftService?: string;
    extractionStrategy: 'mafka_properties_scan' | 'thrift_service_scan';
  },
): ExtractedContract {
  const dbName = tableNames.length > 0 ? extractDbName(tableNames[0]) : '';

  let contractId: string;
  if (broker === 'mafka' && opts.topicName) {
    contractId = `dbus::${opts.topicName}`;
  } else if (broker === 'thrift' && opts.thriftService) {
    contractId = `dbus::thrift::${opts.thriftService}`;
  } else {
    contractId = `dbus::${symbolName}`;
  }

  return {
    contractId,
    type: 'dbus',
    role: 'consumer',
    symbolUid: symbolName,
    symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: symbolName },
    symbolName,
    confidence: broker === 'mafka' ? 0.85 : 0.8,
    meta: {
      broker,
      ...(opts.topicName ? { topicName: opts.topicName } : {}),
      ...(opts.thriftService ? { thriftService: opts.thriftService } : {}),
      tableNames,
      dbName,
      extractionStrategy: opts.extractionStrategy,
    },
  };
}

/**
 * Extract dbus consumers from mafka.properties (Mode A).
 * Returns Map of listenerId → consumer entry.
 */
async function extractDbusFromMafkaProperties(
  repoPath: string,
): Promise<Map<string, { topicName: string; listenerId?: string; filePath: string }>> {
  const files = await glob('**/{mafka,application}.properties', {
    cwd: repoPath,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**'],
  });

  const dbusConsumers = new Map<string, { topicName: string; listenerId?: string; filePath: string }>();

  for (const rel of files) {
    const absPath = path.join(repoPath, rel);
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    // Group properties by consumer index
    const entries = new Map<string, MafkaConsumerEntry>();

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = PROP_PATTERN.exec(trimmed);
      if (!match) continue;

      const roleStr = match[1].toLowerCase();
      if (!roleStr.startsWith('consumer')) continue;

      const index = match[2];
      const prop = match[3];
      const value = match[4].trim();

      const key = `consumer[${index}]`;
      let entry = entries.get(key);
      if (!entry) {
        entry = { topicName: '' };
        entries.set(key, entry);
      }

      if (prop === 'topicName' && value && !value.startsWith('${')) {
        entry.topicName = value;
      } else if (prop === 'listenerId' && value) {
        entry.listenerId = value;
      }
    }

    // Emit dbus consumers
    for (const [key, entry] of entries) {
      if (!entry.topicName) continue;
      // Only include dbus-related topics
      if (!DBUS_TOPIC_RE.test(entry.topicName)) continue;

      // Use listenerId as key for deduplication
      const resolveKey = entry.listenerId || entry.topicName;
      if (dbusConsumers.has(resolveKey)) continue; // already registered

      dbusConsumers.set(resolveKey, {
        topicName: entry.topicName,
        listenerId: entry.listenerId,
        filePath: rel,
      });
    }
  }

  return dbusConsumers;
}

/**
 * Extract table names from a listener class file (Mode A support).
 */
function extractTableNamesFromFile(filePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  return extractTableNamesFromClass(content);
}

/**
 * Scan all Java files in the repo for TABLE_* constants.
 * Used as a last-resort fallback when the listener class itself has no table names.
 */
async function extractTableNamesFromAllJava(repoPath: string): Promise<string[]> {
  const files = await glob('**/src/main/java/**/*.java', {
    cwd: repoPath,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**', '**/test/**'],
  });

  const tables = new Set<string>();
  for (const rel of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, rel), 'utf-8');
    } catch {
      continue;
    }
    for (const t of extractTableNamesFromClass(content)) {
      tables.add(t);
    }
  }
  return [...tables];
}

/**
 * Find dbus-related enum files and extract all table name string literals.
 * Covers TableEnum.java, DbusControlTableEnum.java, TableNameEnum.java, etc.
 * Also extracts tableMap.put("schema.table", ...) HashMap patterns.
 */
async function findDbusEnumTables(repoPath: string): Promise<string[]> {
  // Match any enum file whose name contains "Table"+"Enum" or "Dbus"+"Enum"
  const files = await glob('**/*.java', {
    cwd: repoPath,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/build/**', '**/test/**'],
  });

  // Require Enum suffix to avoid scanning non-enum helpers like TableNameConstants.java
  const ENUM_FILE_RE = /(?:Table\w*Enum|Dbus\w*Enum|\w*TableEnum|TableName\w*Enum)\.java$/i;
  const enumFiles = files.filter((f) => ENUM_FILE_RE.test(f));

  const tables = new Set<string>();
  // Table name format: word chars with optional schema prefix (e.g. tb_order, schema.table)
  const TABLE_NAME_RE = /^[\w.]+$/;

  for (const rel of enumFiles) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, rel), 'utf-8');
    } catch {
      continue;
    }
    // Must be an actual enum declaration
    if (!/\benum\s+\w/.test(content)) continue;
    let m: RegExpExecArray | null;
    TABLE_ENUM_RE.lastIndex = 0;
    while ((m = TABLE_ENUM_RE.exec(content)) !== null) {
      const table = m[1].trim();
      // Filter to plausible table names: lowercase, underscores, optional schema prefix
      if (table && TABLE_NAME_RE.test(table) && table === table.toLowerCase()) {
        tables.add(table);
      }
    }
  }

  // HashMap tableMap.put("schema.table", ...) — TABLE_MAP_PUT_RE already anchors to the
  // variable name, so no additional file-level pre-filter is needed.
  for (const rel of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, rel), 'utf-8');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    TABLE_MAP_PUT_RE.lastIndex = 0;
    while ((m = TABLE_MAP_PUT_RE.exec(content)) !== null) {
      const table = m[1].trim();
      if (table && TABLE_NAME_RE.test(table) && table === table.toLowerCase()) tables.add(table);
    }
  }

  return [...tables];
}

/**
 * Extract dbus consumers from Thrift DataBusEventServiceV2.Iface implementations (Mode B).
 */
async function extractDbusFromThriftServices(repoPath: string): Promise<ExtractedContract[]> {
  const javaFiles = await glob('**/*.java', {
    cwd: repoPath,
    nodir: true,
    ignore: [
      '**/node_modules/**', '**/.git/**', '**/target/**',
      '**/build/**', '**/dist/**', '**/*Test.java', '**/*Tests.java',
    ],
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

    // Check if this class implements DataBusEventServiceV2.Iface
    DATABUS_SERVICE_IMPL_RE.lastIndex = 0;
    if (!DATABUS_SERVICE_IMPL_RE.test(content)) continue;

    // Extract class name
    const classMatch = content.match(/(?:public\s+)?class\s+(\w+)/);
    if (!classMatch) continue;
    const className = classMatch[1];

    // Extract thrift service name
    let thriftServiceName = inferThriftServiceName(className);
    MDP_THRIFT_SERVICE_RE.lastIndex = 0;
    const svcMatch = MDP_THRIFT_SERVICE_RE.exec(content);
    if (svcMatch) {
      thriftServiceName = svcMatch[1].trim();
    }

    // Extract port (optional, for metadata)
    MDP_THRIFT_SERVER_RE.lastIndex = 0;
    const portMatch = MDP_THRIFT_SERVER_RE.exec(content);
    const port = portMatch ? parseInt(portMatch[1], 10) : undefined;

    // Extract table names from method bodies (handleUpdate, handleInsert, handleDelete)
    const tableNames = extractTableNamesFromClass(content);

    // Fallback: search enum files and tableMap.put() patterns across the repo
    if (tableNames.length === 0) {
      const enumTables = await findDbusEnumTables(repoPath);
      if (enumTables.length > 0) {
        tableNames.push(...enumTables);
      }
    }

    const contract = makeDbusContract(className, rel, tableNames, 'thrift', {
      thriftService: thriftServiceName,
      extractionStrategy: 'thrift_service_scan',
    });

    if (port !== undefined) {
      (contract.meta as Record<string, unknown>).port = port;
    }

    out.push(contract);
  }

  return out;
}

export class DbusExtractor implements ContractExtractor {
  type = 'dbus' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    const seen = new Set<string>();

    // ── Mode A: Mafka DBus Consumer ─────────────────────────────────────
    const dbusMafkaConsumers = await extractDbusFromMafkaProperties(repoPath);

    for (const [, entry] of dbusMafkaConsumers) {
      let symbolName: string;
      let filePath: string;

      if (entry.listenerId) {
        // Try to resolve the actual class name from @Component/@Service annotation
        const resolved = await resolveClassNameFromBeanId(repoPath, entry.listenerId);
        if (resolved) {
          symbolName = resolved.className;
          filePath = resolved.filePath;
        } else {
          symbolName = capitalizeFirst(entry.listenerId);
          filePath = entry.filePath;
        }
      } else {
        symbolName = `mafkaConsumer(${entry.topicName})`;
        filePath = entry.filePath;
      }

      // Extract table names from the resolved listener class
      const listenerFilePath = path.join(repoPath, filePath);
      let tableNames = extractTableNamesFromFile(listenerFilePath);

      // If no table names found in listener class, search enum files and tableMap patterns
      if (tableNames.length === 0) {
        const tableEnumTables = await findDbusEnumTables(repoPath);
        if (tableEnumTables.length > 0) {
          tableNames = tableEnumTables;
        }
      }

      // If still no table names, scan all Java files for TABLE_* constants (last resort)
      if (tableNames.length === 0) {
        tableNames = await extractTableNamesFromAllJava(repoPath);
      }

      const dedupeKey = `mafka:${entry.topicName}|${filePath}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      out.push(makeDbusContract(symbolName, filePath, tableNames, 'mafka', {
        topicName: entry.topicName,
        extractionStrategy: 'mafka_properties_scan',
      }));
    }

    // ── Mode B: Thrift DBus Server ──────────────────────────────────────
    const thriftContracts = await extractDbusFromThriftServices(repoPath);
    for (const c of thriftContracts) {
      const dedupeKey = `thrift:${c.contractId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(c);
    }

    return out;
  }
}
