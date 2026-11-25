// Placeholder with the final signature: the integration lead replaces this file with the real delivery of the agent
// release (`--deliver <tarball>`) to an instance through SSM.
import type { DrillContext } from "./types.ts";

/** Pushes the agent release to an instance that cannot download it (a fresh fallback instance); returns at once here. */
export async function deliverAgent(_ctx: DrillContext, _instanceId: string, _signal: AbortSignal): Promise<void> {}
