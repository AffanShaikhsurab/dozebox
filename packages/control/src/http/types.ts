// What a route gets: every dependency, but Compute only as a reader. A route can describe machines for the status it
// returns and can never start, stop or raise one (R1, SIM-F5: requests write desired state; the tick acts).
import type { Deps } from "../deps.ts";
import type { ComputeReader } from "../status/build.ts";
import type { FunctionUrlResult, Request } from "./event.ts";

export type HttpDeps = Omit<Deps, "compute"> & { readonly compute: ComputeReader };

export type Route = (deps: HttpDeps, req: Request) => Promise<FunctionUrlResult>;

/** Only the reads of Compute, as a new object, so a route cannot reach the actions through the same reference. */
export function readOnly(deps: Deps): HttpDeps {
  const { describePersistent, describeGroup } = deps.compute;
  return { ...deps, compute: { describePersistent, describeGroup } };
}
