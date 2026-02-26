const http = require('http');
const fs = require('fs');
const path = require('path');

// Minimal shim client plugin - talks to runner shim over unix socket /tmp/deltachat.sock
// Defensive: avoid invoking host accessors, and never throw synchronously from register/activate.

const SHIM_SOCKET = process.env.DELTACHAT_SHIM_SOCKET || '/tmp/deltachat.sock';

function safeGet(obj, prop) {
  try {
    if (!obj || typeof obj !== 'object') return undefined;
    const desc = Object.getOwnPropertyDescriptor(obj, prop);
    if (desc && Object.prototype.hasOwnProperty.call(desc, 'value')) return desc.value;
    try { return obj[prop]; } catch (e) { return undefined; }
  } catch (e) { return undefined; }
}

function register(pluginContext) {
  const meta = { id: 'openclaw-deltachat-channel', name: 'Delta Chat (shim)' };
  try {
    const reg = safeGet(pluginContext, 'registerChannel');
    if (typeof reg === 'function') {
      const descriptor = {
        id: 'deltachat',
        meta: { label: 'Delta Chat (shim)', blurb: 'Delta Chat via external runner shim' },
        config: {
          listAccountIds: function(cfg) { return []; },
          resolveAccount: function(cfg, accountId) { return null; }
        },
        createChannel: (config, hostCtx) => createProxyChannel(config || {}, hostCtx || {})
      };
      try { reg.call(pluginContext, { plugin: descriptor }); console.log('register(): shim descriptor registered'); } catch (e) { console.error('register(): registerChannel failed', e && e.stack?e.stack:e); }
    }
  } catch (e) {}
  return meta;
}

function activate(context) {
  try { console.log('openclaw-deltachat-channel (shim): activate called'); } catch (e) {}
  try {
    const reg = safeGet(context, 'registerChannel');
    if (typeof reg === 'function') {
      const descriptor = {
        id: 'deltachat',
        meta: { label: 'Delta Chat (shim)', blurb: 'Delta Chat via external runner shim' },
        config: {
          listAccountIds: function(cfg) { return []; },
          resolveAccount: function(cfg, accountId) { return null; }
        },
        createChannel: (config, hostCtx) => createProxyChannel(config || {}, hostCtx || {})
      };
      try { reg.call(context, { plugin: descriptor }); console.log('activate(): shim descriptor registered via context.registerChannel'); } catch (e) { console.error('activate(): registerChannel failed', e && e.stack?e.stack:e); }
    }
  } catch (e) { console.error('activate-time registration failed', e && e.stack?e.stack:e); }

  return {
    id: 'deltachat',
    name: 'Delta Chat (shim)',
    createChannel: (config, ctx) => createProxyChannel(config || {}, ctx || {})
  };
}

function shimCall(method, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const opts = {
      socketPath: SHIM_SOCKET,
      path: '/call',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (parsed && parsed.ok) resolve(parsed.result);
          else reject(new Error(parsed && parsed.error ? parsed.error : `shim-call failed status=${res.statusCode}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

function subscribeEvents(onEvent) {
  // SSE over unix socket
  try {
    const opts = {
      socketPath: SHIM_SOCKET,
      path: '/events',
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' }
    };
    const req = http.request(opts, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        let parts = buf.split('\n\n');
        while (parts.length > 1) {
          const chunkBlock = parts.shift();
          buf = parts.join('\n\n');
          // parse lines beginning with data:
          const lines = chunkBlock.split('\n');
          for (const line of lines) {
            if (line.startsWith('data:')) {
              const json = line.slice(5).trim();
              try { const obj = JSON.parse(json); onEvent(obj); } catch (e) {}
            }
          }
        }
      });
      res.on('end', () => { /* server closed */ });
    });
    req.on('error', (e) => { /* ignore, shim may be down */ });
    req.end();
    return req; // so caller can abort()
  } catch (e) { return null; }
}

function createProxyChannel(config, hostCtx) {
  // Proxy implements async methods used by Gateway: init, stop, send, listChats, getChat, getSelf, onMessage
  let eventReq = null;
  let messageHandler = null;
  let stopped = false;

  const proxy = {
    async init() {
      // ask shim to ensure channel is ready; call a noop-ish method (getSelf) to confirm
      try {
        await shimCall('noop', []);
      } catch (e) {
        // if noop missing, fallback to getSelf
        try { await shimCall('getSelf', []); } catch (err) { /* ignore */ }
      }
      // subscribe to events
      try {
        eventReq = subscribeEvents((ev) => {
          if (ev && ev.type === 'message' && ev.payload) {
            if (typeof messageHandler === 'function') {
              try { messageHandler(ev.payload); } catch (e) { console.error('proxy onMessage handler error', e && e.stack?e.stack:e); }
            }
          }
        });
      } catch (e) {}
    },

    async stop() {
      stopped = true;
      try { if (eventReq && typeof eventReq.abort === 'function') eventReq.abort(); } catch (_) {}
      try { await shimCall('stop', []); } catch (_) {}
    },

    onMessage(cb) {
      messageHandler = cb;
    },

    async send(chatId, text, options = {}) {
      try {
        const res = await shimCall('sendMsg', [chatId, text, options]);
        return { id: String(res) };
      } catch (e) { throw e; }
    },

    async listChats() {
      try { return await shimCall('listChats', []); } catch (e) { return []; }
    },

    async getChat(chatId) {
      try { return await shimCall('getChat', [chatId]); } catch (e) { return null; }
    },

    async getSelf() {
      try { return await shimCall('getSelf', []); } catch (e) { return null; }
    }
  };

  return proxy;
}

module.exports = {
  id: 'openclaw-deltachat-channel',
  name: 'Delta Chat (shim)',
  version: '1.1.0',
  register,
  activate,
  createChannel: (config, ctx) => createProxyChannel(config || {}, ctx || {})
};

// Ensure top-level module.exports.config exists for host compatibility
try {
  const fs = require('fs');
  const path = require('path');
  const home = process.env.HOME || '/root';
  if (!module.exports.config) {
    module.exports.config = {
      listAccountIds: function(cfg) {
        try {
          const globalCfgPath = path.join(home, '.openclaw', 'openclaw.json');
          if (!fs.existsSync(globalCfgPath)) return [];
          const globalCfg = JSON.parse(fs.readFileSync(globalCfgPath, 'utf8'));
          const ch = globalCfg && globalCfg.channels && globalCfg.channels.deltachat;
          if (ch && ch.config && ch.config.email) return ['default'];
        } catch (e) {}
        return [];
      },
      resolveAccount: function(cfg, accountId) {
        try {
          const globalCfgPath = path.join(home, '.openclaw', 'openclaw.json');
          if (!fs.existsSync(globalCfgPath)) return null;
          const globalCfg = JSON.parse(fs.readFileSync(globalCfgPath, 'utf8'));
          const ch = globalCfg && globalCfg.channels && globalCfg.channels.deltachat;
          if (!ch || !ch.config) return null;
          if (!accountId || accountId === 'default') {
            return { id: 'default', label: ch.config.email };
          }
        } catch (e) {}
        return null;
      }
    };
  }
} catch (e) {}
