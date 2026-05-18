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
  'com.sankuai.flightmerchant.selftrade': 'merchant/selftrade',
  'com.sankuai.flight.biz.merchant': 'merchant/center',
  'com.sankuai.flight.biz.distribution': 'merchant/distribution',
  'com.sankuai.flight.biz.selfoperator': 'biz/selfoperator',
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
ignored?: boolean;   // 标记已下线/group 外的节点，diff 时跳过
ignoreReason?: string;
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
  // Mafka Topic 维度
  totalTopics: number;         // 链路中的 topic 调用数
  coveredTopics: number;       // 被 crossLinks 覆盖的 topic
  missingTopics: MethodCall[]; // 未覆盖的 topic
  topicCoverageRate: number;
  // RPC/HTTP 维度（排除 topic）
  totalRpc: number;
  coveredRpc: number;
  rpcCoverageRate: number;
  // Thrift-mode Dbus 维度（binlog listener 跨仓链路）
  thriftDbusCovered: string[];   // 本链路覆盖的 thrift-mode dbus consumer contractIds
  thriftDbusMissing: string[];   // 本链路未覆盖的 thrift-mode dbus consumer contractIds
}

// ============ 数据结构 ============
interface StoredContract {
  contractId: string;
  type: string;
  role: string;
  repo: string;
  service: string;
  symbolUid: string;
  symbolRef: { filePath: string; name: string };
  symbolName: string;
  confidence: number;
  meta?: Record<string, unknown>;
}

