// The spot drill's stand-in for a reclaim notice. The test account's user cannot use FIS, so the box's own IMDS URL
// (`DOZEBOX_IMDS_URL`) is pointed at a small proxy that forwards everything to the real IMDS except
// `spot/instance-action`, which always answers a stop in two minutes. Everything runs as transient systemd state and
// disappears when the instance stops (/run is a tmpfs).
const PROXY_UNIT = "dozebox-drill-imds";
const PROXY_URL = "http://127.0.0.1:1338";
const SCRIPT_PATH = "/run/dozebox-drill-imds.mjs";
const DROP_IN_DIR = "/run/systemd/system/dozeboxd.service.d";
const DROP_IN = `${DROP_IN_DIR}/drill-imds.conf`;
const NODE = "/opt/dozebox/current/node/bin/node";

const PROXY_JS = `import http from "node:http";
const NOTICE = "/latest/meta-data/spot/instance-action";
http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === NOTICE) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ action: "stop", time: new Date(Date.now() + 120000).toISOString() }));
      return;
    }
    const up = http.request(
      { host: "169.254.169.254", port: 80, method: req.method, path: req.url, headers: { ...req.headers, host: "169.254.169.254" } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  })
  .listen(1338, "127.0.0.1");
`;

/** Starts the proxy, checks it answers the notice, points dozeboxd at it and restarts dozeboxd. Prints PROXY_OK once the proxy answers. */
export const installScript = (): string =>
  [
    "set -eu",
    `cat > ${SCRIPT_PATH} <<'DRILL_PROXY_EOF'`,
    PROXY_JS.trimEnd(),
    "DRILL_PROXY_EOF",
    `systemd-run --unit ${PROXY_UNIT} --collect ${NODE} ${SCRIPT_PATH}`,
    "code=000",
    "for i in 1 2 3 4 5 6 7 8 9 10; do",
    `  code=$(curl -s -o /dev/null -w '%{http_code}' ${PROXY_URL}/latest/meta-data/spot/instance-action || true)`,
    '  [ "$code" = 200 ] && break',
    "  sleep 1",
    "done",
    'test "$code" = 200',
    "echo PROXY_OK",
    `mkdir -p ${DROP_IN_DIR}`,
    `printf '[Service]\\nEnvironment=DOZEBOX_IMDS_URL=${PROXY_URL}\\n' > ${DROP_IN}`,
    "systemctl daemon-reload",
    "systemctl restart dozeboxd",
  ].join("\n");

/** Removes the drop-in and the proxy; the next dozeboxd start reads the real IMDS again. */
export const removeScript = (): string =>
  [
    `rm -f ${DROP_IN} ${SCRIPT_PATH}`,
    `systemctl stop ${PROXY_UNIT} || true`,
    "systemctl daemon-reload",
    "echo CLEANED",
  ].join("\n");
