// Every exported request, response, event, record and config type, in the order the docs list them.
import type { TSchema } from "typebox";
import { BoxConfig, OperatorConfig } from "./config/v1.ts";
import { ControlStatus } from "./control/v1.ts";
import { PayloadDefinition } from "./payload/v1.ts";
import {
  BootTimelineRecord,
  LastErrorRecord,
  LastWordsRecord,
  LivenessRecord,
  ServingRecord,
  SleepFence,
  WakesRecord,
} from "./records/v1.ts";
import {
  AttentionAccepted,
  AttentionInput,
  BeatsInput,
  CapReachedEvent,
  DiskEvent,
  ErrorBody,
  HealthInput,
  Hello,
  Hold,
  HoldClampedEvent,
  HoldInput,
  HoldList,
  PhaseEvent,
  PingEvent,
  Presence,
  PresenceInput,
  ReclaimNoticeEvent,
  SleepAccepted,
  SleepInput,
  SleepRefused,
  SleepingEvent,
  Status,
  Wake,
  WakeInput,
  WakeList,
} from "./v1/index.ts";

export type SchemaEntry = { readonly title: string; readonly group: string; readonly schema: TSchema };

export const SCHEMAS: ReadonlyArray<SchemaEntry> = [
  { title: "ErrorBody", group: "Payload protocol", schema: ErrorBody },
  { title: "Hello", group: "Payload protocol", schema: Hello },
  { title: "HoldInput", group: "Payload protocol", schema: HoldInput },
  { title: "Hold", group: "Payload protocol", schema: Hold },
  { title: "HoldList", group: "Payload protocol", schema: HoldList },
  { title: "BeatsInput", group: "Payload protocol", schema: BeatsInput },
  { title: "WakeInput", group: "Payload protocol", schema: WakeInput },
  { title: "Wake", group: "Payload protocol", schema: Wake },
  { title: "WakeList", group: "Payload protocol", schema: WakeList },
  { title: "PresenceInput", group: "Payload protocol", schema: PresenceInput },
  { title: "Presence", group: "Payload protocol", schema: Presence },
  { title: "AttentionInput", group: "Payload protocol", schema: AttentionInput },
  { title: "AttentionAccepted", group: "Payload protocol", schema: AttentionAccepted },
  { title: "Status", group: "Payload protocol", schema: Status },
  { title: "HealthInput", group: "Payload protocol", schema: HealthInput },
  { title: "SleepInput", group: "Payload protocol", schema: SleepInput },
  { title: "SleepAccepted", group: "Payload protocol", schema: SleepAccepted },
  { title: "SleepRefused", group: "Payload protocol", schema: SleepRefused },
  { title: "PhaseEvent", group: "Events", schema: PhaseEvent },
  { title: "ReclaimNoticeEvent", group: "Events", schema: ReclaimNoticeEvent },
  { title: "SleepingEvent", group: "Events", schema: SleepingEvent },
  { title: "DiskEvent", group: "Events", schema: DiskEvent },
  { title: "HoldClampedEvent", group: "Events", schema: HoldClampedEvent },
  { title: "CapReachedEvent", group: "Events", schema: CapReachedEvent },
  { title: "PingEvent", group: "Events", schema: PingEvent },
  { title: "LivenessRecord", group: "Records", schema: LivenessRecord },
  { title: "WakesRecord", group: "Records", schema: WakesRecord },
  { title: "LastWordsRecord", group: "Records", schema: LastWordsRecord },
  { title: "BootTimelineRecord", group: "Records", schema: BootTimelineRecord },
  { title: "LastErrorRecord", group: "Records", schema: LastErrorRecord },
  { title: "ServingRecord", group: "Records", schema: ServingRecord },
  { title: "SleepFence", group: "Records", schema: SleepFence },
  { title: "ControlStatus", group: "Control API", schema: ControlStatus },
  { title: "PayloadDefinition", group: "Payload definition", schema: PayloadDefinition },
  { title: "BoxConfig", group: "Config", schema: BoxConfig },
  { title: "OperatorConfig", group: "Config", schema: OperatorConfig },
];

export function schemaFileName(title: string): string {
  return `${title.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}.json`;
}

export const SCHEMA_ID_BASE = "https://dozebox.dev/schema/v1/";
