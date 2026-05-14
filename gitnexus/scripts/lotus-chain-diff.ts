#!/usr/bin/env npx tsx
/**
 * Lotus Chain-Level Diff Tool
 *
 * 使用 Lotus physical-combined 完整链路数据（lotus-chain-*.json）
 * 与 gitnexus crossLinks 做深层调用链比对。
 *
 * 核心逻辑：
 * 1. 从 Lotus chain nodes 提取所有 appkey→method 调用
 * 2. 将 appkey 映射到 gitnexus repo
 * 3. 从 crossLinks 中查找是否覆盖了 Lotus 记录的每个方法调用
 *
 * 用法:
 *   npx tsx scripts/lotus-chain-diff.ts
 *   npx tsx scripts/lotus-chain-diff.ts --chain scripts/fixtures/lotus-chain-616312.json
 *   npx tsx scripts/lotus-chain-diff.ts --all          # 比对所有 lotus-chain-*.json
 *   npx tsx scripts/lotus-chain-diff.ts --summary      # 仅输出汇总
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ 配置 ============
const GROUP_DIR = path.join(process.env.HOME!, '.gitnexus/groups/flight-all');
const CONTRACTS_FILE = path.join(GROUP_DIR, 'contracts.json');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

// ============ Appkey → Repo 映射 ============
// 从 group.yaml repos 反推 + Lotus 常见 appkey 补充
const APPKEY_TO_REPO: Record<string, string> = {
  // API 层
  'com.sankuai.flight.api.booking': 'api/booking',
  'com.sankuai.flight.api.apitrade': 'api/trade',
  'com.sankuai.flight.api.quote': 'api/quote',
  'com.sankuai.flight.api.common': 'api/common',
  'com.sankuai.flight.api.homepage': 'api/homepage',
  'com.sankuai.flight.api.gateway': 'api/gateway',
  // 预订
  'com.sankuai.flight.booking.service': 'booking/service',
  'com.sankuai.flight.booking.support': 'booking/support',
  'com.sankuai.flight.booking.ota': 'booking/ota',
  'com.sankuai.flight.booking.analysis': 'booking/analysis',
  'com.sankuai.flight.booking.skill': 'booking/skill',
  // 订单
  'com.sankuai.flight.order.core': 'order/core',
  'com.sankuai.flight.order.ticketing': 'order/ticketing',
  'com.sankuai.flight.order.customer': 'order/customer',
  'com.sankuai.flight.order.mproxy': 'order/mproxy',
  'com.sankuai.flight.order.search': 'order/search',
  'com.sankuai.flight.order.ticketrisk': 'order/ticketrisk',
  'com.sankuai.flight.order.datamining': 'order/datamining',
  // 售后
  'com.sankuai.flight.aftersale.refundmoney': 'aftersale/refundmoney',
  'com.sankuai.flight.aftersale.returncenter': 'aftersale/returncenter',
  'com.sankuai.flight.aftersale.changing': 'aftersale/changing',
  'com.sankuai.flight.aftersale.clearingcenter': 'aftersale/clearingcenter',
  'com.sankuai.flight.aftersale.express': 'aftersale/express',
  'com.sankuai.flight.aftersale.devops': 'aftersale/devops',
  // 交易
  'com.sankuai.flight.biz.xorder': 'trade/order',
  'com.sankuai.flight.trade.xorder': 'trade/order',
  'com.sankuai.flight.quote.xproduct': 'trade/product',
  'com.sankuai.flight.trade.xproduct': 'trade/product',
  'com.sankuai.flight.trade.claim': 'trade/claim',
  // 报价
  'com.sankuai.flight.quote.qos': 'quote/qos',
  'com.sankuai.flight.quote.policy': 'quote/policy',
  'com.sankuai.flight.quote.specialoffer': 'quote/reaching',
  'com.sankuai.flight.quote.reaching': 'quote/reaching',
  'com.sankuai.flight.quote.msgreach': 'quote/msgreach',
  // 基础
  'com.sankuai.flight.basis.staticdata': 'basis/staticdata',
  'com.sankuai.flight.basis.mterm': 'basis/mterm',
  'com.sankuai.flight.basis.malone': 'basis/malone',
  'com.sankuai.flight.basis.fare': 'basis/fare',
  'com.sankuai.flight.basis.avdc': 'basis/avdc',
  'com.sankuai.flight.basis.ei': 'basis/ei',
  'com.sankuai.flight.basis.sk': 'basis/sk',
  'com.sankuai.flight.basis.airchange': 'basis/airchange',
  'com.sankuai.flight.basis.avcalculate': 'basis/avcalculate',
  'com.sankuai.flight.basis.bindings': 'basis/bindings',
  'com.sankuai.flight.basis.checkin': 'basis/checkin',
  'com.sankuai.flight.basis.eterm': 'basis/eterm-proxy',
  'com.sankuai.flight.basis.ibeplus': 'basis/ibeplus',
  'com.sankuai.flight.basis.pricecompare': 'basis/pricecompare',
  'com.sankuai.flight.basis.sgui': 'basis/sgui',
  'com.sankuai.flight.basis.simpool': 'basis/simpool',
  'com.sankuai.flight.basis.ticketvalidate': 'basis/ticketvalidate',
  'com.sankuai.flight.basis.tracker': 'basis/tracker',
  // 商户
  'com.sankuai.flight.merchant.center': 'merchant/center',
  'com.sankuai.flight.merchant.claw': 'merchant/claw',
  'com.sankuai.flight.merchant.ecm': 'merchant/ecm',
  'com.sankuai.flight.biz.merchant': 'merchant/center',
  'com.sankuai.flight.biz.distribution': 'merchant/distribution',
  // 业务
  'com.sankuai.flight.biz.assembler': 'biz/assembler',
  'com.sankuai.flight.biz.ebook': 'business/ebook',
  'com.sankuai.flight.biz.international': 'biz/international',
  'com.sankuai.flight.biz.operation': 'biz/operation',
  'com.sankuai.flight.biz.fundsafemgr': 'biz/fundsafemgr',
  'com.sankuai.flight.biz.devepayfetch': 'biz/devepayfetch',
  // 旗舰
  'com.sankuai.flight.flagship.api': 'flagship/api',
  'com.sankuai.flight.flagship.biz': 'flagship/biz',
  'com.sankuai.flight.flagship.fare': 'flagship/fare',
  'com.sankuai.flight.flagship.business': 'flagship/business',
  // 国际
  'com.sankuai.flighttrade.international': 'biz/international',
  // 金蝉/利润
  'com.sankuai.flight.business.jinchan': 'business/jinchan',
  'com.sankuai.flight.business.profit': 'business/profit',
};

// ============ 数据结构 ============
interface LotusChainNode {
  depth: number;
  appkey: string;
  priority: string;
  method: string;
  type: string;
  amplification: number;
  dependency: string;
}

interface LotusChainFile {
  logicTraceId: number;
  traceName: string;
  viewId: number;
  totalNodes: number;
  nodes: LotusChainNode[];
}

interface CrossLink {
  from: { repo: string; service: string; symbolUid: string; symbolRef: { filePath: string; name: string } };
  to: { repo: string; service: string; symbolUid: string; symbolRef: { filePath: string; name: string } };
  type: string;
  contractId: string;
  matchType: string;
  confidence: number;
}

interface MethodCall {
  appkey: string;
  repo: string | null;
  method: string;  // ServiceName.methodName
  type: string;    // mtthrift / http
  serviceName: string;
  methodName: string;
}

interface ChainDiffResult {
  traceName: string;
  logicTraceId: number;
  totalNodes: number;
  totalMethods: number;        // 去重后的唯一方法调用
  internalMethods: number;     // 映射到 flight-all 内部 repo 的
  externalMethods: number;     // 无法映射的外部服务
  coveredMethods: number;      // 被 crossLinks 覆盖的
  missingMethods: MethodCall[];  // 未覆盖的
  coverageRate: number;        // coveredMethods / internalMethods
}

// ============ 加载 crossLinks ============
function loadCrossLinks(): CrossLink[] {
  console.log('📦 Loading crossLinks from contracts.json...');
  const content = fs.readFileSync(CONTRACTS_FILE, 'utf-8');
  const data = JSON.parse(content);
  const crossLinks: CrossLink[] = data.crossLinks || [];
  console.log(`  ✅ Loaded ${crossLinks.length} crossLinks`);
  return crossLinks;
}

// ============ 构建 crossLinks 索引 ============
interface CrossLinkIndex {
  // key: "targetRepo::ServiceName/methodName" → crossLinks[]
  byTargetMethod: Map<string, CrossLink[]>;
  // key: "targetRepo::ServiceName" → crossLinks[]
  byTargetService: Map<string, CrossLink[]>;
  // key: "targetRepo" → crossLinks[]
  byTargetRepo: Map<string, CrossLink[]>;
}

function buildCrossLinkIndex(crossLinks: CrossLink[]): CrossLinkIndex {
  const index: CrossLinkIndex = {
    byTargetMethod: new Map(),
    byTargetService: new Map(),
    byTargetRepo: new Map(),
  };

  for (const cl of crossLinks) {
    const targetRepo = cl.to.repo;

    // byTargetRepo
    const repoList = index.byTargetRepo.get(targetRepo) || [];
    repoList.push(cl);
    index.byTargetRepo.set(targetRepo, repoList);

    // 从 contractId 提取 service/method
    // 格式: "thrift::ServiceName/methodName" 或 "http::GET::/trade/getunionordersv2/..."
    const contractId = cl.contractId;
    if (contractId.startsWith('thrift::')) {
      const svcMethod = contractId.replace('thrift::', '');
      // byTargetMethod: "targetRepo::ServiceName/methodName"
      const methodKey = `${targetRepo}::${svcMethod}`.toLowerCase();
      const mList = index.byTargetMethod.get(methodKey) || [];
      mList.push(cl);
      index.byTargetMethod.set(methodKey, mList);

      // byTargetService: "targetRepo::ServiceName"
      const slashIdx = svcMethod.indexOf('/');
      if (slashIdx > 0) {
        const svcName = svcMethod.substring(0, slashIdx);
        // 可能是全限定名或简名，都存
        const svcKey = `${targetRepo}::${svcName}`.toLowerCase();
        const sList = index.byTargetService.get(svcKey) || [];
        sList.push(cl);
        index.byTargetService.set(svcKey, sList);

        // 也存简名（去掉包名）
        const simpleSvcName = svcName.split('.').pop()!;
        const simpleSvcKey = `${targetRepo}::${simpleSvcName}`.toLowerCase();
        if (simpleSvcKey !== svcKey) {
          const sList2 = index.byTargetService.get(simpleSvcKey) || [];
          sList2.push(cl);
          index.byTargetService.set(simpleSvcKey, sList2);
        }
      }
    } else if (contractId.startsWith('http::')) {
      // contractId 格式: "http::GET::/trade/getunionordersv2/insideyear"
      // 提取 path（第三段），全小写存入 byTargetMethod
      const parts = contractId.split('::');
      if (parts.length >= 3) {
        const httpPath = parts.slice(2).join('::').toLowerCase();
        const pathKey = `${targetRepo}::${httpPath}`;
        const mList = index.byTargetMethod.get(pathKey) || [];
        mList.push(cl);
        index.byTargetMethod.set(pathKey, mList);
      }
    }
  }

  return index;
}

// ============ 解析 Lotus 链路中的方法调用 ============
function extractMethodCalls(chain: LotusChainFile): MethodCall[] {
  const seen = new Set<string>();
  const calls: MethodCall[] = [];

  for (const node of chain.nodes) {
    if (node.appkey === 'merge.appkey' || !node.appkey || !node.method) continue;
    if (node.method === 'merge.methodName') continue;

    const key = `${node.appkey}::${node.method}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const repo = APPKEY_TO_REPO[node.appkey] || null;

    let serviceName: string;
    let methodName: string;
    if (node.type === 'http') {
      // HTTP 节点 method 是 path 形式（如 /trade/getUnionOrdersV2/insideyear），不含 .
      serviceName = node.method;
      methodName = node.method;
    } else {
      // Thrift 节点: "ServiceName.methodName"
      const dotIdx = node.method.lastIndexOf('.');
      serviceName = dotIdx > 0 ? node.method.substring(0, dotIdx) : node.method;
      methodName = dotIdx > 0 ? node.method.substring(dotIdx + 1) : node.method;
    }

    calls.push({
      appkey: node.appkey,
      repo,
      method: node.method,
      type: node.type,
      serviceName,
      methodName,
    });
  }

  return calls;
}

// ============ 匹配方法调用与 crossLinks ============
function matchMethodCall(call: MethodCall, index: CrossLinkIndex): boolean {
  if (!call.repo) return false;

  // HTTP 节点：method 是 path，toLowerCase 后与索引的 http path 匹配
  if (call.type === 'http') {
    const pathKey = `${call.repo}::${call.method.toLowerCase()}`;
    if (index.byTargetMethod.has(pathKey)) return true;
    // 也尝试去掉开头斜杠
    const pathKeyNoSlash = `${call.repo}::${call.method.toLowerCase().replace(/^\//, '')}`;
    if (index.byTargetMethod.has(pathKeyNoSlash)) return true;
    return false;
  }

  // 策略1: 精确匹配 "repo::ServiceName/methodName"
  const exactKey = `${call.repo}::${call.serviceName}/${call.methodName}`.toLowerCase();
  if (index.byTargetMethod.has(exactKey)) return true;

  // 策略2: 简名匹配（Lotus 可能用简名，gitnexus 用全限定名）
  // 比如 Lotus: "UOrderQueryThriftService.getUOrderDetail"
  // gitnexus: "com.meituan.flight.order.core.client.query.service.UOrderQueryThriftService/getUOrderDetail"
  const simpleName = call.serviceName.split('.').pop()!;
  const simpleKey = `${call.repo}::${simpleName}/${call.methodName}`.toLowerCase();
  if (index.byTargetMethod.has(simpleKey)) return true;

  // 策略3: 遍历 byTargetMethod 查找尾部匹配
  const targetSuffix = `${simpleName}/${call.methodName}`.toLowerCase();
  for (const [key] of index.byTargetMethod) {
    if (key.startsWith(`${call.repo}::`) && key.endsWith(targetSuffix)) {
      return true;
    }
  }

  // 策略4: Service 级匹配（至少 gitnexus 追踪了该 Service 的某些方法）
  const svcKey = `${call.repo}::${simpleName}`.toLowerCase();
  if (index.byTargetService.has(svcKey)) return true;

  return false;
}

// ============ 对单条链路做比对 ============
function diffChain(chain: LotusChainFile, index: CrossLinkIndex): ChainDiffResult {
  const calls = extractMethodCalls(chain);
  const internalCalls = calls.filter(c => c.repo !== null);
  const externalCalls = calls.filter(c => c.repo === null);

  const coveredCalls: MethodCall[] = [];
  const missingCalls: MethodCall[] = [];

  for (const call of internalCalls) {
    if (matchMethodCall(call, index)) {
      coveredCalls.push(call);
    } else {
      missingCalls.push(call);
    }
  }

  return {
    traceName: chain.traceName,
    logicTraceId: chain.logicTraceId,
    totalNodes: chain.totalNodes,
    totalMethods: calls.length,
    internalMethods: internalCalls.length,
    externalMethods: externalCalls.length,
    coveredMethods: coveredCalls.length,
    missingMethods: missingCalls,
    coverageRate: internalCalls.length > 0
      ? coveredCalls.length / internalCalls.length
      : 0,
  };
}

// ============ 输出报告 ============
function printReport(results: ChainDiffResult[], summaryOnly: boolean, chainFiles: string[]): void {
  console.log('\n' + '═'.repeat(80));
  console.log('  🔗 Lotus Chain-Level Coverage Report');
  console.log('  Comparing Lotus physical-combined chains vs GitNexus crossLinks');
  console.log('═'.repeat(80));

  // 汇总
  const totalInternal = results.reduce((s, r) => s + r.internalMethods, 0);
  const totalCovered = results.reduce((s, r) => s + r.coveredMethods, 0);
  const totalExternal = results.reduce((s, r) => s + r.externalMethods, 0);
  const totalMethods = results.reduce((s, r) => s + r.totalMethods, 0);
  const overallRate = totalInternal > 0 ? (totalCovered / totalInternal * 100).toFixed(1) : '0';

  console.log(`\n  📊 Overall Summary:`);
  console.log(`     Chains analyzed:         ${results.length}`);
  console.log(`     Total unique methods:    ${totalMethods}`);
  console.log(`     Internal (trackable):    ${totalInternal}`);
  console.log(`     External (skip):         ${totalExternal}`);
  console.log(`     Covered by crossLinks:   ${totalCovered}`);
  console.log(`     Missing:                 ${totalInternal - totalCovered}`);
  console.log(`     ────────────────────────────────`);
  console.log(`     Overall Coverage:        ${overallRate}%`);

  // 每条链路
  console.log('\n  📋 Per-Chain Results:');
  console.log('  ' + '─'.repeat(78));
  console.log('  ' + 'Trace'.padEnd(28) + 'Internal'.padStart(10) + 'Covered'.padStart(10) + 'Missing'.padStart(10) + 'Rate'.padStart(10));
  console.log('  ' + '─'.repeat(78));

  const sorted = [...results].sort((a, b) => a.coverageRate - b.coverageRate);
  for (const r of sorted) {
    const rate = (r.coverageRate * 100).toFixed(1) + '%';
    const missing = r.internalMethods - r.coveredMethods;
    console.log('  ' +
      r.traceName.padEnd(28) +
      String(r.internalMethods).padStart(10) +
      String(r.coveredMethods).padStart(10) +
      String(missing).padStart(10) +
      rate.padStart(10)
    );
  }

  if (summaryOnly) return;

  // 详细缺失分析
  console.log('\n  ❌ Missing Methods Detail (grouped by repo):');
  console.log('  ' + '─'.repeat(78));

  const missingByRepo = new Map<string, { trace: string; method: string; appkey: string }[]>();
  for (const r of results) {
    for (const m of r.missingMethods) {
      const repo = m.repo || 'unknown';
      const list = missingByRepo.get(repo) || [];
      list.push({ trace: r.traceName, method: m.method, appkey: m.appkey });
      missingByRepo.set(repo, list);
    }
  }

  const sortedRepos = [...missingByRepo.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [repo, methods] of sortedRepos.slice(0, 15)) {
    const uniqueMethods = [...new Set(methods.map(m => m.method))];
    console.log(`\n    📁 ${repo} (${uniqueMethods.length} unique missing methods):`);
    for (const m of uniqueMethods.slice(0, 8)) {
      const traces = methods.filter(x => x.method === m).map(x => x.trace);
      console.log(`       • ${m}`);
      console.log(`         in: ${traces.slice(0, 3).join(', ')}${traces.length > 3 ? ` +${traces.length - 3} more` : ''}`);
    }
    if (uniqueMethods.length > 8) {
      console.log(`       ... and ${uniqueMethods.length - 8} more`);
    }
  }
  if (sortedRepos.length > 15) {
    console.log(`\n    ... and ${sortedRepos.length - 15} more repos with missing methods`);
  }

  // 收集所有外部 appkeys（从已加载的 chain 文件中）
  const allExternalAppkeys = new Map<string, number>();
  for (const file of chainFiles) {
    try {
      const chains: LotusChainFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
      for (const node of chains.nodes) {
        if (node.appkey && node.appkey !== 'merge.appkey' && !APPKEY_TO_REPO[node.appkey]) {
          allExternalAppkeys.set(node.appkey, (allExternalAppkeys.get(node.appkey) || 0) + 1);
        }
      }
    } catch { /* skip missing files */ }
  }

  if (allExternalAppkeys.size > 0) {
    console.log('\n  ⏭️  External Appkeys (not in flight-all group):');
    console.log('  ' + '─'.repeat(78));
    const sortedExt = [...allExternalAppkeys.entries()].sort((a, b) => b[1] - a[1]);
    for (const [ak, count] of sortedExt.slice(0, 20)) {
      console.log(`    ${ak} (${count} method calls)`);
    }
    if (sortedExt.length > 20) console.log(`    ... and ${sortedExt.length - 20} more`);
  }
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  let chainFiles: string[] = [];
  let summaryOnly = args.includes('--summary');

  if (args.includes('--chain')) {
    const idx = args.indexOf('--chain');
    if (args[idx + 1]) {
      chainFiles = [path.resolve(args[idx + 1])];
    }
  } else {
    // 默认: 加载所有 lotus-chain-*.json
    const files = fs.readdirSync(FIXTURES_DIR)
      .filter(f => f.startsWith('lotus-chain-') && f.endsWith('.json'))
      .map(f => path.join(FIXTURES_DIR, f));
    chainFiles = files;
  }

  // 也加载一次/二次验价完整链路
  const firstCheck = path.join(FIXTURES_DIR, 'lotus-firstcheck-chain.json');
  const secondCheck = path.join(FIXTURES_DIR, 'lotus-secondcheck-chain.json');
  if (fs.existsSync(firstCheck) && !chainFiles.includes(firstCheck)) {
    chainFiles.push(firstCheck);
  }
  if (fs.existsSync(secondCheck) && !chainFiles.includes(secondCheck)) {
    chainFiles.push(secondCheck);
  }

  console.log('🔗 Lotus Chain-Level Diff Tool');
  console.log(`   Loading ${chainFiles.length} chain files from ${FIXTURES_DIR}`);
  console.log('');

  // 加载 crossLinks
  const crossLinks = loadCrossLinks();
  const index = buildCrossLinkIndex(crossLinks);
  console.log(`📇 Index: ${index.byTargetMethod.size} target methods, ${index.byTargetService.size} target services, ${index.byTargetRepo.size} target repos`);

  // 比对每条链路
  const results: ChainDiffResult[] = [];
  for (const file of chainFiles) {
    const chain: LotusChainFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const result = diffChain(chain, index);
    results.push(result);
  }

  // 输出报告
  printReport(results, summaryOnly, chainFiles);

  // 保存 JSON 报告
  const reportPath = path.join(GROUP_DIR, 'lotus-chain-diff-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    chainFiles: chainFiles.map(f => path.basename(f)),
    summary: {
      totalChains: results.length,
      totalMethods: results.reduce((s, r) => s + r.totalMethods, 0),
      internalMethods: results.reduce((s, r) => s + r.internalMethods, 0),
      externalMethods: results.reduce((s, r) => s + r.externalMethods, 0),
      coveredMethods: results.reduce((s, r) => s + r.coveredMethods, 0),
      overallCoverage: results.reduce((s, r) => s + r.internalMethods, 0) > 0
        ? results.reduce((s, r) => s + r.coveredMethods, 0) / results.reduce((s, r) => s + r.internalMethods, 0)
        : 0,
    },
    chains: results.map(r => ({
      traceName: r.traceName,
      logicTraceId: r.logicTraceId,
      totalNodes: r.totalNodes,
      totalMethods: r.totalMethods,
      internalMethods: r.internalMethods,
      externalMethods: r.externalMethods,
      coveredMethods: r.coveredMethods,
      coverageRate: r.coverageRate,
      missingMethods: r.missingMethods.map(m => ({
        appkey: m.appkey,
        repo: m.repo,
        method: m.method,
        type: m.type,
      })),
    })),
  }, null, 2));
  console.log(`\n💾 Report saved to: ${reportPath}`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
