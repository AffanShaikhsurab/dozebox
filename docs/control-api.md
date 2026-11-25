# Control API

The control function serves a small HTTP API for clients that are not on the box: the CLI, the wake page and webhooks.
It is versioned in the path (`/v1/...`) and follows [Versioning](./protocol/v1.md#versioning). Field-level tables for
the bodies are in the [protocol reference](./reference/protocol-v1.md#control-api).

## Where it is

The base URL is the module output `control_url` (`terraform -chdir=.dozebox output control_url`).

| `front_door_enabled` | The URL is              | Who can call it                                                                       |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `true` (default)     | The Lambda Function URL | Callers that sign requests with AWS SigV4 (the CLI does). The token is also required. |
| `false`              | The Lambda Function URL | Anyone on the internet who has the token.                                             |

Planned: with the front door on, `control_url` becomes a CloudFront domain with a WAF rate rule
(`waf_rate_limit_per_5min`) in front of the Function URL, so browsers and webhooks reach the API without AWS
credentials. CloudFront and WAF are not built yet; the outputs `front_door_domain_name`, `front_door_distribution_id`
and `waf_web_acl_arn` are `null`.

## Authentication

Send the wake token in the `x-dozebox-token` header. It is a header because CloudFront's origin access control
replaces `Authorization`. Get the token with `dozebox token show` (it prints the wake link
`<control_url>/#t=<token>`) and replace it with `dozebox token rotate`.

- A missing, wrong or unconfigured token gets the same `401 unauthorized`, before any route lookup, so a caller
  learns nothing about which paths exist or what state the box is in.
- The comparison is constant time. The stored token is cached for 60 seconds, so a rotated token works for up to a
  minute after the old one stops.
- Webhook routes skip the token. Their signature is the authentication.
- Never put the token in a query string. The wake page reads it from the URL fragment, which browsers do not send.

## Routes

| Route                                                         | Auth       | Does                                                                                 |
| ------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `GET /v1/status`                                              | wake token | Returns the box's status.                                                            |
| `POST /v1/wake?origin=user\|auto`                             | wake token | Asks for the box to be awake. `user` is the default.                                 |
| `POST /v1/park?origin=user\|auto`                             | wake token | Asks for the box to be asleep.                                                       |
| `POST /v1/alerts/test`                                        | wake token | Sends one test alert through the alert topic. Body: `{"severity":"page"\|"notify"}`. |
| `POST /v1/hooks/github`                                       | HMAC       | A GitHub webhook that may wake the box.                                              |
| `POST /v1/hooks/generic/<topic>`                              | HMAC       | Any other system's signed event that may wake the box.                               |
| `GET /`, `/manifest.webmanifest`, `/sw.js`, `/icons/icon.svg` | none       | The wake page: status, wake and park buttons. It holds no secret.                    |

The unversioned paths `/status`, `/wake`, `/park` and `/alerts/test` are aliases kept for clients of the old API.
`OPTIONS` answers `204` with CORS headers for the wake page.

Planned, not served yet: `/v1/phone/subscribe`, `/v1/phone/receipt`, `/v1/phone/unsubscribe` (Web Push) and
`/v1/unfreeze`. `dozebox phone` stores its records in SSM today.

### Status

`GET /v1/status` returns `ControlStatus`: `state` (one of six, see [Concepts](./concepts.md#what-the-box-is-doing)),
`desired`, `frozen`, the instance, `servingSince`, `caps`, `alertPath`, `lastError`, `lastWords` and a `summary`
(`level`, `headline`, `detail`, `next`, `actions`) written for people. It carries no secrets, account id or IP
address.

### Wake and park

Both only record the wish. The reconcile tick (every minute) acts on it, so the answer arrives before the machine
moves. The `202` body is the status after the request plus `decision`:

- `accept`: the wish was written.
- `already-awake` (wake only): the box was already wanted awake and nothing was written.

A wake is judged in this order: frozen, already awake, the wake budget (`wake_budget.per_hour` and `per_day`), and the
breaker that pauses unattended (`origin=auto`) wakes after failed ones. A person's wake (`origin=user`) is not stopped
by the breaker. Park is always recorded, even when nothing runs, so an older wake cannot undo it.

Send an `Idempotency-Key` header (1 to 64 visible ASCII characters) and a repeated request within 24 hours returns
the first answer instead of acting again. The CLI sends one on every wake.

### Webhooks

A webhook writes a wake only when the box left a matching wake request (`dozebox wake <id> --github ...` on the box,
or `PUT /v1/wakes/{id}` from a payload). The answer is `202 {"v":1,"wake":true|false,"why":"..."}`. A bad signature is
`401`. The same delivery twice answers `wake:false, why:"duplicate"`. An accepted event goes through the same freeze,
budget and breaker checks as a wake. Enable the sources with `wake_sources`; the secret is the name of a SecureString
under `/<prefix>/shared/`.

| Source    | Signature                                                                                                                               | Dedupe key            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `github`  | `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the raw body                                                                        | `X-GitHub-Delivery`   |
| `generic` | `X-Dozebox-Signature-256: sha256=<hex>`, HMAC-SHA256 of `<timestamp>.<raw body>`, and `X-Dozebox-Timestamp` in seconds within 5 minutes | Topic and body digest |

The generic body is JSON of at most 64 KiB. Planned: the module does not hand `wake_sources` to the function yet, so
a stack deployed today has no active hook source.

### Limits

Every request body over 16 KiB gets `413 too_large`, checked before the route, so today GitHub payloads above 16 KiB
are refused. `POST /v1/alerts/test` sends at most one alert a minute and answers `429 rate_limited` after that.

## Errors

Every error has this body, with the code that matters to a program and a message for a person:

```json
{
  "error": {
    "code": "wake_budget",
    "message": "The wake budget is used up; try again later.",
    "retryable": true,
    "retryAfterSeconds": 600
  }
}
```

A `429` also carries `Retry-After`. Unknown codes should be handled by their HTTP status.

| Status | Code                 | Meaning                                                                      |
| ------ | -------------------- | ---------------------------------------------------------------------------- |
| 400    | `bad_request`        | A bad `origin`, `Idempotency-Key` or body.                                   |
| 401    | `unauthorized`       | No token, a wrong token, or a bad webhook signature.                         |
| 404    | `not_found`          | No such route or hook.                                                       |
| 405    | `method_not_allowed` | Wrong method; the `Allow` header names the right one.                        |
| 413    | `too_large`          | The body is over the limit.                                                  |
| 423    | `frozen`             | The kill switch froze the box. Run `dozebox unfreeze`.                       |
| 429    | `wake_budget`        | Too many wakes this hour or day. Retry after `retryAfterSeconds`.            |
| 429    | `wake_breaker`       | Unattended wakes are paused after failed wakes. A person's wake still works. |
| 429    | `rate_limited`       | Too many test alerts.                                                        |
| 500    | `internal`           | The control function failed. Safe to retry.                                  |

The CLI maps these to exit codes: `frozen` to 5, a budget `429` to 75, `401` to 5 with a hint to rotate the token,
and a `5xx` after retries to 4. See the [CLI reference](./reference/cli.md#exit-codes).

## Admin events

Operator actions that need IAM, not a token, go through `aws lambda invoke` on the control function, called by the CLI
with your credentials:

```json
{ "dozebox": "admin", "v": 1, "action": "park", "force": false, "reason": "operator" }
```

The actions are `park`, `operator-hold`, `status` (with `records`), `swap-volume` and `rebuild`. The CLI sends them for
`dozebox park`, `status --records`, `restore`, `move-az` and `rebuild`. Planned: the control function does not handle
admin events yet, so those commands fail against a real stack. The wake token cannot send them; that is the point.
