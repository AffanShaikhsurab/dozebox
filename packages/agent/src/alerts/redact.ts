const MARK = "[redacted]";

const isControl = (c: number): boolean => (c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f;

const stripControl = (text: string): string => {
  let out = "";
  for (let i = 0; i < text.length; i++) if (!isControl(text.charCodeAt(i))) out += text[i];
  return out;
};

type Rule = readonly [RegExp, string];

// Order matters: wider shapes (JWT, ARN, labelled secrets) go before the shapes they contain.
const RULES: ReadonlyArray<Rule> = [
  [/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, MARK],
  [/arn:aws[a-z-]*:\S+/g, MARK],
  [/(secret\w*["']?\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi, `$1${MARK}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${MARK}`],
  [/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, MARK],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, MARK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, MARK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MARK],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, MARK],
  [/(?<![\w-])\d{12}(?![\w-])/g, MARK],
  [/(?<![\w.-])\/root(?![\w-])/g, `/home/${MARK}`],
  [/(?<![\w.-])\/home\/(?!\[redacted\])[^\s/]+/g, `/home/${MARK}`],
];

/** Pure: replace tokens, keys, ARNs, account ids, e-mail addresses and home paths; drop control characters. */
export function redact(text: string): string {
  return RULES.reduce((acc, [re, to]) => acc.replace(re, to), stripControl(text));
}
