// Production entrypoint for the Next.js standalone server.
//
// Node's HTTP server defaults (since Node 18) include a 5-minute `requestTimeout`
// and a 60s `headersTimeout`. A long code-generation request streams for many
// minutes (slow free models can run 20-40 min), and these defaults were CUTTING
// the request mid-stream in production — the recurring symptom of "frontend
// generated but backend missing" and the UI stuck on "Generating…". Locally
// (`next dev`) there is no such limit, which is why it only reproduced in prod.
//
// We monkeypatch http.createServer (which the standalone server.js calls) to
// disable those timeouts before requiring it, so a streaming generation can run
// to completion. `keepAliveTimeout` is kept generous for proxied keep-alive.
const http = require("http");

const orig = http.createServer.bind(http);
http.createServer = (...args) => {
  const server = orig(...args);
  server.requestTimeout = 0; // no limit (default 300000ms cut long generations)
  server.headersTimeout = 0; // no headers timeout (default 60000ms)
  server.timeout = 0; // no socket inactivity timeout
  server.keepAliveTimeout = 120000;
  return server;
};

require("./server.js");
