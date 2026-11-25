# @dozebox/control

The control function: one AWS Lambda behind a Function URL, an EventBridge Scheduler tick and the EC2 event rule.

- `src/handler.ts` routes by event shape: Function URL requests go to the HTTP router, `{"dozebox":"reconcile","v":1}`
  runs one reconcile tick, `aws.ec2` events only write a record.
- HTTP API (`x-dozebox-token` header, plus the aliases in `DOZEBOX_CONTROL.http.tokenHeaders`):
  `GET /v1/status`, `POST /v1/wake` (optional `Idempotency-Key`), `POST /v1/park`, `POST /v1/alerts/test`. The
  unversioned paths are aliases. `/`, the manifest and the service worker are public. Bodies are
  `ControlStatus`, `ControlAnswer` and `ControlErrorBody` from `@dozebox/protocol/control`.
- Wake and park only write the desired state; the tick acts on it.
- `pnpm --filter @dozebox/control build` writes `dist/control.mjs` and the deterministic `dist/control.zip` for the
  module's `control_bundle_path`.
