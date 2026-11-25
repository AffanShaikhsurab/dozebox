# The AWS emulator for wire tests

`compose.yml` runs Floci 2.3.0 on `127.0.0.1:4566`. With it up, `pnpm test:wire` runs every port contract suite
against the real adapters (`packages/*/test/wire/`). Without it, the wire suites skip with the reason; set
`DOZEBOX_WIRE=required` (or `CI`) to make a missing emulator fail instead. `DOZEBOX_WIRE_ENDPOINT` (or
`DOZEBOX_EMULATOR_URL`) points them at another loopback port; `DOZEBOX_WIRE_AMI` sets the image id used to seed
instances.

## What the emulator does not model

These contract cases are skipped on the emulator (the `gaps` option of each wire test) and stay covered by FakeAws,
the recorded fixtures in `packages/testkit/fixtures/aws/` and the adapters' unit tests.

| Port         | Case key       | Gap                                                                                   |
| ------------ | -------------- | ------------------------------------------------------------------------------------- |
| `volumePort` | `createToken`  | CreateVolume ignores `ClientToken`: two calls, two volumes.                           |
| `volumePort` | `snapshots`    | No snapshots, so a missing snapshot is not refused.                                   |
| `volumePort` | `moveActive`   | CreateTags does not overwrite an existing tag value.                                  |
| all          | IAM conditions | The attach tag fence is not evaluated; the adapter checks it on a fresh read as well. |
| `ec2Port`    | Spot requests  | No Spot requests; the Spot states come from the fixtures.                             |
