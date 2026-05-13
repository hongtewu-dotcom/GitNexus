import type { StoredContract } from './types.js';

/**
 * Configuration for contract noise filtering.
 * All options have sensible defaults to ensure backward compatibility.
 */
export interface FilterOptions {
  /** Filter Thrift framework base services (e.g. FacebookService). Default: true */
  excludeFrameworkServices?: boolean;
  /** Filter generic Spring framework interfaces. Default: true */
  excludeGenericSpringInterfaces?: boolean;
  /** Deduplicate same contractId+role+repo combinations, keeping highest confidence. Default: true */
  deduplicateContracts?: boolean;
  /** Custom contractId prefixes to exclude */
  excludeContractPrefixes?: string[];
}

/**
 * Generic Spring interfaces that produce noise when detected as contracts.
 * These are ubiquitous framework interfaces that every bean may implement,
 * generating N×M false cross-links.
 */
const GENERIC_SPRING_INTERFACES: ReadonlySet<string> = new Set([
  'InitializingBean',
  'DisposableBean',
  'ApplicationContextAware',
  'BeanFactoryAware',
  'Serializable',
  'Cloneable',
  'Comparable',
  'Runnable',
  'Callable',
  'ModelMapper',
  'ObjectMapper',
  'IProducerProcessor',
  'IApi',
  'ITaskHandler',
  'CommandLineRunner',
  'ApplicationRunner',
  'Ordered',
  'PriorityOrdered',
]);

const SPRING_BEAN_PREFIX = 'custom::spring-bean::';

const DEFAULT_OPTIONS: Required<FilterOptions> = {
  excludeFrameworkServices: true,
  excludeGenericSpringInterfaces: true,
  deduplicateContracts: true,
  excludeContractPrefixes: [],
};

/**
 * Filters noise from extracted contracts before matching.
 *
 * Applies three layers of cleaning:
 * 1. Framework service blacklist (FacebookService in thrift/grpc)
 * 2. Generic Spring interface blacklist (ubiquitous beans)
 * 3. Deduplication by contractId+role+repo (keep highest confidence)
 *
 * Plus optional custom prefix exclusion.
 */
export function filterContracts(
  contracts: StoredContract[],
  options?: FilterOptions,
): StoredContract[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let result = contracts;

  if (opts.excludeFrameworkServices) {
    result = result.filter((c) => !isFrameworkService(c));
  }

  if (opts.excludeGenericSpringInterfaces) {
    result = result.filter((c) => !isGenericSpringInterface(c));
  }

  if (opts.excludeContractPrefixes.length > 0) {
    result = result.filter(
      (c) => !opts.excludeContractPrefixes.some((prefix) => c.contractId.startsWith(prefix)),
    );
  }

  if (opts.deduplicateContracts) {
    result = deduplicateByKey(result);
  }

  return result;
}

/**
 * Returns true if the contract is a Thrift/gRPC framework base service
 * (e.g. FacebookService which every Thrift IDL inherits).
 */
function isFrameworkService(c: StoredContract): boolean {
  if (c.type !== 'thrift' && c.type !== 'grpc') return false;
  return c.contractId.includes('FacebookService');
}

/**
 * Returns true if the contract is a generic Spring bean interface
 * that produces noise cross-links.
 */
function isGenericSpringInterface(c: StoredContract): boolean {
  if (!c.contractId.startsWith(SPRING_BEAN_PREFIX)) return false;
  const beanName = c.contractId.slice(SPRING_BEAN_PREFIX.length);
  return GENERIC_SPRING_INTERFACES.has(beanName);
}

/**
 * Deduplicates contracts by (contractId, role, repo), keeping only the
 * entry with the highest confidence for each unique combination.
 */
function deduplicateByKey(contracts: StoredContract[]): StoredContract[] {
  const best = new Map<string, StoredContract>();

  for (const c of contracts) {
    const key = `${c.contractId}\x00${c.role}\x00${c.repo}\x00${c.symbolRef.filePath}`;
    const existing = best.get(key);
    if (!existing || c.confidence > existing.confidence) {
      best.set(key, c);
    }
  }

  return Array.from(best.values());
}