/** DBus CDC contract index for coverage verification */
interface DbusIndex {
  /** topicName → dbus consumer contract (mafka mode) */
  byTopic: Map<string, StoredContract>;
  /** thriftServiceName → dbus consumer contract (thrift mode) */
  byThriftService: Map<string, StoredContract>;
  /** repo → dbus contracts[] */
  byRepo: Map<string, StoredContract[]>;
  /** repo → dbus contracts[] (same as byRepo, for direct lookup) */
  byConsumerRepo: Map<string, StoredContract[]>;
  /** dbus contractId → set of write-side repos (thrift mode only)
   *  Write-side repos are determined from crossLinks where to.repo = consumer repo.
   *  A dbus consumer is covered if ANY of its write-side repos is present in fixtures. */
  writeSideRepos: Map<string, Set<string>>;
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

// ============ 加载 contracts（用于 topic producer 回补） ============
function loadContracts(): StoredContract[] {
  const content = fs.readFileSync(CONTRACTS_FILE, 'utf-8');
  const data = JSON.parse(content);
  return data.contracts || [];
}

// ============ 构建 crossLinks 索引 ============
interface CrossLinkIndex {
  // key: "targetRepo::ServiceName/methodName" → crossLinks[]
  byTargetMethod: Map<string, CrossLink[]>;
  // key: "targetRepo::ServiceName" → crossLinks[]
  byTargetService: Map<string, CrossLink[]>;
  // key: "targetRepo" → crossLinks[]
  byTargetRepo: Map<string, CrossLink[]>;
  // key: "topicName" (不含 topic:: 前缀) → crossLinks[]
  byTopic: Map<string, CrossLink[]>;
  // key: "repo::topicName" → crossLinks[] (repo 维度的 topic 索引)
  byRepoTopic: Map<string, CrossLink[]>;
  // Producer-only 补充索引: topics with provider contracts but no consumer crossLink
  // (same-repo self-call like fd_check_dispatcher in basis/fare)
  // key: topicName (lowercase) → provider repo
  producerOnlyTopics: Map<string, string>;
  // key: repo → Map<topicName, topicName>
  producerOnlyRepoTopic: Map<string, Map<string, string>>;
}

function buildCrossLinkIndex(crossLinks: CrossLink[], contracts: StoredContract[]): { index: CrossLinkIndex; dbusIndex: DbusIndex } {
  const index: CrossLinkIndex = {
    byTargetMethod: new Map(),
    byTargetService: new Map(),
    byTargetRepo: new Map(),
    byTopic: new Map(),
    byRepoTopic: new Map(),
    producerOnlyTopics: new Map(),
    producerOnlyRepoTopic: new Map(),
  };

  const dbusIndex: DbusIndex = {
    byTopic: new Map(),
    byThriftService: new Map(),
    byRepo: new Map(),
    byConsumerRepo: new Map(),
    writeSideRepos: new Map(),
  };

  // Step 1: identify topics that have consumer crossLinks
  const topicHasConsumer = new Set<string>();
  for (const cl of crossLinks) {
    if (cl.contractId.startsWith('topic::')) {
      topicHasConsumer.add(cl.contractId.replace('topic::', '').toLowerCase());
    }
  }

  // Step 2: find topics with provider contracts but no consumer crossLink
  // → same-repo self-call (e.g. fd_check_dispatcher in basis/fare)
  for (const c of contracts) {
    if (c.type !== 'topic' || c.role !== 'provider') continue;
    const topicLower = (c.meta?.topicName as string || '').toLowerCase();
    if (!topicLower) continue;
    if (topicHasConsumer.has(topicLower)) continue;
    const providerRepo = (c.repo || '').toLowerCase();
    if (!providerRepo) continue;
    // Register topic if new
    if (!index.producerOnlyTopics.has(topicLower)) {
      index.producerOnlyTopics.set(topicLower, providerRepo);
    }
    // Ensure repo map exists for this topic
    if (!index.producerOnlyRepoTopic.has(providerRepo)) {
      index.producerOnlyRepoTopic.set(providerRepo, new Map());
    }
    index.producerOnlyRepoTopic.get(providerRepo)!.set(topicLower, topicLower);
  }

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
    } else if (contractId.startsWith('topic::')) {
      // Mafka Topic crossLink: contractId = "topic::topicName"
      const topicName = contractId.replace('topic::', '').toLowerCase();
      // byTopic: 全局 topic 索引
      const tList = index.byTopic.get(topicName) || [];
      tList.push(cl);
      index.byTopic.set(topicName, tList);
      // byRepoTopic: 按 from repo (consumer) 和 to repo (producer) 都索引
      for (const repo of [cl.from.repo, cl.to.repo]) {
        if (!repo) continue;
        const rtKey = `${repo}::${topicName}`;
        const rtList = index.byRepoTopic.get(rtKey) || [];
        rtList.push(cl);
        index.byRepoTopic.set(rtKey, rtList);
      }
    }
  }

  // Build dbus index from contracts.
  // Supports two contract types:
  //   - type='topic': topic contracts from MafkaPropertiesExtractor.
  //     Dbus topics are identified by DBUS_NAME_RE pattern in topic name (extracted from contractId).
  //   - type='dbus': explicit dbus contracts from DbusExtractor.
  //
  // Note: contracts.json uses { from, to, type, contractId } format.
  //   - contractId for topics: "topic::<name>"
  //   - contractId for dbus: "dbus::topicName" or "dbus::thrift::serviceName"
  //   - Repo is in c.from.repo (consumer) and c.to.repo (producer)
  const DBUS_NAME_RE = /\b(dbus|databus|dts)\b/i;

  for (const c of contracts) {
    let topicName = '';
    let isDbus = false;

    if (c.type === 'topic') {
      // Extract topic name from contractId (format: "topic::<name>")
      // contracts.json has no meta field; topic name is encoded in contractId
      topicName = c.contractId.replace(/^topic::/, '');
      isDbus = DBUS_NAME_RE.test(topicName);
    } else if (c.type === 'dbus') {
      // DbusExtractor: contractId format is 'dbus::topicName' or 'dbus::thrift::serviceName'
      topicName = c.contractId.replace(/^dbus::(?:thrift::)?/, '');
      isDbus = true;
    } else {
      continue;
    }

    if (!isDbus || !topicName) continue;

    const topicKey = topicName.toLowerCase();
    if (!dbusIndex.byTopic.has(topicKey)) {
      dbusIndex.byTopic.set(topicKey, c);
    }

    // Also index by thriftService for dbus contracts (thrift-mode consumers).
    // makeDbusContract() doesn't set meta.thriftService, so we extract the
    // service name from contractId (format: "dbus::thrift::ServiceName").
    if (c.type === 'dbus') {
      const meta = c.meta as Record<string, unknown> | undefined;
      let thriftService = meta?.thriftService as string | undefined;
      if (!thriftService) {
        // contractId like "dbus::thrift::DataBusThriftService" -> extract "DataBusThriftService"
        if (c.contractId.startsWith('dbus::thrift::')) {
          thriftService = c.contractId.split('::').pop()!;
        }
      }
      if (thriftService) {
        const svcKey = thriftService.toLowerCase();
        if (!dbusIndex.byThriftService.has(svcKey)) {
          dbusIndex.byThriftService.set(svcKey, c);
        }
      }
    }

    // Index by consumer repo (from StoredContract.repo field)
    // Note: StoredContract has 'repo' field directly (set to groupPath in sync.ts),
    // NOT 'from.repo'.
    const consumerRepo = c.repo;
    if (consumerRepo) {
      const repoList = dbusIndex.byRepo.get(consumerRepo) || [];
      repoList.push(c);
      dbusIndex.byRepo.set(consumerRepo, repoList);

      // byConsumerRepo: same data for direct lookup
      const consumerList = dbusIndex.byConsumerRepo.get(consumerRepo) || [];
      consumerList.push(c);
      dbusIndex.byConsumerRepo.set(consumerRepo, consumerList);
    }
  }

  // Populate writeSideRepos: prefer meta.writeSideRepos (from deriveDbusWriteSides in sync.ts),
  // fallback to crossLinks-based inference (for contracts.json that hasn't been re-synced yet).
  let hasMetaWriteSide = false;
  for (const c of contracts) {
    if (c.type !== 'dbus' || c.role !== 'consumer') continue;
    const writeSide = c.meta?.writeSideRepos as string[] | undefined;
    if (!writeSide || writeSide.length === 0) continue;
    hasMetaWriteSide = true;
    const contractId = (c.contractId || '').toLowerCase();
    if (!dbusIndex.writeSideRepos.has(contractId)) {
      dbusIndex.writeSideRepos.set(contractId, new Set());
    }
    for (const r of writeSide) {
      dbusIndex.writeSideRepos.get(contractId)!.add(r.toLowerCase());
    }
  }

  // Fallback: if no contracts have meta.writeSideRepos, derive from crossLinks.
  // For each crossLink targeting a dbus consumer repo, record the write-side repo.
  if (!hasMetaWriteSide) {
    for (const cl of crossLinks) {
      const toRepo = (cl.to?.repo || '').toLowerCase();
      if (!toRepo) continue;
      const fromRepo = (cl.from?.repo || '').toLowerCase();
      if (!fromRepo || fromRepo === toRepo) continue;

      if (dbusIndex.byConsumerRepo.has(toRepo)) {
        for (const c of dbusIndex.byConsumerRepo.get(toRepo)!) {
          const contractId = (c.contractId || '').toLowerCase();
          if (!dbusIndex.writeSideRepos.has(contractId)) {
            dbusIndex.writeSideRepos.set(contractId, new Set());
          }
          dbusIndex.writeSideRepos.get(contractId)!.add(fromRepo);
        }
      }
    }
  }

  return { index, dbusIndex };
}

