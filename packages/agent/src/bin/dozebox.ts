// `dozebox` on the box (bin): `dozebox hold ...` and `dozebox wake-request ...` through the admin socket (A2 shim).
import { shimMain } from "../protocol/shim.ts";

process.exitCode = await shimMain(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  now: Date.now,
});
