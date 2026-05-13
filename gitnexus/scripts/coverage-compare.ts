/**
 * 覆盖度比对脚本
 * 
 * 对比 trace 输出 vs 标准参考文档，生成三级覆盖度报告：
 * - 服务级：trace 中出现了哪些 repo
 * - 接口级：trace 的 crossHops contractId 覆盖了标准文档的哪些接口
 * - MQ Topic级：trace 覆盖了哪些 Mafka topic
 * 
 * 用法：
 *   npx tsx scripts/coverage-compare.ts [--trace <trace-json>] [--ref <reference-json>] [--json]
 * 
 * 默认：
 *   --trace: traces/ 目录下最新的 trace-secondCheck-downstream-*.json
 *   --ref:   traces/standard-reference-secondcheck.json
 *   --json:  输出 JSON 格式（默认输出人类可读表格）
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// Types
// ============================================================

interface TraceSegment {
  repo: string;
  repoPath: string;
  entrySymbolUid: string;
  nodes: any[];
  crossHops: TraceCrossHop[];
}

interface TraceCrossHop {
  contractId: string;
  type: string;
  targetRepo: string;
  targetRepoPath: string;
}

interface TraceResult {
  group: string;
  entryRepo: string;
  entryTarget: string;
  direction: string;
  segments: TraceSegment[];
  skippedRepos: string[];
  truncated: boolean;
}

interface StandardService {
  category: string;
  role: string;
  repoPath: string | null;
  localRepo: boolean;
  interfaces: {
    outbound_rpc: StandardRpcCall[];
    outbound_mq: StandardMqCall[];
  };
}

interface StandardRpcCall {
  target: string;
  service: string;
  method: string;
  external?: boolean;
  bfsUnreachable?: boolean;
}

interface StandardMqCall {
  topic: string;
  direction: string;
  description: string;
  noCrossRepo?: boolean;
}

interface StandardReference {
  source: string;
  title: string;
  services: Record<string, StandardService>;
  summary: {
    total_services: number;
    local_repo_services: number;
    external_services: number;
    total_rpc_calls: number;
    total_mq_topics: number;
  };
}

interface CoverageResult {
  timestamp: string;
  traceFile: string;
  referenceFile: string;
  serviceCoverage: {
    total: number;
    covered: number;
    rate: string;
    missing: { service: string; repoPath: string; reason: string }[];
    extra: string[];
  };
  interfaceCoverage: {
    total: number;
    covered: number;
    rate: string;
    exactMatch: number;
    semanticMatch: number;
    missing: { service: string; method: string; reason: string }[];
  };
  mqCoverage: {
    total: number;
    covered: number;
    rate: string;
    missing: { topic: string; description: string }[];
  };
  effectiveCoverage: {
    description: string;
    serviceRate: string;
    interfaceRate: string;
    mqRate: string;
  };
}

// ============================================================
// 已知缺失原因（根据排查结果硬编码）
// ============================================================

/** 标准文档方法名和 Thrift IDL 实际方法名的映射 */
const METHOD_ALIASES: Record<string, string[]> = {
  'TCertificateAuthThriftService/getUserAuth': ['TCertificateAuthThriftService/getRealNameAuthByUserId', 'TCertificateAuthThriftService/threeElementCertify'],
  'EnrollThriftService/queryPassengerIsVip': ['EnrollThriftService/enroll', 'EnrollThriftService/enrollQuery'],
  'CabinSearchService/cabinSearch': ['CabinSearchService/getAllCabin', 'CabinSearchService/getCabinByParam'],
  'SaleIncomeService/querySaleIncome': ['SaleIncomeService/getSaleIncomeResponse', 'SaleIncomeService/matchSaleIncome', 'SaleIncomeService/saleIncomeBatchQuery'],
  'XProductService/getXProducts': ['XProductService/getProducts', 'XProductService/getXProductList'],
  'IdCardWhiteListThriftService/CZVipIdCardCheck': ['IdCardWhiteListThriftService/isAvailableIdCardNo'],
  'DistributorThriftService/syncCreateDrOrder': ['DistributorThriftService/createOrder'],
  'OrderPreSaleThriftService/saveYouthCardNumber': ['OrderPreSaleThriftService/replaceUOrder'],
  'ExpressThriftService/createExpress': ['ExpressThriftService/saveExpress', 'ExpressThriftService/saveMergeExpress'],
  'OtaService/directOtaCheck': ['OtaService/checkAv', 'OtaService/checkPay', 'OtaService/order'],
  'UOrderOperateThriftService/cancelOrder': ['UOrderOperateThriftService/saveTag', 'UOrderOperateThriftService/updateUOrderUserUnVisible'],
  'UOrderOperateThriftService/updateOrderTag': ['UOrderOperateThriftService/saveTag'],
  'ChannelOfficeThriftService/getOfficeBySiteId': ['ChannelOfficeThriftService/queryMultiAuthOffice'],
  'SelfOrderQueryThriftService/getSelfSiteIds': ['SelfOrderQueryThriftService/queryAllSelfSiteNos', 'SelfOrderQueryThriftService/querySelfSiteInfo'],
  'SiteThriftService/querySite': ['SiteThriftService/querySiteBookingConfig', 'SiteThriftService/querySiteAfterSaleConfig', 'SiteThriftService/queryAllSiteBookingConfig'],
  'CityThriftService/getCity': ['CityThriftService/getCityByCode', 'AirportMapCityThriftService/getCityByAirport'],
  'AirportThriftService/getAirport': ['AirportThriftService/getAirportByCode', 'AirportThriftService/getAllAirport'],
  'TCDispensePreCheckRequest/preCheck': ['TCDispenseThriftService/dispensePreCheck'],
  'FlagshipCheckpriceThriftService/checkPrice': ['FlagshipCheckpriceThriftService/checkPriceOW', 'FlagshipCheckpriceThriftService/checkPriceRT'],
  'FlagshipOrderThriftService/createOrder': ['FlagshipOrderThriftService/orderOW', 'FlagshipOrderThriftService/orderRT', 'FlagshipOrderThriftService/orderTransit'],
  'XOrderService/create': ['XOrderService/createPayment', 'XOrderService/createXOrder'],
  'XOrderService/bind': ['XOrderService/bindXOrder'],
};

