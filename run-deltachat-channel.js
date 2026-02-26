const fs = require('fs');
const path = require('path');
const http = require('http');

const pluginPath = '/root/.openclaw/extensions/openclaw-deltachat-channel/plugin.js';
const configPath = '/root/.openclaw/openclaw.json';
const logPath = '/root/.openclaw/logs/deltachat.log';
const SOCKET_PATH = '/tmp/deltachat.sock';

function safeAppend(file, txt) {
  try { fs.appendFileSync(file, txt + '\n'); } catch (e) {
    try { fs.appendFileSync('/tmp/deltachat-fallback.log', txt + '\n'); } catch (_) {}
  }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try {
    if (!fs.existsSync(path.dirname(logPath))) fs.mkdirSync(path.dirname(logPath), { recursive: true });
    safeAppend(logPath, line);
  } catch (_) {}
  try { console.log(line); } catch (e) { /* ignore EPIPE/closed stdout */ }
}

async function main() {
  try {
    log('Starting deltachat manual runner (shim-enabled)');

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const channelCfg = (cfg.channels && cfg.channels.deltachat && cfg.channels.deltachat.config) || {};

    if (!channelCfg.rpcServerPath) {
      log('ERROR: rpcServerPath missing in config');
      process.exit(2);
    }

    const plugin = require(pluginPath);
    const createChannel = plugin.createChannel || (plugin.activate && plugin.activate().createChannel) || null;
    if (!createChannel) {
      log('ERROR: cannot find createChannel export in plugin');
      process.exit(2);
    }

    let channel = null;
    let sseClients = new Set();

    async function startOnce() {
      try {
        channel = createChannel(channelCfg, {});
        log('Instantiated channel, calling init()');
        await channel.init();
        log('Channel init completed');

        // when channel emits messages, broadcast to SSE clients
        if (typeof channel.onMessage === 'function') {
          channel.onMessage((msg) => {
            try {
              log('INCOMING:', msg.id, msg.chat && msg.chat.id, msg.text && msg.text.slice(0,200));
            } catch (_) {}
            const data = JSON.stringify({ type: 'message', payload: msg });
            for (const res of Array.from(sseClients)) {
              try {
                res.write(`data: ${data}\n\n`);
              } catch (e) {
                try { res.end(); } catch (_) {}
                sseClients.delete(res);
              }
            }
          });
        }

        // start HTTP server on unix socket for shim
        try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch (_) {}

        const server = http.createServer(async (req, res) => {
          if (req.method === 'GET' && req.url === '/events') {
            // SSE endpoint
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });
            res.write('\n');
            sseClients.add(res);
            req.on('close', () => { sseClients.delete(res); });
            return;
          }

          if (req.method === 'POST' && req.url === '/call') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
              try {
                const payload = JSON.parse(body || '{}');
                const method = payload.method;
                const params = payload.params || [];
                if (!channel) throw new Error('channel-not-ready');
                if (typeof channel[method] !== 'function') throw new Error('unknown-method');
                const result = await channel[method](...params);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true, result }));
              } catch (e) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e) }));
              }
            });
            return;
          }

          res.statusCode = 404; res.end('not found');
        });

        server.on('error', (e) => { log('Shim HTTP server error', e && e.stack?e.stack:e); });
        server.listen(SOCKET_PATH, () => { log('Shim HTTP server listening on', SOCKET_PATH); });
        // set socket permissions
        try { fs.chmodSync(SOCKET_PATH, 0o666); } catch (_) {}

        // Keep process alive while channel runs
        await new Promise((resolve, reject) => {
          process.on('SIGTERM', () => resolve());
          process.on('SIGINT', () => resolve());
          process.on('uncaughtException', (err) => {
            try { safeAppend(logPath, new Date().toISOString() + ' uncaughtException\n' + (err && err.stack ? err.stack : String(err)) + '\n'); } catch (_) {}
            reject(err);
          });
          process.on('unhandledRejection', (r) => {
            try { safeAppend(logPath, new Date().toISOString() + ' unhandledRejection\n' + (r && (r.stack || JSON.stringify(r)) ? (r.stack || JSON.stringify(r)) : String(r)) + '\n'); } catch (_) {}
            reject(r);
          });
        });

        log('Stopping channel due to signal');
        try { await channel.stop(); } catch (e) { log('Error stopping channel', e && e.stack ? e.stack : e); }
        try { server.close(); } catch (_) {}
      } catch (err) {
        log('Channel start error:', err && err.stack ? err.stack : String(err));
        if (channel && channel.stop) {
          try { await channel.stop(); } catch (e) { log('Error stopping after failure', e && e.stack ? e.stack : e); }
        }
        throw err;
      }
    }

    // Retry loop
    for (;;) {
      try {
        await startOnce();
        // graceful exit
        break;
      } catch (e) {
        log('startOnce failed, will retry in 5s');
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    log('Runner exiting normally');
    process.exit(0);
  } catch (e) {
    try { safeAppend(logPath, new Date().toISOString() + ' Fatal runner error\n' + (e && e.stack ? e.stack : String(e)) + '\n'); } catch (_) {}
    try { console.error('Fatal runner error', e && e.stack ? e.stack : e); } catch (_) {}
    process.exit(2);
  }
}

main();