// ============ 解析 Lotus 链路中的方法调用 ============
function extractMethodCalls(chain: LotusChainFile): MethodCall[] {
  const seen = new Set<string>();
  const calls: MethodCall[] = [];

  for (const node of chain.nodes) {
    if (node.appkey === 'merge.appkey' || !node.appkey || !node.method) continue;
    if (node.method === 'merge.methodName') continue;
    if (node.ignored) continue;  // 跳过已标记忽略的节点（已下线/group 外）

    const key = `${node.appkey}::${node.method}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const repo = (node as any).repo || APPKEY_TO_REPO[node.appkey] || null;

    let serviceName: string;
    let methodName: string;
    const nodeType = node.type.toLowerCase();

    if (nodeType === 'mafka' || nodeType === 'topic' || nodeType === 'dbus') {
      // Mafka/DBus Topic 节点: method = "topic::topicName"
      const topicName = node.method.replace(/^topic::/, '');
      serviceName = topicName;
      methodName = topicName;
    } else if (nodeType === 'http') {
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
function matchMethodCall(call: MethodCall, index: CrossLinkIndex, dbusIndex: DbusIndex): boolean {
  if (!call.repo) return false;

  const callType = call.type.toLowerCase();

  // Mafka/DBus Topic 节点：匹配 topic crossLinks 和 dbus index
  if (callType === 'mafka' || callType === 'topic' || callType === 'dbus') {
    const topicName = call.method.replace(/^topic::/, '').toLowerCase();
    // 策略1: repo + topic 精确匹配
    const rtKey = `${call.repo}::${topicName}`;
    if (index.byRepoTopic.has(rtKey)) return true;
    // 策略2: 全局 topic 名匹配（topic 可能连接不同 repo）
    if (index.byTopic.has(topicName)) return true;
    // 策略3: producer-only 补充（same-repo 自产自销，如 fd_check_dispatcher）
    if (index.producerOnlyTopics.has(topicName)) return true;
    const repoTopics = index.producerOnlyRepoTopic.get(call.repo);
    if (repoTopics && repoTopics.has(topicName)) return true;
    // 策略4: dbus index 补充（如果该 topic 是 dbus topic，dbus consumer 也算覆盖）
    if (dbusIndex.byTopic.has(topicName)) return true;
    return false;
  }

  // Thrift 模式 DBus 消费者：匹配 dbus thrift service 索引
  if (dbusIndex.byThriftService.size > 0) {
    const simpleSvcName = call.serviceName.split('.').pop()!;
    // 精确检查 thrift service 简名
    if (dbusIndex.byThriftService.has(simpleSvcName.toLowerCase())) return true;
    // 也检查全限定名
    if (dbusIndex.byThriftService.has(call.serviceName.toLowerCase())) return true;
    // 遍历检查尾部匹配（如 OrderSearchDataBusService → DataBusEventServiceV2）
    for (const [svcKey] of dbusIndex.byThriftService) {
      if (call.serviceName.toLowerCase().endsWith('.' + svcKey) ||
          call.serviceName.toLowerCase() === svcKey ||
          simpleSvcName.toLowerCase() === svcKey) {
        return true;
      }
    }
  }

  // HTTP 节点：method 是 path，toLowerCase 后与索引的 http path 匹配
  if (callType === 'http') {
    const callPath = call.method.toLowerCase();
    const pathKey = `${call.repo}::${callPath}`;
    if (index.byTargetMethod.has(pathKey)) return true;
    // 也尝试去掉开头斜杠
    const pathKeyNoSlash = `${call.repo}::${callPath.replace(/^\//, '')}`;
    if (index.byTargetMethod.has(pathKeyNoSlash)) return true;
    // Lotus 路径可能带平台/版本后缀（如 /OnewayFlightList/android/{num}/kxmb_mt）
    // crossLinks 中是基础路径（如 /onewayflightlist），尝试取第一段做前缀匹配
    const repoPrefix = `${call.repo}::`;
    for (const key of index.byTargetMethod.keys()) {
      if (!key.startsWith(repoPrefix)) continue;
      const indexPath = key.slice(repoPrefix.length);
      // 检查 Lotus path 是否以 crossLinks path 开头（或去掉斜杠后匹配）
      const normalizedCallPath = callPath.replace(/^\//, '');
      const normalizedIndexPath = indexPath.replace(/^\//, '');
      if (normalizedCallPath.startsWith(normalizedIndexPath + '/') ||
          normalizedCallPath === normalizedIndexPath) {
        return true;
      }
    }
    return false;
  }

  // 策略1: 精确匹配 "repo::ServiceName/methodName"
  const exactKey = `${call.repo}::${call.serviceName}/${call.methodName}`.toLowerCase();
  if (index.byTargetMethod.has(exactKey)) return true;
  // 策略0.5: DBus thrift service 快速路径（对 thrift 模式 dbus consumer 的特殊匹配）
  // 如 OrderSearchDataBusService、DataBusEventServiceV2 等 thrift 服务
  if (dbusIndex.byThriftService.size > 0) {
    const simpleSvcName2 = call.serviceName.split('.').pop()!;
    if (dbusIndex.byThriftService.has(simpleSvcName2.toLowerCase())) return true;
    if (dbusIndex.byThriftService.has(call.serviceName.toLowerCase())) return true;
    for (const [svcKey] of dbusIndex.byThriftService) {
      if (call.serviceName.toLowerCase().endsWith('.' + svcKey) ||
          call.serviceName.toLowerCase() === svcKey ||
          simpleSvcName2.toLowerCase() === svcKey) {
        return true;
      }
    }
  }

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
function diffChain(chain: LotusChainFile, index: CrossLinkIndex, dbusIndex: DbusIndex): ChainDiffResult {
  const calls = extractMethodCalls(chain);
  const internalCalls = calls.filter(c => c.repo !== null);
  const externalCalls = calls.filter(c => c.repo === null);

  const coveredCalls: MethodCall[] = [];
  const missingCalls: MethodCall[] = [];

  for (const call of internalCalls) {
    if (matchMethodCall(call, index, dbusIndex)) {
      coveredCalls.push(call);
    } else {
      missingCalls.push(call);
    }
  }

  // 分离 Topic 和 RPC/HTTP 维度统计
  const isTopic = (c: MethodCall) => {
    const t = c.type.toLowerCase();
    return t === 'mafka' || t === 'topic' || t === 'dbus';
  };
  const internalTopics = internalCalls.filter(isTopic);
  const coveredTopicCalls = coveredCalls.filter(isTopic);
  const missingTopicCalls = missingCalls.filter(isTopic);
  const internalRpc = internalCalls.filter(c => !isTopic(c));
  const coveredRpcCalls = coveredCalls.filter(c => !isTopic(c));

  // Compute thrift-mode dbus coverage: for each thrift dbus contract,
  // check if any of its write-side repos is present in this fixture.
  const fixtureRepos = new Set<string>();
  for (const node of chain.nodes) {
    const repo = (node as any).repo || APPKEY_TO_REPO[node.appkey] || null;
    if (repo) fixtureRepos.add(repo.toLowerCase());
  }

  // Thrift-mode dbus coverage: return per-chain covered/missing sets.
  // A consumer is "covered" in a chain if ANY of its write-side repos appears in that fixture.
  // Per-chain sets may overlap (same contract appears in multiple chains).
  const thriftDbusCoveredSet = new Set<string>();
  const thriftDbusMissingSet = new Set<string>();
  for (const [svcKey, contract] of dbusIndex.byThriftService) {
    const contractId = (contract.contractId || '').toLowerCase();
    const writeSideSet = dbusIndex.writeSideRepos.get(contractId);
    if (!writeSideSet || writeSideSet.size === 0) {
      // No crossLinks pointing to this consumer -> write-side unknown, mark as missing
      thriftDbusMissingSet.add(contractId);
      continue;
    }
    // Covered if any write-side repo is in the fixture
    let covered = false;
    for (const wr of writeSideSet) {
      if (fixtureRepos.has(wr.toLowerCase())) {
        covered = true;
        break;
      }
    }
    if (covered) {
      thriftDbusCoveredSet.add(contractId);
    } else {
      thriftDbusMissingSet.add(contractId);
    }
  }
  const thriftDbusCovered = [...thriftDbusCoveredSet];
  const thriftDbusMissing = [...thriftDbusMissingSet];

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
    totalTopics: internalTopics.length,
    coveredTopics: coveredTopicCalls.length,
    missingTopics: missingTopicCalls,
    topicCoverageRate: internalTopics.length > 0
      ? coveredTopicCalls.length / internalTopics.length
      : 0,
    totalRpc: internalRpc.length,
    coveredRpc: coveredRpcCalls.length,
    rpcCoverageRate: internalRpc.length > 0
      ? coveredRpcCalls.length / internalRpc.length
      : 0,
    thriftDbusCovered,
    thriftDbusMissing,
  };
}

// ============ 输出报告 ============
function printReport(
  results: ChainDiffResult[],
  summaryOnly: boolean,
  chainFiles: string[],
  dbusIndex: DbusIndex,
  thriftStats: { total: number; covered: number; missing: Set<string>; coveredSet: Set<string> },
): void {
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

  // Topic 维度汇总（mafka mode dbus）
  const totalTopics = results.reduce((s, r) => s + r.totalTopics, 0);
  const totalCoveredTopics = results.reduce((s, r) => s + r.coveredTopics, 0);
  const topicRate = totalTopics > 0 ? (totalCoveredTopics / totalTopics * 100).toFixed(1) : 'N/A';
  // RPC/HTTP 维度汇总
  const totalRpc = results.reduce((s, r) => s + r.totalRpc, 0);
  const totalCoveredRpc = results.reduce((s, r) => s + r.coveredRpc, 0);
  const rpcRate = totalRpc > 0 ? (totalCoveredRpc / totalRpc * 100).toFixed(1) : 'N/A';
  // Thrift-mode Dbus 维度汇总（binlog listener，由 write-side 触发）
  // Aggregation rule: a dbus consumer is globally "covered" if ANY fixture covers it
  // (i.e., any fixture contains a write-side repo that triggers the binlog listener).
  // It is globally "missing" only if NO fixture contains any of its write-side repos.
  const allContracts = new Set([...thriftStats.coveredSet, ...thriftStats.missing]);
  const totalThrift = allContracts.size;
  const totalCoveredThrift = thriftStats.coveredSet.size;
  const thriftRate = totalThrift > 0 ? (totalCoveredThrift / totalThrift * 100).toFixed(1) : 'N/A';
  // Missing = contracts that appear in missing set but NOT in covered set
  const allThriftMissing = new Set([...thriftStats.missing].filter(c => !thriftStats.coveredSet.has(c)));
  const allThriftCovered = thriftStats.coveredSet;

  console.log(`\n  📊 Overall Summary:`);
  console.log(`     Chains analyzed:         ${results.length}`);
  console.log(`     Total unique calls:      ${totalMethods}`);
  console.log(`     Internal (trackable):    ${totalInternal}`);
  console.log(`     External (skip):         ${totalExternal}`);
  console.log(`     Covered by crossLinks:   ${totalCovered}`);
  console.log(`     Missing:                 ${totalInternal - totalCovered}`);
  console.log(`     ────────────────────────────────`);
  console.log(`     Overall Coverage:        ${overallRate}%`);
  console.log(``);
  console.log(`     📡 RPC/HTTP Coverage:      ${totalCoveredRpc}/${totalRpc} = ${rpcRate}%`);
  console.log(`     📨 Mafka Topic Coverage:   ${totalCoveredTopics}/${totalTopics} = ${topicRate}%`);
  console.log(`     🔄 Thrift Dbus Coverage:   ${totalCoveredThrift}/${totalThrift} = ${thriftRate}%`);

  // 每条链路
  console.log('\n  📋 Per-Chain Results:');
  console.log('  ' + '─'.repeat(78));
  console.log('  ' + 'Trace'.padEnd(28) + 'RPC'.padStart(8) + 'RPC%'.padStart(8) + 'Topic'.padStart(8) + 'Topic%'.padStart(8) + 'Total'.padStart(8) + 'Rate'.padStart(8));
  console.log('  ' + '─'.repeat(76));

  const sorted = [...results].sort((a, b) => a.coverageRate - b.coverageRate);
  for (const r of sorted) {
    const rate = (r.coverageRate * 100).toFixed(1) + '%';
    const rpcR = r.totalRpc > 0 ? (r.rpcCoverageRate * 100).toFixed(0) + '%' : '-';
    const topicR = r.totalTopics > 0 ? (r.topicCoverageRate * 100).toFixed(0) + '%' : '-';
    const rpcStr = r.totalRpc > 0 ? `${r.coveredRpc}/${r.totalRpc}` : '-';
    const topicStr = r.totalTopics > 0 ? `${r.coveredTopics}/${r.totalTopics}` : '-';
    console.log('  ' +
      r.traceName.padEnd(28) +
      rpcStr.padStart(8) +
      rpcR.padStart(8) +
      topicStr.padStart(8) +
      topicR.padStart(8) +
      String(r.internalMethods).padStart(8) +
      rate.padStart(8)
    );
  }

  if (summaryOnly) return;

  // Mafka Topic 缺失详情
  const allMissingTopics = results.flatMap(r => r.missingTopics.map(t => ({ ...t, trace: r.traceName })));
  // Thrift-mode Dbus 缺失详情
  if (allThriftMissing.size > 0) {
    console.log(`\n  🔄 Missing Thrift Dbus Consumers (${allThriftMissing.size} missing):`);
    console.log('  ' + '─'.repeat(78));
    const sortedMissing = [...allThriftMissing].sort();
    for (const contractId of sortedMissing) {
      const writeSide = dbusIndex.writeSideRepos.get(contractId);
      const ws = writeSide ? [...writeSide].sort().join(', ') : '(unknown)';
      console.log(`    ✗ ${contractId}`);
      console.log(`       write-side: ${ws}`);
    }
    // Also list covered thrift dbus for completeness
    console.log(`\n  ✅ Covered Thrift Dbus Consumers (${allThriftCovered.size}):`);
    console.log('  ' + '─'.repeat(78));
    const sortedCovered = [...allThriftCovered].sort();
    for (const contractId of sortedCovered) {
      const writeSide = dbusIndex.writeSideRepos.get(contractId);
      const ws = writeSide ? [...writeSide].sort().join(', ') : '(unknown)';
      console.log(`    ✓ ${contractId}`);
      console.log(`       write-side: ${ws}`);
    }
  }

  if (allMissingTopics.length > 0) {
    const uniqueTopics = [...new Set(allMissingTopics.map(t => t.method))];
    console.log(`\n  📨 Missing Mafka Topics (${uniqueTopics.length} unique):`);
    console.log('  ' + '─'.repeat(78));
    for (const topic of uniqueTopics.slice(0, 20)) {
      const entries = allMissingTopics.filter(t => t.method === topic);
      const repos = [...new Set(entries.map(t => t.repo))];
      const traces = [...new Set(entries.map(t => t.trace))];
      console.log(`    ${topic}`);
      console.log(`      repos: ${repos.join(', ')}  |  chains: ${traces.slice(0, 3).join(', ')}${traces.length > 3 ? ` +${traces.length - 3}` : ''}`);
    }
    if (uniqueTopics.length > 20) console.log(`    ... and ${uniqueTopics.length - 20} more`);
  }

  // 详细缺失分析（RPC/HTTP）
  console.log('\n  ❌ Missing RPC/HTTP Methods Detail (grouped by repo):');
  console.log('  ' + '─'.repeat(78));

  const missingByRepo = new Map<string, { trace: string; method: string; appkey: string }[]>();
  for (const r of results) {
    // 只列 RPC/HTTP 缺失（Topic 缺失已单独列出）
    const rpcMissing = r.missingMethods.filter(m => {
      const t = m.type.toLowerCase();
      return t !== 'mafka' && t !== 'topic';
    });
    for (const m of rpcMissing) {
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
    // 默认: 加载所有 LotusChainFile 格式的 fixture 文件
    // 排除非链路文件（lotus-flight-full.json 是元数据索引，lotus-traffic-entries.json 是入口列表）
    const NON_CHAIN_FILES = new Set(['lotus-flight-full.json', 'lotus-traffic-entries.json']);
    const files = fs.readdirSync(FIXTURES_DIR)
      .filter(f => f.endsWith('.json') && !NON_CHAIN_FILES.has(f))
      .map(f => path.join(FIXTURES_DIR, f));
    chainFiles = files;
  }

  console.log('🔗 Lotus Chain-Level Diff Tool');
  console.log(`   Loading ${chainFiles.length} chain files from ${FIXTURES_DIR}`);
  console.log('');

  // 加载 crossLinks
  const contracts = loadContracts();
  const crossLinks = loadCrossLinks();
  const { index, dbusIndex } = buildCrossLinkIndex(crossLinks, contracts);
  console.log(`📇 Index: ${index.byTargetMethod.size} target methods, ${index.byTargetService.size} target services, ${index.byTargetRepo.size} target repos, ${index.byTopic.size} topics, ${index.byRepoTopic.size} repo-topic pairs, ${index.producerOnlyTopics.size} producer-only topics, ${dbusIndex.byTopic.size} dbus topics, ${dbusIndex.byThriftService.size} dbus thrift services`);

  // 比对每条链路
  const results: ChainDiffResult[] = [];
  for (const file of chainFiles) {
    const chain: LotusChainFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const result = diffChain(chain, index, dbusIndex);
    results.push(result);
  }

  // 输出报告
  // Compute thrift dbus coverage stats for report
  const allThriftCoveredSet = new Set<string>();
  const allThriftMissingSet = new Set<string>();
  for (const r of results) {
    for (const c of r.thriftDbusCovered) allThriftCoveredSet.add(c);
    for (const m of r.thriftDbusMissing) allThriftMissingSet.add(m);
  }
  // allThriftCoveredSet 和 allThriftMissingSet 可能有交集（同一 handler 在某些链路覆盖、另一些链路未覆盖）
  // total 应取并集去重，covered handler 只要在任意链路被覆盖即算覆盖
  const allThriftUnion = new Set([...allThriftCoveredSet, ...allThriftMissingSet]);
  // 真正未覆盖 = 从未出现在任何链路的 covered 集合中的 handler
  const trulyMissing = new Set([...allThriftMissingSet].filter(h => !allThriftCoveredSet.has(h)));
  const thriftStats = {
    total: allThriftUnion.size,
    covered: allThriftCoveredSet.size,
    missing: trulyMissing,
    coveredSet: allThriftCoveredSet,
  };

  printReport(results, summaryOnly, chainFiles, dbusIndex, thriftStats);

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
      // RPC/HTTP 维度
      totalRpc: results.reduce((s, r) => s + r.totalRpc, 0),
      coveredRpc: results.reduce((s, r) => s + r.coveredRpc, 0),
      rpcCoverageRate: (() => {
        const t = results.reduce((s, r) => s + r.totalRpc, 0);
        return t > 0 ? results.reduce((s, r) => s + r.coveredRpc, 0) / t : 0;
      })(),
      // Mafka Topic 维度
      totalTopics: results.reduce((s, r) => s + r.totalTopics, 0),
      coveredTopics: results.reduce((s, r) => s + r.coveredTopics, 0),
      topicCoverageRate: (() => {
        const t = results.reduce((s, r) => s + r.totalTopics, 0);
        return t > 0 ? results.reduce((s, r) => s + r.coveredTopics, 0) / t : 0;
      })(),
      missingTopics: results.flatMap(r => r.missingTopics.map(m => ({
        chain: r.traceName,
        appkey: m.appkey,
        repo: m.repo,
        topic: m.method,
      }))),
      // Thrift-mode Dbus 维度
      totalThriftDbus: thriftStats.total,
      coveredThriftDbus: thriftStats.covered,
      thriftDbusCoverageRate: thriftStats.total > 0 ? thriftStats.covered / thriftStats.total : 0,
      thriftDbusMissing: [...trulyMissing].sort(),
      thriftDbusCovered: [...allThriftCoveredSet].sort(),
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
      // RPC/HTTP 维度
      totalRpc: r.totalRpc,
      coveredRpc: r.coveredRpc,
      rpcCoverageRate: r.totalRpc > 0 ? r.coveredRpc / r.totalRpc : 0,
      // Mafka Topic 维度
      totalTopics: r.totalTopics,
      coveredTopics: r.coveredTopics,
      topicCoverageRate: r.totalTopics > 0 ? r.coveredTopics / r.totalTopics : 0,
      missingMethods: r.missingMethods.map(m => ({
        appkey: m.appkey,
        repo: m.repo,
        method: m.method,
        type: m.type,
      })),
      missingTopics: r.missingTopics.map(m => ({
        appkey: m.appkey,
        repo: m.repo,
        topic: m.method,
      })),
      // Thrift-mode Dbus 维度
      thriftDbusCovered: r.thriftDbusCovered,
      thriftDbusMissing: r.thriftDbusMissing,
    })),
  }, null, 2));
  console.log(`\n💾 Report saved to: ${reportPath}`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
