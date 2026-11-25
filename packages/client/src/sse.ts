// P2: a Server-Sent Events line parser (WHATWG rules: CR, LF and CRLF line ends, `:` comments, multi-line data).
export type SseMessage = { readonly id: string | undefined; readonly event: string; readonly data: string };

export function makeSseParser(onMessage: (m: SseMessage) => void): { readonly feed: (chunk: string) => void } {
  let pending = "";
  let id: string | undefined;
  let event = "";
  let data: string[] = [];

  const line = (text: string): void => {
    if (text === "") {
      if (data.length > 0) onMessage({ id, event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
  };

  return {
    feed(chunk) {
      pending += chunk;
      const held = pending.endsWith("\r") ? "\r" : "";
      const complete = held ? pending.slice(0, -1) : pending;
      const parts = complete.split(/\r\n|\r|\n/);
      pending = (parts.pop() ?? "") + held;
      for (const part of parts) line(part);
    },
  };
}
