// redact: credential shapes, ARNs, account ids, e-mail, home paths, control characters; ordinary text stays.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redact } from "../src/alerts/index.ts";

const R = "[redacted]";
const gh = "A".repeat(36);
const secret40 = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
// Built at run time so secret scanners do not flag a made-up token in the source.
const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTYifQ", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".");

const rows: ReadonlyArray<readonly [string, string, string]> = [
  ["github ghp", `token ghp_${gh} end`, `token ${R} end`],
  ["github gho", `gho_${gh}`, R],
  ["github ghu", `ghu_${gh}`, R],
  ["github ghs", `ghs_${gh}`, R],
  ["github ghr", `ghr_${gh}`, R],
  ["github fine-grained", `github_pat_11ABCDEFG0abcdefghijkl_${gh}`, R],
  ["slack bot", "xoxb-1234567890-abcdefghij", R],
  ["slack user", "xoxp-123456789012-abcdefghijkl", R],
  ["openai style", "key sk-abcdefghijklmnopqrstuvwx", `key ${R}`],
  ["anthropic style", "sk-ant-api03-abcdefghijklmnopqrstuv", R],
  ["aws access key id", "id AKIAIOSFODNN7EXAMPLE here", `id ${R} here`],
  ["aws temporary key id", "ASIAIOSFODNN7EXAMPLE", R],
  ["aws secret =", `aws_secret_access_key=${secret40}`, `aws_secret_access_key=${R}`],
  ["aws secret :", `secret: ${secret40}`, `secret: ${R}`],
  ["bearer", "Authorization: Bearer abc.def-123_456", `Authorization: Bearer ${R}`],
  ["jwt", `jwt ${jwt} done`, `jwt ${R} done`],
  ["arn", "role arn:aws:iam::123456789012:role/box-1 failed", `role ${R} failed`],
  ["arn gov", "arn:aws-us-gov:s3:::bucket/key", R],
  ["account id", "account 123456789012 is over quota", `account ${R} is over quota`],
  ["account id then dot", "account 123456789012.", `account ${R}.`],
  ["email", "mail me at jane.doe+x@example.co.uk now", `mail me at ${R} now`],
  ["home path", "open /home/ubuntu/work/app.log", `open /home/${R}/work/app.log`],
  ["root path", "cat /root/.ssh/config", `cat /home/${R}/.ssh/config`],
  ["control characters", "a\u0000b\u001b[31mc\rd", "ab[31mcd"],
  ["newline and tab stay", "a\nb\tc", "a\nb\tc"],
  ["ordinary sentence", "The disk is 91% full on the data volume.", "The disk is 91% full on the data volume."],
  ["short number", "port 8080 and 12345678901", "port 8080 and 12345678901"],
  ["13-digit number", "id 1234567890123", "id 1234567890123"],
  ["arnold", "arnold arrived", "arnold arrived"],
  ["short sk", "sk-short", "sk-short"],
  ["word ending in sk", "risk-assessment-of-the-whole-deployment", "risk-assessment-of-the-whole-deployment"],
  ["not a home path", "/homework/root/rooted", "/homework/root/rooted"],
  ["at sign without domain", "ping @here", "ping @here"],
];

test("redact: table", () => {
  for (const [name, input, want] of rows) assert.equal(redact(input), want, name);
  assert.ok(rows.length >= 20);
});

test("redact: idempotent", () => {
  for (const [, input] of rows) assert.equal(redact(redact(input)), redact(input));
});
