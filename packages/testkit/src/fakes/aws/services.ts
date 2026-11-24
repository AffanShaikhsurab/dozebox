// FakeAws SSM, DynamoDB, Budgets, SNS and CloudWatch Logs: the record store, the state table and the rest.
import type { BoxNotifier } from "@dozebox/agent/ports/notify";
import type { LogEvent, LogTransport } from "@dozebox/agent/ports/logs";
import type { Notice, Notifier } from "@dozebox/control/ports/notify";
import type { RecordStore, StoredRecord } from "@dozebox/control/ports/records";
import type { Spend } from "@dozebox/control/ports/spend";
import type { Lease, StateTable } from "@dozebox/control/ports/state";
import { assertFits, type Tier } from "@dozebox/core/records";
import { awsError, turn, type Faults, type Now } from "./world.ts";

// SSM Parameter Store

export type FakeSsm = {
  /** The record store for one box root, such as `/dozebox/box-1/`. */
  readonly store: (root: string) => RecordStore;
  /** Every parameter by full name, with its tier. */
  readonly parameters: () => ReadonlyMap<string, { readonly value: string; readonly tier: Tier }>;
};

export function makeFakeSsm(deps: { readonly clock: Now; readonly faults: Faults }): FakeSsm {
  const params = new Map<string, { value: string; tier: Tier; modifiedAt: number }>();
  return {
    store: (root) => {
      const full = (name: string) => `${root}${name}`;
      const stored = (name: string): StoredRecord | null => {
        const p = params.get(full(name));
        return p ? { name, value: p.value, modifiedAt: p.modifiedAt } : null;
      };
      return {
        readAll: async () => {
          deps.faults.check("ssm.get");
          return [...params.keys()]
            .filter((k) => k.startsWith(root))
            .toSorted()
            .map((k) => stored(k.slice(root.length)))
            .filter((r): r is StoredRecord => r !== null);
        },
        get: async (name) => {
          deps.faults.check("ssm.get");
          return stored(name);
        },
        put: async (name, value, { tier }) => {
          assertFits(name, value, tier);
          deps.faults.check("ssm.put");
          params.set(full(name), { value, tier, modifiedAt: deps.clock.now() });
        },
        delete: async (name) => {
          deps.faults.check("ssm.delete");
          params.delete(full(name));
        },
      };
    },
    parameters: () => new Map([...params].map(([k, p]) => [k, { value: p.value, tier: p.tier }])),
  };
}

// DynamoDB state table (one item per key, the same conditions the adapter sends)

const conditionFailed = () => awsError("ConditionalCheckFailedException", "The conditional request failed");

type Item = { holder?: string; expiresAt?: number; fencing?: number; value?: string; ttl?: number };

export type FakeDynamoDb = {
  readonly table: StateTable;
  readonly items: () => ReadonlyMap<string, Readonly<Item>>;
};

export function makeFakeDynamoDb(deps: { readonly clock: Now; readonly faults: Faults }): FakeDynamoDb {
  const items = new Map<string, Item>();
  const nowSeconds = () => Math.floor(deps.clock.now() / 1000);
  const live = (item: Item | undefined): item is Item =>
    item !== undefined && (item.ttl === undefined || item.ttl >= nowSeconds());

  const table: StateTable = {
    acquireLease: async (name, holder, ttlMs, now): Promise<Lease | null> => {
      await turn();
      deps.faults.check("dynamodb.write");
      const pk = `lease#${name}`;
      const item = items.get(pk);
      if (item && !((item.expiresAt ?? 0) < now || item.holder === holder)) return null;
      const token = (item?.fencing ?? 0) + 1;
      items.set(pk, { ...item, holder, expiresAt: now + ttlMs, fencing: token });
      return { holder, token, expiresAt: now + ttlMs };
    },
    putFenced: async (key, value, token) => {
      await turn();
      deps.faults.check("dynamodb.write");
      const pk = `kv#${key}`;
      const item = items.get(pk);
      if (item?.fencing !== undefined && item.fencing > token) throw conditionFailed();
      items.set(pk, { value: JSON.stringify(value), fencing: token });
    },
    putIfAbsent: async (key, value, ttlSeconds) => {
      await turn();
      deps.faults.check("dynamodb.write");
      const pk = `kv#${key}`;
      if (live(items.get(pk))) return "exists";
      items.set(pk, { value: JSON.stringify(value), ttl: nowSeconds() + ttlSeconds });
      return "written";
    },
    get: async (key) => {
      deps.faults.check("dynamodb.get");
      const item = items.get(`kv#${key}`);
      return live(item) && item.value !== undefined ? (JSON.parse(item.value) as unknown) : null;
    },
  };
  return { table, items: () => items };
}

// Budgets

export type FakeBudgets = {
  readonly spend: Spend;
  /** null: the budget has no calculated spend yet (a new account or a new month). */
  readonly setMonthToDate: (v: { readonly usd: number; readonly asOf: number } | null) => void;
};

export function makeFakeBudgets(deps: { readonly faults: Faults }): FakeBudgets {
  let current: { usd: number; asOf: number } | null = null;
  return {
    spend: {
      monthToDate: async () => {
        deps.faults.check("budgets.describe");
        return current;
      },
    },
    setMonthToDate: (v) => {
      current = v === null ? null : { ...v };
    },
  };
}

// SNS

export type FakeSns = {
  readonly notifier: Notifier & BoxNotifier;
  readonly published: ReadonlyArray<Notice & { readonly id: string }>;
};

export function makeFakeSns(deps: { readonly faults: Faults; readonly newId: () => string }): FakeSns {
  const published: Array<Notice & { id: string }> = [];
  return {
    notifier: {
      publish: async (notice) => {
        deps.faults.check("sns.publish");
        const id = deps.newId();
        published.push({ ...notice, id });
        return id;
      },
    },
    published,
  };
}

// CloudWatch Logs

export type FakeLogs = {
  readonly transport: LogTransport;
  readonly addGroup: (group: string) => void;
  readonly events: (group: string, stream: string) => ReadonlyArray<LogEvent>;
};

export function makeFakeLogs(deps: { readonly faults: Faults }): FakeLogs {
  const groups = new Map<string, Map<string, LogEvent[]>>();
  return {
    transport: {
      send: async (group, stream, events) => {
        deps.faults.check("logs.put");
        const streams = groups.get(group);
        if (!streams) throw awsError("ResourceNotFoundException", `The specified log group does not exist: ${group}`);
        const list = streams.get(stream) ?? [];
        streams.set(stream, list);
        list.push(...[...events].toSorted((a, b) => a.at - b.at));
        return events.length;
      },
    },
    addGroup: (group) => {
      if (!groups.has(group)) groups.set(group, new Map());
    },
    events: (group, stream) => groups.get(group)?.get(stream) ?? [],
  };
}
