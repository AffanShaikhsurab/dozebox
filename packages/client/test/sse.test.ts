import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeSseParser, type SseMessage } from "../src/sse.ts";

function parse(...chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const parser = makeSseParser((m) => out.push(m));
  for (const c of chunks) parser.feed(c);
  return out;
}

test("an event with id, name and data", () => {
  assert.deepEqual(parse('id: boot-1:7\nevent: phase\ndata: {"a":1}\n\n'), [
    { id: "boot-1:7", event: "phase", data: '{"a":1}' },
  ]);
});

test("chunks may split lines, CRLF and CR line ends are accepted, comments are skipped", () => {
  const got = parse(": hi\r\nid: 1\r\nev", "ent: sleeping\r", "\ndata: x\r\rdata: y\n\n");
  assert.deepEqual(got, [
    { id: "1", event: "sleeping", data: "x" },
    { id: "1", event: "message", data: "y" },
  ]);
});

test("multi-line data joins with a newline and blocks without data dispatch nothing", () => {
  assert.deepEqual(parse("data: a\ndata: b\n\nevent: x\n\n"), [{ id: undefined, event: "message", data: "a\nb" }]);
});
