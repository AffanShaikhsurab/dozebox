// Placeholder control function. The module deploys it until control_bundle_path names a real bundle
// (dist/control.mjs of @dozebox/control, zipped). It changes nothing: HTTP calls get 503 not_deployed, and every
// other event (reconcile tick, EC2 events) is logged and dropped.
export const handler = async (event) => {
  const http = typeof event === "object" && event !== null && "requestContext" in event;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      msg: "placeholder control function, no bundle deployed",
      component: "control",
      box: process.env.DOZEBOX_BOX_ID ?? "",
      route: http ? "http" : "event",
    }),
  );
  if (!http) return { ok: false, error: "not_deployed" };
  return {
    statusCode: 503,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: { code: "not_deployed" } }),
  };
};
