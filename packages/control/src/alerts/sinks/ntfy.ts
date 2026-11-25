// C4: ntfy (priorities 1 to 5, Title/Priority/Tags/Click headers; the topic URL is a secret).
import type { AlertSeverity, AlertSinkMaker } from "../../ports/alertSink.ts";

export type NtfyConfig = { readonly urlSecret: string; readonly minSeverity?: AlertSeverity };

export const ntfySink: AlertSinkMaker<NtfyConfig> = () => {
  throw new Error("not implemented: C4 ntfySink");
};
