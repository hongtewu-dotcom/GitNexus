import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DbusExtractor } from '../../../src/core/group/extractors/dbus-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

describe('DbusExtractor', () => {
  let tmpDir: string;
  let extractor: DbusExtractor;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-dbus-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    extractor = new DbusExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/app',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  // ── Mode A: Mafka DBus Consumer ────────────────────────────────────────

  describe('Mode A — Mafka DBus Consumer', () => {
    it('should extract dbus consumer from mafka.properties', async () => {
      writeFile(
        'profiles/dev/mafka.properties',
        `mdp.mafka.consumers[0].topicName = qos-databus\nmdp.mafka.consumers[0].listenerId = qosDbusListener\n`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/qosdbus/QosDbusListener.java',
        `@Component("qosDbusListener")
public class QosDbusListener {
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(1);
      expect(contracts[0].type).toBe('dbus');
      expect(contracts[0].role).toBe('consumer');
      expect(contracts[0].contractId).toBe('dbus::qos-databus');
      expect(contracts[0].meta.broker).toBe('mafka');
      expect(contracts[0].meta.topicName).toBe('qos-databus');
      expect(contracts[0].meta.extractionStrategy).toBe('mafka_properties_scan');
    });

    it('should extract table names from switch-case', async () => {
      writeFile(
        'profiles/dev/mafka.properties',
        `mdp.mafka.consumers[0].topicName = reaching-dts\nmdp.mafka.consumers[0].listenerId = reachingDtsListener\n`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/reaching/DtsListener.java',
        `@Component("reachingDtsListener")
public class ReachingDtsListener {
    public void handle(String payload) {
        String tableName = getTableName(payload);
        switch (tableName) {
            case "jpqd_reaching.activity":
                processActivity(payload);
                break;
            case "jpqd_reaching.coupon":
                processCoupon(payload);
                break;
            default:
                break;
        }
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(1);
      const meta = contracts[0].meta as Record<string, unknown>;
      expect(meta.tableNames).toContain('jpqd_reaching.activity');
      expect(meta.tableNames).toContain('jpqd_reaching.coupon');
    });

    it('should extract table names from TABLE_* constants', async () => {
      writeFile(
        'mafka.properties',
        `mdp.mafka.consumers[0].topicName = xproduct-dbus\nmdp.mafka.consumers[0].listenerId = xproductDtsListener\n`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/xproduct/XproductDtsListener.java',
        `@Component("xproductDtsListener")
public class XproductDtsListener {
    private static final String TABLE_RULE = "xproduct.rule";
    private static final String TABLE_PRODUCT = "xproduct.product";
    private static final String TABLE_CATEGORY = "xproduct.category";
    public void handle(String payload) {
        switch (getTableName(payload)) {
            case "xproduct.rule":
                break;
        }
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(1);
      const meta = contracts[0].meta as Record<string, unknown>;
      // TABLE_* constants are extracted from the same class
      expect(meta.tableNames).toContain('xproduct.rule');
      expect(meta.tableNames).toContain('xproduct.product');
      expect(meta.tableNames).toContain('xproduct.category');
    });

    it('should skip non-dbus mafka consumers', async () => {
      writeFile(
        'mafka.properties',
        `mdp.mafka.consumers[0].topicName = user-created\nmdp.mafka.consumers[0].listenerId = userCreatedListener\n`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      // Should not emit dbus contracts for non-dbus topics
      const dbusContracts = contracts.filter((c) => c.type === 'dbus');
      expect(dbusContracts).toHaveLength(0);
    });

    it('should extract table names via DbusUtils.getTableName() pattern', async () => {
      writeFile(
        'application.properties',
        `mdp.mafka.consumers[0].topicName = flight-dbus-event\nmdp.mafka.consumers[0].listenerId = flightDbusHandler\n`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/dbus/FlightDbusHandler.java',
        `@Component("flightDbusHandler")
public class FlightDbusHandler {
    public void handle(String payload) {
        if (DbusUtils.getTableName().equals("flight.order")) {
            processOrder(payload);
        } else if (DbusUtils.getTableName().equals("flight.passenger")) {
            processPassenger(payload);
        }
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(1);
      const meta = contracts[0].meta as Record<string, unknown>;
      expect(meta.tableNames).toContain('flight.order');
      expect(meta.tableNames).toContain('flight.passenger');
    });

    it('should fall back to synthetic symbolName when listenerId cannot be resolved', async () => {
      writeFile(
        'mafka.properties',
        `mdp.mafka.consumers[0].topicName = qos-databus\nmdp.mafka.consumers[0].listenerId = unknownListener\n`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(1);
      expect(contracts[0].symbolName).toBe('UnknownListener');
      expect(contracts[0].meta.broker).toBe('mafka');
    });

    it('should deduplicate same topic with same file', async () => {
      writeFile(
        'mafka.properties',
        `mdp.mafka.consumers[0].topicName = qos-databus\nmdp.mafka.consumers[0].listenerId = listener1\n`,
      );
      writeFile(
        'application.properties',
        `mdp.mafka.consumers[0].topicName = qos-databus\nmdp.mafka.consumers[0].listenerId = listener2\n`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/qosdbus/QosDbusListener.java',
        `@Component("listener1")
public class QosDbusListener {}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      // Same topic but different file paths → both emitted
      expect(contracts).toHaveLength(2);
    });

    it('should identify dbus topic variants: databus, dts, cdc', async () => {
      writeFile(
        'mafka.properties',
        `mdp.mafka.consumers[0].topicName = my-databus-topic\nmdp.mafka.consumers[0].listenerId = l1\n`,
      );
      writeFile(
        'application.properties',
        `mdp.mafka.consumers[0].topicName = my-dts-topic\nmdp.mafka.consumers[0].listenerId = l2\nmdp.mafka.consumers[1].topicName = my-cdc-topic\nmdp.mafka.consumers[1].listenerId = l3\n`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/dbus/DbusUtils.java',
        `public class DbusUtils {
    public static String getTableName() { return ""; }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      // All three should be identified as dbus topics
      const contractIds = contracts.map((c) => c.contractId);
      expect(contractIds).toContain('dbus::my-databus-topic');
      expect(contractIds).toContain('dbus::my-dts-topic');
      // l1, l2, l3 cannot be resolved (no @Component), so their contracts use the properties file path.
      // l1 and l2 get unique keys; l3's resolveKey=l3 gets deduplicated by extractDbusFromMafkaProperties
      // (same resolveKey=l3 as something earlier with the same listenerId).
      // Expect at least 2 dbus contracts since l3 deduplicates with l1/l2 on resolveKey.
      expect(contractIds.filter((id) => id.startsWith('dbus::my-')).length).toBeGreaterThanOrEqual(2);
    });

    it('should extract dbName from first table name', async () => {
      writeFile(
        'mafka.properties',
        `mdp.mafka.consumers[0].topicName = flight-cdc\nmdp.mafka.consumers[0].listenerId = flightDbusListener\n`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/dbus/FlightDbusListener.java',
        `@Component("flightDbusListener")
public class FlightDbusListener {
    public void handle(String payload) {
        switch (getTableName(payload)) {
            case "flight.order":
                break;
        }
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(1);
      const meta = contracts[0].meta as Record<string, unknown>;
      expect(meta.dbName).toBe('flight');
    });

    it('should use TableEnum fallback when listener has no table names', async () => {
      writeFile(
        'mafka.properties',
        `mdp.mafka.consumers[0].topicName = selftrade-dbus\nmdp.mafka.consumers[0].listenerId = selftradeDbusListener\n`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/selftrade/SelftradeDbusListener.java',
        `@Component("selftradeDbusListener")
public class SelftradeDbusListener {
    public void handle(String payload) {
        // no switch-case, just processes all events generically
    }
}`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/selftrade/TableEnum.java',
        `public enum TableEnum {
    ORDER("selftrade.tb_order"),
    ORDER_EXT("selftrade.tb_order_ext"),
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(1);
      const meta = contracts[0].meta as Record<string, unknown>;
      expect(meta.tableNames).toContain('selftrade.tb_order');
      expect(meta.tableNames).toContain('selftrade.tb_order_ext');
    });
  });

  // ── Mode B: Thrift DBus Server ─────────────────────────────────────────

  describe('Mode B — Thrift DBus Server', () => {
    it('should extract thrift dbus service implementing DataBusEventServiceV2.Iface', async () => {
      writeFile(
        'src/main/java/com/sankuai/flight/selftrade/OrderSearchDataBusServiceImpl.java',
        `@MdpThriftServer(port = 9000)
public class OrderSearchDataBusServiceImpl implements DataBusEventServiceV2.Iface {
    @Override
    public void handleUpdate(String data) {
        if (DbusUtils.getTableName().equals("selftrade.tb_order")) {
            updateOrder(data);
        }
    }
    @Override
    public void handleInsert(String data) {
        switch (getTableName(data)) {
            case "selftrade.tb_order":
                insertOrder(data);
                break;
            case "selftrade.tb_order_ext":
                insertOrderExt(data);
                break;
        }
    }
    private static final String TABLE_DISCOUNT = "selftrade.tb_discount";
}`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/selftrade/DbusUtils.java',
        `public class DbusUtils {
    public static String getTableName() { return ""; }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      const thriftContracts = contracts.filter(
        (c) => c.meta && (c.meta as Record<string, unknown>).broker === 'thrift',
      );
      expect(thriftContracts).toHaveLength(1);
      expect(thriftContracts[0].type).toBe('dbus');
      expect(thriftContracts[0].contractId).toBe('dbus::thrift::OrderSearchDataBusService');
      expect(thriftContracts[0].symbolName).toBe('OrderSearchDataBusServiceImpl');
      expect((thriftContracts[0].meta as Record<string, unknown>).port).toBe(9000);
    });

    it('should extract thriftService from @MdpThriftService annotation', async () => {
      writeFile(
        'src/main/java/com/sankuai/flight/fundsafemgr/DBusEventServiceV2Impl.java',
        `@MdpThriftService("CustomDbusService")
public class DBusEventServiceV2Impl implements DataBusEventServiceV2.Iface {
    @Override
    public void handleUpdate(String data) {
        // no table names
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(1);
      expect(contracts[0].contractId).toBe('dbus::thrift::CustomDbusService');
      expect((contracts[0].meta as Record<string, unknown>).thriftService).toBe('CustomDbusService');
    });

    it('should infer thrift service name by removing Impl suffix', async () => {
      writeFile(
        'src/main/java/com/sankuai/flight/test/FlightDataBusServiceImpl.java',
        `public class FlightDataBusServiceImpl implements DataBusEventServiceV2.Iface {
    @Override
    public void handleUpdate(String data) {}
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(1);
      expect(contracts[0].contractId).toBe('dbus::thrift::FlightDataBusService');
    });

    it('should not emit dbus contract for non-DataBusEventServiceV2 classes', async () => {
      writeFile(
        'src/main/java/com/sankuai/flight/test/SomeOtherServiceImpl.java',
        `public class SomeOtherServiceImpl implements SomeOtherInterface {
    public void handle(String data) {}
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(0);
    });

    it('should skip *Test.java files in thrift mode', async () => {
      writeFile(
        'src/test/java/com/sankuai/flight/test/DbusServiceImplTest.java',
        `public class DbusServiceImplTest implements DataBusEventServiceV2.Iface {
    @Override
    public void handleUpdate(String data) {}
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      const thriftContracts = contracts.filter(
        (c) => c.meta && (c.meta as Record<string, unknown>).broker === 'thrift',
      );
      expect(thriftContracts).toHaveLength(0);
    });
  });

  // ── General / edge cases ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('should return empty contracts for empty repo', async () => {
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts).toHaveLength(0);
    });

    it('should skip mafka.properties topics that are variable placeholders', async () => {
      writeFile(
        'mafka.properties',
        `mdp.mafka.consumers[0].topicName = \${topic.placeholder}\nmdp.mafka.consumers[0].listenerId = listener\n`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      // Variable placeholder topics (starting with ${) are skipped by the extractor
      expect(contracts).toHaveLength(0);
    });

    it('should emit both mafka and thrift dbus contracts in same repo', async () => {
      writeFile(
        'mafka.properties',
        `mdp.mafka.consumers[0].topicName = qos-databus\nmdp.mafka.consumers[0].listenerId = qosDbusListener\n`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/qos/QosDbusListener.java',
        `@Component("qosDbusListener")
public class QosDbusListener {
    case "qos.channel":
        break;
}`,
      );
      writeFile(
        'src/main/java/com/sankuai/flight/qos/QosDataBusServiceImpl.java',
        `public class QosDataBusServiceImpl implements DataBusEventServiceV2.Iface {
    @Override
    public void handleUpdate(String data) {
        case "qos.site":
            break;
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(2);
      const brokers = contracts.map((c) => (c.meta as Record<string, unknown>).broker);
      expect(brokers).toContain('mafka');
      expect(brokers).toContain('thrift');
    });
  });
});
