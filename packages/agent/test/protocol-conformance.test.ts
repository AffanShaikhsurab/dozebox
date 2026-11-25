// The shared protocol server conformance suite, run against the agent's real routes.
import { protocolServerSuite, type ProtocolHarness } from "@dozebox/testkit/contracts";
import { setup } from "./protocol-support.ts";

protocolServerSuite(async (): Promise<ProtocolHarness> => {
  const { t, call } = await setup();
  return {
    call,
    advance: (ms) => {
      t.now += ms;
    },
    setAccepting: (accepting) => {
      t.accepting = accepting;
    },
    setSleepAnswer: (answer) => {
      t.sleepAnswer = { accepted: answer.accepted, blockers: [...answer.blockers] };
    },
    sent: t.sent,
    sleeps: t.sleeps,
  };
}, "agent protocol routes");
