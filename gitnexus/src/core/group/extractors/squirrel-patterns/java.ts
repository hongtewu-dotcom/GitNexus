import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  compilePatterns,
  runCompiledPatterns,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';

/**
 * Squirrel Java source scanner — detects Redis read/write operations by
 * scanning `RedisStoreClient` / `RedisClusterClient` method calls and
 * correlating them with `@Value("${...category...}")` field declarations.
 *
 * Strategy (class-level pragmatic approach):
 * 1. Find all `RedisStoreClient` field declarations → redis client variable names
 * 2. Find all `@Value("${...category...}")` field declarations → category property keys
 * 3. Find all `redisClient.<method>(...)` calls within each class
 * 4. Classify methods as read or write
 * 5. Per class: if only reads → consumer; only writes → provider; both → emit both
 *
 * This gives us directional links: Service A (writer/provider) → Service B (reader/consumer)
 * for the same category, matching the same provider/consumer model as Thrift and Mafka.
 */

export type SquirrelRole = 'provider' | 'consumer';

export interface SquirrelDetection {
  /** Category property key extracted from @Value annotation (e.g. "squirrel.fare.fd.category.name") */
  categoryPropertyKey: string;
  /** Read/write role determined from method analysis */
  role: SquirrelRole;
  /** Source class name */
  className: string;
  /** Source identification */
  source: string;
}

// Redis methods classified as READ operations
const READ_METHODS = new Set([
  'get', 'multiGet', 'mget',
  'hget', 'hgetAll', 'hmget', 'hkeys', 'hvals', 'hexists', 'hlen',
  'lrange', 'lindex', 'llen',
  'smembers', 'sismember', 'scard', 'srandmember',
  'exists', 'ttl', 'pttl', 'type',
  'zrange', 'zrangeByScore', 'zrevrange', 'zrevrangeByScore',
  'zscore', 'zcard', 'zrevrank', 'zrank', 'zcount',
  'strlen', 'getbit', 'bitcount',
]);

// Redis methods classified as WRITE operations
const WRITE_METHODS = new Set([
  'set', 'setnx', 'setex', 'psetex', 'mset', 'multiSet',
  'hset', 'hsetnx', 'hmset', 'hdel', 'hincrBy', 'hincrByFloat',
  'delete', 'del', 'remove', 'expire', 'expireAt', 'pexpire', 'persist',
  'lpush', 'rpush', 'lpop', 'rpop', 'lrem', 'lset', 'ltrim',
  'sadd', 'srem', 'spop',
  'zadd', 'zrem', 'zincrby', 'zremrangeByRank', 'zremrangeByScore',
  'incr', 'incrBy', 'incrByFloat', 'decr', 'decrBy',
  'increase', 'decrease',
  'append', 'setbit', 'setrange',
  'add', // common wrapper method name
]);

// --- Tree-sitter patterns ---

/**
 * Match @Value annotations on fields to extract category property keys.
 * Pattern: @Value("${some.category.name}") private String someCategory;
 */
const VALUE_ANNOTATION_PATTERNS = compilePatterns({
  name: 'java-squirrel-value-annotations',
  language: Java,
  patterns: [
    {
      meta: { type: 'value_annotation' },
      query: `
        (field_declaration
          (modifiers
            (annotation
              name: (identifier) @ann_name (#eq? @ann_name "Value")
              arguments: (annotation_argument_list
                (string_literal) @ann_value)))
          declarator: (variable_declarator
            name: (identifier) @field_name))
      `,
    },
  ],
} satisfies LanguagePatterns<{ type: string }>);

/**
 * Match Redis client method invocations.
 * Pattern: redisClient.method(...)
 */
const REDIS_CALL_PATTERNS = compilePatterns({
  name: 'java-squirrel-redis-calls',
  language: Java,
  patterns: [
    // Direct: redisClient.method(...)
    {
      meta: { type: 'redis_call_direct' },
      query: `
        (method_invocation
          object: (identifier) @receiver
          name: (identifier) @method)
      `,
    },
    // Via this: this.redisClient.method(...)
    {
      meta: { type: 'redis_call_this' },
      query: `
        (method_invocation
          object: (field_access
            object: (this)
            field: (identifier) @receiver)
          name: (identifier) @method)
      `,
    },
  ],
} satisfies LanguagePatterns<{ type: string }>);

/**
 * Match RedisStoreClient / RedisClusterClient field declarations.
 * Used to identify which variable names are Redis clients.
 */
const REDIS_CLIENT_FIELD_PATTERNS = compilePatterns({
  name: 'java-squirrel-redis-client-fields',
  language: Java,
  patterns: [
    {
      meta: { type: 'redis_field' },
      query: `
        (field_declaration
          type: (_) @type
          declarator: (variable_declarator
            name: (identifier) @field_name))
      `,
    },
  ],
} satisfies LanguagePatterns<{ type: string }>);

/**
 * Match class declarations to get class name and body boundaries.
 */
const CLASS_PATTERNS = compilePatterns({
  name: 'java-squirrel-classes',
  language: Java,
  patterns: [
    {
      meta: { type: 'class' },
      query: `
        (class_declaration
          name: (identifier) @class_name
          body: (class_body) @class_body) @class
      `,
    },
  ],
} satisfies LanguagePatterns<{ type: string }>);

