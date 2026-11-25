// Shape one operator notice into what an SNS topic accepts, for the control function's and the box's SNS adapters.
// SNS rules (Publish API): the subject is ASCII without line breaks or control characters, under 100 characters,
// starting with a letter, digit or punctuation; the message is non-empty and, with its attributes, at most 256 KiB
// (262,144 bytes); at most 10 message attributes, each name 1-256 of [A-Za-z0-9_.-], no leading `AWS.`/`Amazon.`,
// no leading, trailing or doubled period. The subject is trimmed, never refused for its characters (a title with an
// emoji must still page). The body is cut at the byte limit with a marker. A bad attribute is a caller bug: refused.
import { RunnerError } from "./errors.ts";

export type NoticeInput = {
  readonly subject: string;
  readonly body: string;
  readonly attributes?: Readonly<Record<string, string>>;
};

export type ShapedNotice = {
  /** Absent when nothing printable was left (SNS then uses its default subject). */
  readonly subject?: string;
  readonly message: string;
  readonly attributes: Readonly<Record<string, string>>;
};

const SNS_SUBJECT_MAX = 99;
const SNS_MESSAGE_MAX_BYTES = 262_144;
const MAX_ATTRIBUTES = 10;
const TRUNCATED = "\n[truncated]";
const ATTRIBUTE_NAME = /^(?!aws\.|amazon\.)(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9_.-]{1,256}$/i;

const utf8 = new TextEncoder();
const bytes = (s: string): number => utf8.encode(s).length;

/** ASCII only (accents folded, the rest dropped), one line, at most 99 characters. */
function snsSubject(subject: string): string | undefined {
  const ascii = subject
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (ascii === "") return undefined;
  return ascii.length <= SNS_SUBJECT_MAX ? ascii : `${ascii.slice(0, SNS_SUBJECT_MAX - 3).trimEnd()}...`;
}

/** The longest prefix of `text` that is at most `max` UTF-8 bytes, never splitting a character. */
function cutToBytes(text: string, max: number): string {
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const size = bytes(ch);
    if (used + size > max) break;
    used += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

export function shapeSnsNotice(notice: NoticeInput): ShapedNotice {
  const attributes = notice.attributes ?? {};
  const entries = Object.entries(attributes);
  if (entries.length > MAX_ATTRIBUTES) {
    throw new RunnerError("invalid_input", false, `${entries.length} message attributes; SNS takes ${MAX_ATTRIBUTES}`);
  }
  let attributeBytes = 0;
  for (const [name, value] of entries) {
    if (!ATTRIBUTE_NAME.test(name)) throw new RunnerError("invalid_input", false, `"${name}" is not an attribute name`);
    if (value === "") throw new RunnerError("invalid_input", false, `attribute "${name}" is empty`);
    attributeBytes += bytes(name) + bytes("String") + bytes(value);
  }
  const subject = snsSubject(notice.subject);
  const room = SNS_MESSAGE_MAX_BYTES - attributeBytes;
  const body = notice.body === "" ? (subject ?? "(no message)") : notice.body;
  const message = bytes(body) <= room ? body : `${cutToBytes(body, room - bytes(TRUNCATED))}${TRUNCATED}`;
  return { ...(subject === undefined ? {} : { subject }), message, attributes };
}
