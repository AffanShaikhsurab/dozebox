/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-is-pure",
      severity: "error",
      from: { path: "^packages/core/src" },
      to: {
        path: "^node:(fs|child_process|net|http|https|os|dgram|worker_threads)|@aws-sdk|^packages/(agent|control|cli)",
      },
    },
    {
      name: "aws-sdk-only-in-adapters",
      severity: "error",
      from: { path: "^packages/", pathNot: "^packages/[^/]+/(src/adapters/aws|test/wire)/" },
      to: { path: "@aws-sdk/" },
    },
    {
      name: "agent-not-control",
      severity: "error",
      from: { path: "^packages/agent/src" },
      to: { path: "^packages/control/src" },
    },
    {
      name: "control-not-agent",
      severity: "error",
      from: { path: "^packages/control/src" },
      to: { path: "^packages/agent/src" },
    },
    {
      name: "no-test-code-in-prod",
      severity: "error",
      from: { path: "^packages/(?!sim/|testkit/)[^/]+/src" },
      to: { path: "^packages/(sim|testkit)" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "no-orphans",
      severity: "warn",
      from: { orphan: true, pathNot: "\\.(test|d)\\.ts$|(^|/)\\.[^/]+\\.(c?js|json)$|scripts/" },
      to: {},
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|legacy)/" },
    enhancedResolveOptions: { conditionNames: ["@dozebox/source", "import", "types", "default"] },
  },
};
