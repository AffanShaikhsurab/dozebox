// A3: render the `dozebox-payload@<name>.service` drop-in from a payload definition (pure; golden-tested).
import type { PayloadDefinition } from "@dozebox/protocol/payload";

export const PAYLOAD_TEMPLATE_UNIT = "dozebox-payload@.service";
export const DROPIN_DIR = "/etc/systemd/system";

export type RenderedUnit = {
  /** `dozebox-payload@<name>.service`. */
  readonly unit: string;
  /** Absolute path of the drop-in, `<DROPIN_DIR>/<unit>.d/10-dozebox.conf`. */
  readonly path: string;
  readonly text: string;
  /** sha256 of `text`, for change detection. */
  readonly hash: string;
};

export type RenderOptions = {
  /** Per-payload protocol socket, exported as DOZEBOX_SOCKET. */
  readonly socketPath: string;
  /** `LoadCredential=` names, from `writeCredentials`. */
  readonly credentials: ReadonlyArray<string>;
  /** The jail wrapper argv prefix (A8) when the jail is on, else empty. */
  readonly execPrefix: ReadonlyArray<string>;
};

export function renderUnit(_def: PayloadDefinition, _opts: RenderOptions): RenderedUnit {
  throw new Error("not implemented: A3 renderUnit");
}
