// The payload process as the agent sees it: starts in 3 to 4 s, answers its health check, can crash or hang (for a
// while, or until restarted when not `sticky`), and stops in 8 to 15 s on SIGTERM.
import { MEASURED as M } from "../measured.ts";
import { pause, type Proc } from "../world/clock.ts";
import type { World } from "../world/world.ts";

type State = "starting" | "healthy" | "stopping" | "dead";

export class Server {
  private state: State = "dead";
  private gen = 0;
  private hung: { readonly until: number; readonly sticky: boolean; readonly gen: number } | null = null;
  private readonly w: World;
  private readonly log: (m: string) => void;

  constructor(w: World, log: (m: string) => void) {
    this.w = w;
    this.log = log;
  }

  /** Starts a new generation; returns its number. */
  start(): number {
    const gen = (this.gen += 1);
    this.state = "starting";
    this.w.at(
      this.w.draw(M.serverStartMs),
      () => {
        if (this.gen !== gen || this.state !== "starting") return;
        this.state = "healthy";
        this.log("payload answers");
      },
      "server-up",
    );
    return gen;
  }

  healthy(): boolean {
    if (this.state !== "healthy") return false;
    const h = this.hung;
    return !(h !== null && this.w.now < h.until && (h.sticky || h.gen === this.gen));
  }

  exited(gen: number): boolean {
    return this.gen !== gen || this.state === "dead";
  }

  crash(): void {
    if (this.state === "dead") return;
    this.state = "dead";
    this.log("payload crashed");
  }

  hang(ms: number, sticky: boolean): void {
    this.hung = { until: this.w.now + ms, sticky, gen: this.gen };
    this.log(`payload hangs for ${Math.round(ms / 60_000)} min${sticky ? " (sticky)" : ""}`);
  }

  *stop(): Proc {
    if (this.state === "dead") return;
    if (this.state !== "stopping") this.state = "stopping";
    yield* pause(this.w.draw(M.serverStopMs));
    this.state = "dead";
  }
}