// Redis client type names we recognize
const REDIS_CLIENT_TYPES = new Set([
  'RedisStoreClient',
  'RedisClusterClient',
  'StoreClient',
]);

function isRedisClientType(typeText: string): boolean {
  // Handle generic types like RedisStoreClient<String, Object>
  const baseName = typeText.split('<')[0].trim();
  // Handle fully qualified: com.dianping.squirrel.client.impl.redis.RedisStoreClient
  const simpleName = baseName.split('.').pop() ?? baseName;
  return REDIS_CLIENT_TYPES.has(simpleName);
}

// Match category property keys from @Value annotation strings
const CATEGORY_PROPERTY_RE = /\$\{([^}]*category[^}]*)\}/i;

export interface ClassSquirrelInfo {
  className: string;
  /** Property keys referencing categories (e.g. "squirrel.fare.fd.category.name") */
  categoryPropertyKeys: string[];
  hasReads: boolean;
  hasWrites: boolean;
}

/**
 * Scan a Java AST for Squirrel Redis usage patterns.
 * Returns per-class info about which categories are used and in what mode (read/write).
 */
export function scanSquirrelJava(tree: Parser.Tree): ClassSquirrelInfo[] {
  const results: ClassSquirrelInfo[] = [];

  // Step 1: Find all Redis client field names across all classes
  const redisClientFields = new Set<string>();
  for (const match of runCompiledPatterns(REDIS_CLIENT_FIELD_PATTERNS, tree)) {
    const typeNode = match.captures.type;
    const fieldNode = match.captures.field_name;
    if (!typeNode || !fieldNode) continue;
    if (isRedisClientType(typeNode.text)) {
      redisClientFields.add(fieldNode.text);
    }
  }

  // If no redis client fields found, nothing to do
  if (redisClientFields.size === 0) return results;

  // Step 2: Collect all @Value category annotations with their positions
  const allCategoryAnnotations: Array<{ fieldName: string; propKey: string; pos: number }> = [];
  for (const match of runCompiledPatterns(VALUE_ANNOTATION_PATTERNS, tree)) {
    const valueNode = match.captures.ann_value;
    const fieldNode = match.captures.field_name;
    if (!valueNode || !fieldNode) continue;

    const valueText = valueNode.text.replace(/^["']|["']$/g, '');
    const categoryMatch = CATEGORY_PROPERTY_RE.exec(valueText);
    if (categoryMatch) {
      allCategoryAnnotations.push({
        fieldName: fieldNode.text,
        propKey: categoryMatch[1],
        pos: fieldNode.startIndex,
      });
    }
  }

  // Step 3: Collect all redis method calls with their positions
  const allRedisCalls: Array<{ receiver: string; method: string; pos: number }> = [];
  for (const callMatch of runCompiledPatterns(REDIS_CALL_PATTERNS, tree)) {
    const receiverNode = callMatch.captures.receiver;
    const methodNode = callMatch.captures.method;
    if (!receiverNode || !methodNode) continue;
    if (!redisClientFields.has(receiverNode.text)) continue;
    allRedisCalls.push({
      receiver: receiverNode.text,
      method: methodNode.text,
      pos: receiverNode.startIndex,
    });
  }

  // Step 4: Analyze per class
  for (const classMatch of runCompiledPatterns(CLASS_PATTERNS, tree)) {
    const classNameNode = classMatch.captures.class_name;
    const classBodyNode = classMatch.captures.class_body;
    if (!classNameNode || !classBodyNode) continue;

    const className = classNameNode.text;
    const classStart = classBodyNode.startIndex;
    const classEnd = classBodyNode.endIndex;

    // Collect category property keys declared within this class
    const classCategoryKeys: string[] = [];
    for (const ann of allCategoryAnnotations) {
      if (ann.pos >= classStart && ann.pos <= classEnd) {
        classCategoryKeys.push(ann.propKey);
      }
    }

    if (classCategoryKeys.length === 0) continue;

    // Classify redis method calls within this class
    let hasReads = false;
    let hasWrites = false;

    for (const call of allRedisCalls) {
      if (call.pos < classStart || call.pos > classEnd) continue;
      if (READ_METHODS.has(call.method)) hasReads = true;
      if (WRITE_METHODS.has(call.method)) hasWrites = true;
    }

    if (!hasReads && !hasWrites) continue;

    results.push({
      className,
      categoryPropertyKeys: [...new Set(classCategoryKeys)],
      hasReads,
      hasWrites,
    });
  }

  return results;
}

/**
 * Convert class-level scan results into role-annotated detections.
 * A class that only reads → consumer; only writes → provider; both → emit both roles.
 */
export function classInfoToDetections(infos: ClassSquirrelInfo[]): SquirrelDetection[] {
  const out: SquirrelDetection[] = [];

  for (const info of infos) {
    for (const propKey of info.categoryPropertyKeys) {
      if (info.hasWrites) {
        out.push({
          categoryPropertyKey: propKey,
          role: 'provider',
          className: info.className,
          source: 'java_squirrel_writer',
        });
      }
      if (info.hasReads) {
        out.push({
          categoryPropertyKey: propKey,
          role: 'consumer',
          className: info.className,
          source: 'java_squirrel_reader',
        });
      }
    }
  }

  return out;
}

export const SQUIRREL_JAVA_LANGUAGE = Java;
