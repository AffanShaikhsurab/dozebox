// FakeAws Auto Scaling: a min 0 / max 1 group. Raising it launches a machine; lowering it terminates it.
import type { Compute, MachineView } from "@dozebox/control/ports/compute";
import type { FakeEc2 } from "./ec2.ts";
import { awsError, type Faults } from "./world.ts";

export type FakeAsg = {
  readonly compute: Pick<Compute, "describeGroup" | "setGroupDesired">;
  readonly addGroup: (
    name: string,
    opts: { readonly boxId: string; readonly lifecycle?: "spot" | "on-demand" },
  ) => void;
  /** With false, raising the group records a failed activity and launches nothing (no capacity in the AZ). */
  readonly setCapacity: (available: boolean) => void;
  readonly calls: ReadonlyArray<{ readonly name: string; readonly desired: 0 | 1; readonly token: string }>;
};

type Group = {
  desired: 0 | 1;
  readonly boxId: string;
  readonly lifecycle: "spot" | "on-demand";
  readonly machines: string[];
};

export function makeFakeAsg(deps: { readonly faults: Faults; readonly ec2: FakeEc2 }): FakeAsg {
  const { faults, ec2 } = deps;
  const groups = new Map<string, Group>();
  const calls: Array<{ name: string; desired: 0 | 1; token: string }> = [];
  let capacity = true;

  const get = (name: string): Group => {
    const g = groups.get(name);
    if (!g) throw awsError("ResourceNotFoundException", `Auto Scaling group '${name}' not found.`);
    return g;
  };

  return {
    compute: {
      describeGroup: async (name) => {
        faults.check("asg.describe");
        const g = get(name);
        const machines = g.machines
          .map((id) => ec2.staleView(id))
          .filter((v): v is MachineView => v !== null && v.state !== "terminated");
        return { desired: g.desired, machines };
      },
      setGroupDesired: async (name, desired, token) => {
        faults.check("asg.setDesired");
        const g = get(name);
        calls.push({ name, desired, token });
        g.desired = desired;
        const live = g.machines.filter((id) => {
          const s = ec2.machine(id)?.state;
          return s !== "terminated" && s !== "shutting-down";
        });
        if (desired === 1 && live.length === 0 && capacity) {
          g.machines.push(ec2.launch({ boxId: g.boxId, role: "group", lifecycle: g.lifecycle }));
        }
        if (desired === 0) for (const id of live) ec2.terminate(id);
      },
    },
    addGroup: (name, opts) => {
      groups.set(name, { desired: 0, boxId: opts.boxId, lifecycle: opts.lifecycle ?? "on-demand", machines: [] });
    },
    setCapacity: (available) => {
      capacity = available;
    },
    calls,
  };
}