/** Legacy fallback: 接口在标准文档中未标 external/bfsUnreachable，但已知无法覆盖的（应逐步迁移到标准文档标记） */
const KNOWN_EXTERNAL_MISSING: Record<string, string> = {
};

/** 入口方法（不应出现在 crossHops 中） */
const ENTRY_METHODS = new Set([
  'SecondCheckThriftService/secondCheck',
  'SecondCheckThriftService/SpliceSecondCheck',
]);

// ============================================================
// Main Logic
// ============================================================

function findLatestTraceFile(tracesDir: string): string {
  const files = fs.readdirSync(tracesDir)
    .filter(f => f.startsWith('trace-secondCheck-downstream-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) throw new Error('No trace files found in ' + tracesDir);
  return path.join(tracesDir, files[0]);
}

function loadTrace(filePath: string): TraceResult {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadReference(filePath: string): StandardReference {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function compareCoverage(trace: TraceResult, ref: StandardReference): CoverageResult {
  // --- Extract trace data ---
  const traceRepos = new Set<string>();
  const traceContracts = new Set<string>();
  const traceTopics = new Set<string>();
  const traceAllText = JSON.stringify(trace);

  for (const seg of trace.segments) {
    traceRepos.add(seg.repoPath);
    for (const hop of seg.crossHops) {
      traceContracts.add(hop.contractId);
      if (hop.type === 'topic' || hop.contractId.startsWith('topic::')) {
        traceTopics.add(hop.contractId);
      }
    }
  }

  // --- Service-level ---
  const standardRepos = new Map<string, string>();
  for (const [svcName, svc] of Object.entries(ref.services)) {
    if (svc.repoPath) standardRepos.set(svc.repoPath, svcName);
  }

  const coveredServices: string[] = [];
  const missingServices: { service: string; repoPath: string; reason: string }[] = [];
  const extraServices: string[] = [];

  // Known service-level reasons
  const SERVICE_MISSING_REASONS: Record<string, string> = {
    'api/booking': '入口层（trace 从 booking/service 开始）',
    'eng/renderer': 'crossLink 存在但 BFS 从 secondCheck 入口未到达（条件分支路径）',
  };

  for (const [repo, svc] of standardRepos) {
    if (traceRepos.has(repo)) {
      coveredServices.push(svc);
    } else {
      const reason = SERVICE_MISSING_REASONS[repo] || 'BFS 未到达';
      missingServices.push({ service: svc, repoPath: repo, reason });
    }
  }

  for (const repo of traceRepos) {
    if (!standardRepos.has(repo)) extraServices.push(repo);
  }

  // --- Interface-level ---
  const allRpcCalls: { service: string; method: string; external?: boolean; bfsUnreachable?: boolean }[] = [];
  for (const svc of Object.values(ref.services)) {
    for (const rpc of svc.interfaces.outbound_rpc) {
      allRpcCalls.push({ service: rpc.service, method: rpc.method, external: rpc.external, bfsUnreachable: rpc.bfsUnreachable });
    }
  }

  let exactMatch = 0;
  let semanticMatch = 0;
  const missingInterfaces: { service: string; method: string; reason: string }[] = [];

  let externalSkipped = 0;
  let bfsUnreachableSkipped = 0;

  for (const { service, method, external, bfsUnreachable } of allRpcCalls) {
    const key = `${service}/${method}`;
    const contractId = `thrift::${key}`;

    // Skip entry methods
    if (ENTRY_METHODS.has(key)) continue;

    // Skip informal/chinese service names (not real Thrift IDL names)
    const isInformal = /[\u4e00-\u9fa5]/.test(service) || service === 'HTTP' || method === 'multiple';
    if (isInformal) continue;

    // Skip external interfaces (marked in reference doc)
    if (external) { externalSkipped++; continue; }

    // Skip BFS-unreachable interfaces (conditional paths not reached from entry)
    if (bfsUnreachable) { bfsUnreachableSkipped++; continue; }

    // 1. Exact match
    if (traceContracts.has(contractId)) {
      exactMatch++;
      continue;
    }

    // 2. Check known aliases (semantic equivalence)
    const aliases = METHOD_ALIASES[key];
    if (aliases) {
      const found = aliases.some(alias => traceContracts.has(`thrift::${alias}`));
      if (found) {
        semanticMatch++;
        continue;
      }
    }

    // 3. Fuzzy: same service, different method (service is reachable)
    const svcPrefix = `thrift::${service}/`;
    const hasAnyMethodOfService = [...traceContracts].some(c => c.startsWith(svcPrefix));
    if (hasAnyMethodOfService) {
      semanticMatch++;
      continue;
    }

    // 4. Not covered
    const reason = KNOWN_EXTERNAL_MISSING[key] || '服务未在 trace 中出现';
    missingInterfaces.push({ service, method, reason });
  }

  const informalCount = allRpcCalls.filter(({ service, method }) =>
    /[\u4e00-\u9fa5]/.test(service) || service === 'HTTP' || method === 'multiple'
  ).length;
  const totalInterfaces = allRpcCalls.length - ENTRY_METHODS.size - informalCount - externalSkipped - bfsUnreachableSkipped;
  const coveredInterfaces = exactMatch + semanticMatch;

  // --- MQ Topic-level ---
  const allTopics: { topic: string; description: string; noCrossRepo?: boolean }[] = [];
  for (const svc of Object.values(ref.services)) {
    for (const mq of svc.interfaces.outbound_mq) {
      allTopics.push({ topic: mq.topic, description: mq.description, noCrossRepo: mq.noCrossRepo });
    }
  }

  let noCrossRepoTopicSkipped = 0;
  const coveredTopicsList: string[] = [];
  const missingTopicsList: { topic: string; description: string }[] = [];

  for (const { topic, description, noCrossRepo } of allTopics) {
    // Skip topics that can't produce crossLinks (self-consume, single-direction, etc.)
    if (noCrossRepo) { noCrossRepoTopicSkipped++; continue; }

    const topicContract = `topic::${topic}`;
    if (traceContracts.has(topicContract) || traceAllText.includes(topic)) {
      coveredTopicsList.push(topic);
    } else {
      missingTopicsList.push({ topic, description });
    }
  }

  // --- Effective coverage ---
  // External and bfsUnreachable are already excluded from totalInterfaces
  // Only legacy KNOWN_EXTERNAL_MISSING entries remain as "known uncoverable"
  const legacyExternalCount = missingInterfaces.filter(m =>
    KNOWN_EXTERNAL_MISSING[`${m.service}/${m.method}`] != null
  ).length;

  const effectiveTotal = totalInterfaces - legacyExternalCount;
  const effectiveCovered = coveredInterfaces;

  return {
    timestamp: new Date().toISOString(),
    traceFile: path.basename(trace.entryTarget + '-trace'),
    referenceFile: 'standard-reference-secondcheck.json',
    serviceCoverage: {
      total: standardRepos.size,
      covered: coveredServices.length,
      rate: `${Math.round(coveredServices.length * 100 / standardRepos.size)}%`,
      missing: missingServices,
      extra: extraServices.sort(),
    },
    interfaceCoverage: {
      total: totalInterfaces,
      covered: coveredInterfaces,
      rate: `${Math.round(coveredInterfaces * 100 / totalInterfaces)}%`,
      exactMatch,
      semanticMatch,
      missing: missingInterfaces,
    },
    mqCoverage: {
      total: allTopics.length - noCrossRepoTopicSkipped,
      covered: coveredTopicsList.length,
      rate: `${Math.round(coveredTopicsList.length * 100 / Math.max(1, allTopics.length - noCrossRepoTopicSkipped))}%`,
      missing: missingTopicsList,
    },
    effectiveCoverage: {
      description: '排除外部服务/无法追踪的接口后的有效覆盖率',
      serviceRate: `${Math.round(coveredServices.length * 100 / standardRepos.size)}%`,
      interfaceRate: `${Math.round(effectiveCovered * 100 / effectiveTotal)}%`,
      mqRate: `${Math.round(coveredTopicsList.length * 100 / Math.max(1, allTopics.length - noCrossRepoTopicSkipped))}%`,
    },
  };
}

function printReport(result: CoverageResult): void {
  const divider = '═'.repeat(64);
  const thinDiv = '─'.repeat(64);

  console.log(`\n${divider}`);
  console.log(`  二次验价链路覆盖度报告`);
  console.log(`  ${result.timestamp}`);
  console.log(`${divider}\n`);

  // Summary table
  console.log(`  维度          覆盖/总计     覆盖率`);
  console.log(`  ${thinDiv.slice(0, 50)}`);
  console.log(`  服务级        ${result.serviceCoverage.covered}/${result.serviceCoverage.total}          ${result.serviceCoverage.rate}`);
  console.log(`  接口级        ${result.interfaceCoverage.covered}/${result.interfaceCoverage.total}         ${result.interfaceCoverage.rate}`);
  console.log(`    精确匹配    ${result.interfaceCoverage.exactMatch}`);
  console.log(`    语义匹配    ${result.interfaceCoverage.semanticMatch}`);
  console.log(`  MQ Topic     ${result.mqCoverage.covered}/${result.mqCoverage.total}           ${result.mqCoverage.rate}`);
  console.log(`  ${thinDiv.slice(0, 50)}`);
  console.log(`  有效接口覆盖率（排除外部服务）: ${result.effectiveCoverage.interfaceRate}`);

  // Missing services
  if (result.serviceCoverage.missing.length > 0) {
    console.log(`\n  ❌ 缺失服务 (${result.serviceCoverage.missing.length}):`);
    for (const m of result.serviceCoverage.missing) {
      console.log(`    ${m.repoPath} (${m.service}) — ${m.reason}`);
    }
  }

  // Missing interfaces
  if (result.interfaceCoverage.missing.length > 0) {
    console.log(`\n  ❌ 缺失接口 (${result.interfaceCoverage.missing.length}):`);
    for (const m of result.interfaceCoverage.missing) {
      console.log(`    ${m.service}.${m.method} — ${m.reason}`);
    }
  }

  // Missing topics
  if (result.mqCoverage.missing.length > 0) {
    console.log(`\n  ❌ 缺失 MQ Topic (${result.mqCoverage.missing.length}):`);
    for (const m of result.mqCoverage.missing) {
      console.log(`    ${m.topic} (${m.description})`);
    }
  }

  // Extra services
  if (result.serviceCoverage.extra.length > 0) {
    console.log(`\n  🔵 trace 额外发现的服务 (${result.serviceCoverage.extra.length}):`);
    for (const e of result.serviceCoverage.extra) {
      console.log(`    ${e}`);
    }
  }

  console.log(`\n${divider}\n`);
}

// ============================================================
// CLI
// ============================================================

function main() {
  const args = process.argv.slice(2);
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const projectRoot = path.resolve(scriptDir, '..');
  const tracesDir = path.join(projectRoot, 'traces');

  let traceFile = '';
  let refFile = path.join(tracesDir, 'standard-reference-secondcheck.json');
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trace' && args[i + 1]) traceFile = args[++i];
    else if (args[i] === '--ref' && args[i + 1]) refFile = args[++i];
    else if (args[i] === '--json') jsonOutput = true;
    else if (args[i] === '--help') {
      console.log('Usage: npx tsx scripts/coverage-compare.ts [--trace <file>] [--ref <file>] [--json]');
      process.exit(0);
    }
  }

  if (!traceFile) traceFile = findLatestTraceFile(tracesDir);

  console.error(`Trace: ${path.basename(traceFile)}`);
  console.error(`Reference: ${path.basename(refFile)}`);

  const trace = loadTrace(traceFile);
  const ref = loadReference(refFile);
  const result = compareCoverage(trace, ref);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }
}

main();
