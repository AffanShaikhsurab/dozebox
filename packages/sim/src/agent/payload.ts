// The payload's side of the local protocol (part 4), as the agent sees it: holds, presence, beats and wake requests.
// In `health-only` mode the payload speaks none of it and the idle verdict runs on activity alone. S2 adds the
// protocol behaviour and the trace the protocol invariants read.
import type { IdleHold, IdlePresence } from "@dozebox/core/idle";
import type { Rng } from "../prng.ts";
import type { World } from "../world/world.ts";

export type PayloadHost = { readonly inst: { readonly id: string } };

export class PayloadModel {
  lastInteractiveAt: number | null = null;
  lastProgressAt: number | null = null;
  private readonly heldBy = new Map<string, IdleHold>();
  private readonly present = new Map<string, IdlePresence>();
  private readonly w: World;
  private readonly r: Rng;
  private running = false;

  constructor(w: World, r: Rng) {
    this.w = w;
    this.r = r;
  }

  start(_host: PayloadHost): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  reclaimNotice(): void {}

  holds(now: number): IdleHold[] {
    return [...this.heldBy.values()].filter((h) => h.until > now - this.w.cfg.idleMinutes * 60_000);
  }

  presence(): IdlePresence[] {
    return [...this.present.values()];
  }
}
