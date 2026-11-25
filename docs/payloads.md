# Payloads

A payload is the program a box exists to run. You describe it in a JSON payload definition. The runner reads the
definition and knows nothing else about your program. The schema is `PayloadDefinition` in `@dozebox/protocol`, and
Terraform passes each definition to the box through the `payloads` input.

The box agent that installs, starts and watches payloads is planned. The definition format, its schema and the
Terraform input are built.

## A definition

`examples/payloads/marker.json` is the smallest useful one. It runs a small web server and lets the agent check
`/health`:

```json
{
  "schema": 1,
  "name": "marker",
  "user": "marker",
  "protocol": "none",
  "start": {
    "command": ["/usr/bin/node", "/opt/marker/server.mjs"],
    "env": { "MARKER_DIR": "/data/payloads/marker" }
  },
  "health": {
    "http": { "url": "http://127.0.0.1:8080/health", "expectStatus": 200 },
    "startPeriodSeconds": 30
  }
}
```

Pass it to the module with `payloads = { marker = jsondecode(file("${path.module}/marker.json")) }`. Use the
definition's `name` as the map key. A box takes 1 to 4 payloads. Commands are argument lists, not shell strings: run a
shell by naming it (`["/bin/sh", "-c", "..."]`).

| Field      | Required | What it does                                                                                             |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `schema`   | yes      | Always `1`.                                                                                              |
| `name`     | yes      | Lower case letters, digits and `-`, starting with a letter, at most 31 characters.                       |
| `user`     | yes      | The Linux user the payload runs as. Created if missing. Never `root`.                                    |
| `protocol` | yes      | `v1` if the payload speaks the [protocol](./protocol/v1.md); `none` for health-only mode.                |
| `install`  | no       | A command to prepare the machine, and `when` to run it: `every-boot`, `once` per volume, or `on-change`. |
| `start`    | yes      | The command, working directory, environment and `stopGraceSeconds` (5 to 600).                           |
| `health`   | no       | An HTTP check on `127.0.0.1`, or a command, with a timeout and a start period.                           |
| `activity` | no       | What counts as use in health-only mode: a CPU percentage and TCP ports.                                  |
| `limits`   | no       | The longest hold (`holdMaxSeconds`), `memoryMax` and `cpuWeight`.                                        |
| `data`     | no       | Paths that matter for restores, and hooks that run before and after a snapshot and after a restore.      |
| `secrets`  | no       | Names of shared secrets, delivered as a `0600` file or an environment variable.                          |
| `jail`     | no       | Read-only, writable and hidden paths for agents the payload launches.                                    |
| `ports`    | no       | Ports the payload listens on that the network must open.                                                 |

Field-level limits are in the [payload definition schema](../packages/protocol/schema/v1/). Unknown fields are
rejected.

## Secrets

A secret is a SecureString under `/<prefix>/shared/`. Set it from standard input so the value never reaches your shell
history or `ps`, then name it in the definition:

```bash
printf %s "$TOKEN" | dozebox secrets set claude-oauth-token
dozebox secrets list
```

```json
{ "secrets": [{ "name": "claude-oauth-token", "as": { "env": "CLAUDE_CODE_OAUTH_TOKEN" } }] }
```

Terraform never takes a secret value. Inputs such as `alerts.ntfy_secret` take the secret's name.

## Health-only mode

Set `"protocol": "none"` for a program that knows nothing about Dozebox, such as a web server or an agent CLI
([decision 0007](./decisions/0007-health-only-mode.md)). The agent decides activity from outside:

- the health check passes (this also decides restarts and parks, after repeated failures);
- CPU use of the payload's cgroup stays above `activity.cpuPercent`;
- a TCP connection exists to one of `activity.tcpPorts`;
- a person is logged in over SSH.

Terminal output does not count: keepalive traffic would hold the box open for ever. For a command that should hold
the box while it runs, start it through `dozebox run`, which keeps a hold open, beats on output and alerts when the
command fails:

```json
{ "start": { "command": ["/usr/bin/dozebox", "run", "--reason", "agent session", "--", "/usr/local/bin/my-agent"] } }
```

## Protocol mode

Set `"protocol": "v1"` and the payload tells the box what it needs. Each payload gets its own Unix socket, named in
`DOZEBOX_SOCKET`; the socket is the payload's identity ([decision 0006](./decisions/0006-socket-per-payload.md)).

| Need                              | Protocol call           | Box command                      |
| --------------------------------- | ----------------------- | -------------------------------- |
| Stay awake until a time           | `PUT /v1/holds/{id}`    | `dozebox hold <id> --for 2h`     |
| Say work moved forward            | `POST /v1/beats`        | `dozebox beat <name>`            |
| Be woken at a time or by an event | `PUT /v1/wakes/{id}`    | `dozebox wake <id> --at <time>`  |
| Say a person is here              | `PUT /v1/presence/{id}` | `dozebox presence <id> --for 5m` |
| Tell a human                      | `POST /v1/attention`    | `dozebox attention <key> ...`    |
| Ask the box to sleep now          | `POST /v1/sleep`        | `dozebox sleep`                  |
| Read phase, disk and idle verdict | `GET /v1/status`        | `dozebox status`                 |

The box commands work from a shell on the box and from payloads in any language. Their flags are in the
[CLI reference](./reference/cli.md#box-commands). The calls, bodies and limits are in the
[protocol reference](./reference/protocol-v1.md).

## `@dozebox/client`

A Node payload can use the typed client instead of raw HTTP. It has no dependencies besides `@dozebox/protocol` and
reads `DOZEBOX_SOCKET` by default. `createClient()` returns `null` when it does not run on a box, so the same code
works on a laptop.

```ts
import { createClient } from "@dozebox/client";

const box = createClient();
const hold = box?.keepHold("build-42", { reason: "building", forSeconds: 600 });
try {
  await build();
  await box?.beat([{ kind: "progress", name: "build" }]);
} catch (error) {
  await box?.attention({ key: "build-failed", severity: "notify", title: "Build failed", body: String(error) });
  throw error;
} finally {
  await hold?.stop();
}
```

`keepHold` renews the hold on an interval until `stop()`, so a crashed payload lets the hold lapse and the box can
sleep. Other methods: `hello`, `status`, `hold`, `release`, `wake`, `cancelWake`, `presence`, `sleep` and `events`
(server-sent events with reconnect).

Planned: the client's methods are typed but `createClient` is not implemented yet. Until it is, use the box commands
or call the socket directly.

## Check a definition

Terraform checks only the payload names and the count. The agent validates each definition against the schema when
it boots and rejects a bad one with the field named. Checking a definition before you deploy, with `dozebox doctor`,
is planned. Until then, validate it against `packages/protocol/schema/v1/payload-definition.json` with any JSON Schema
tool.
