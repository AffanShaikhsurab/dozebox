// D1: On-Demand Linux price per hour from the Price List API, cached per UTC day; a built-in table when the lookup
// fails (the estimate gates a drill, so a lookup error must not stop it).
import type { Clock } from "@dozebox/core/time";
import type { AwsCli } from "../ports/awscli.ts";
import type { CliFiles } from "../ports/terraform.ts";

/** us-east-1 On-Demand Linux, USD per hour. */
const BUILT_IN: Readonly<Record<string, number>> = { "t4g.small": 0.0168, "t4g.medium": 0.0336, "t4g.large": 0.0672 };
/** For a type the table does not know: high enough that the budget gate stays on the safe side. */
const UNKNOWN_TYPE_USD = 0.5;

type Cache = { readonly day: string; readonly prices: Readonly<Record<string, number>> };

export type PriceLookup = ((region: string, type: string) => Promise<number>) & {
  /** `region/type` keys answered from the built-in table because the lookup failed. */
  readonly fallbacks: string[];
};

const filters = (region: string, type: string): ReadonlyArray<string> => [
  `Type=TERM_MATCH,Field=instanceType,Value=${type}`,
  `Type=TERM_MATCH,Field=regionCode,Value=${region}`,
  "Type=TERM_MATCH,Field=operatingSystem,Value=Linux",
  "Type=TERM_MATCH,Field=tenancy,Value=Shared",
  "Type=TERM_MATCH,Field=preInstalledSw,Value=NA",
  "Type=TERM_MATCH,Field=capacitystatus,Value=Used",
];

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Pure: the hourly USD in a `get-products` answer (PriceList holds JSON strings), or null. */
export function parsePriceList(answer: unknown): number | null {
  const list = record(answer)?.["PriceList"];
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    let product: unknown = item;
    if (typeof item === "string") {
      try {
        product = JSON.parse(item);
      } catch {
        continue;
      }
    }
    const onDemand = record(record(record(product)?.["terms"])?.["OnDemand"]);
    for (const offer of Object.values(onDemand ?? {})) {
      for (const dim of Object.values(record(record(offer)?.["priceDimensions"]) ?? {})) {
        const usd = Number(record(record(dim)?.["pricePerUnit"])?.["USD"]);
        if (Number.isFinite(usd) && usd > 0) return usd;
      }
    }
  }
  return null;
}

async function readCache(fs: CliFiles, file: string, day: string): Promise<Record<string, number>> {
  try {
    const text = await fs.readText(file);
    const parsed = text === null ? null : (JSON.parse(text) as Partial<Cache>);
    if (parsed?.day === day && typeof parsed.prices === "object" && parsed.prices !== null) return { ...parsed.prices };
  } catch {
    // an unreadable cache is an empty one
  }
  return {};
}

export function makePriceLookup(deps: {
  readonly awsCli: AwsCli;
  readonly fs: CliFiles;
  readonly clock: Clock;
  readonly cacheFile: string;
}): PriceLookup {
  const fallbacks: string[] = [];
  const price = async (region: string, type: string): Promise<number> => {
    const key = `${region}/${type}`;
    const day = new Date(deps.clock.now()).toISOString().slice(0, 10);
    const cached = await readCache(deps.fs, deps.cacheFile, day);
    const hit = cached[key];
    if (hit !== undefined) return hit;
    try {
      const answer = await deps.awsCli.json([
        "pricing",
        "get-products",
        "--region",
        "us-east-1",
        "--service-code",
        "AmazonEC2",
        "--filters",
        ...filters(region, type),
      ]);
      const usd = parsePriceList(answer);
      if (usd === null) throw new Error(`no On-Demand price in the answer for ${key}`);
      cached[key] = usd;
      await deps.fs
        .writeText(deps.cacheFile, `${JSON.stringify({ day, prices: cached }, null, 2)}\n`)
        .catch(() => undefined);
      return usd;
    } catch {
      fallbacks.push(key);
      return BUILT_IN[type] ?? UNKNOWN_TYPE_USD;
    }
  };
  return Object.assign(price, { fallbacks });
}
