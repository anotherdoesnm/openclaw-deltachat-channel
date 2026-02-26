const { spawn } = require('child_process');
const { StdioDeltaChat } = require('@deltachat/jsonrpc-client');
const fs = require('fs');
const path = require('path');

/**
 * DeltaChatChannel - OpenClaw Channel Adapter
 * Defensive improvements added:
 * - guard all RPC calls with try/catch
 * - handle rpcProcess 'error'/'exit'/'close' events and avoid throwing to host
 * - ensure init()/stop() are safe to call multiple times
 * - make event loop fail-safe and resilient to RPC errors
 */
class DeltaChatChannel {
  constructor(config = {}, context = {}) {
    this.config = {
      email: config.email,
      password: config.password,
      server: config.server || 'cm.dc09.xyz',
      accountsPath: config.accountsPath || path.join(process.env.HOME || '/root', '.openclaw', 'deltachat-accounts'),
      rpcServerPath: config.rpcServerPath || path.join(process.env.HOME || '/root', '.openclaw', 'workspace', 'deltachat-rpc-server'),
      ...config
    };
    
    this.context = context;
    this.rpcProcess = null;
    this.client = null;
    this.accountId = null;
    this.connected = false;
    this.messageCallback = null;
    this._stopping = false;
  }

  /**
   * Initialize the channel
   */
  async init() {
    if (this._stopping) return;

    try {
      // Ensure accounts directory exists with valid config
      this._initAccountsConfig();

      // Spawn RPC server
      const env = {
        ...process.env,
        DC_ACCOUNTS_PATH: this.config.accountsPath
      };

      try {
        this.rpcProcess = spawn(this.config.rpcServerPath, [], {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (err) {
        console.error('DeltaChat: failed to spawn rpc server:', err && err.stack ? err.stack : err);
        this.rpcProcess = null;
        return;
      }

      this.rpcProcess.on('error', (err) => {
        try { console.error('DeltaChat RPC error event:', err && err.stack ? err.stack : err); } catch (_) {}
      });

      this.rpcProcess.on('exit', (code, signal) => {
        try { console.warn(`DeltaChat RPC exited code=${code} signal=${signal}`); } catch (_) {}
        this.connected = false;
      });

      this.rpcProcess.on('close', (code, signal) => {
        try { console.warn(`DeltaChat RPC closed code=${code} signal=${signal}`); } catch (_) {}
        this.connected = false;
      });

      this.rpcProcess.stderr.on('data', (data) => {
        try {
          const line = data.toString().trim();
          if (line.length === 0) return;
          // Always log stderr at debug level; highlight important lines
          if (line.includes('ERROR') || line.includes('configure')) {
            console.error('DeltaChat RPC:', line);
          } else {
            console.debug('DeltaChat RPC(stderr):', line);
          }
        } catch (_) {}
      });

      // Wait briefly for server initialization
      await this._sleep(1500);

      // Create client (guarded)
      try {
        this.client = new StdioDeltaChat(this.rpcProcess.stdin, this.rpcProcess.stdout);
      } catch (err) {
        console.error('DeltaChat: failed to create RPC client:', err && err.stack ? err.stack : err);
        this.client = null;
        // Do not throw — leave the channel unconnected
        return;
      }

      // Setup account (guarded)
      try {
        await this._setupAccount();
      } catch (err) {
        console.error('DeltaChat: _setupAccount failed:', err && err.stack ? err.stack : err);
        // Stop RPC process to avoid leaking processes
        try { this.stop(); } catch (_) {}
        return;
      }

      // Start event processing
      this.connected = true;
      this._startEventProcessing();
      try { console.log(`DeltaChat channel ready: ${this.config.email}`); } catch (_) {}
    } catch (e) {
      try { console.error('DeltaChat init unexpected error:', e && e.stack ? e.stack : e); } catch (_) {}
      // ensure resources cleaned
      try { await this.stop(); } catch (_) {}
    }
  }

  /**
   * Initialize accounts.toml if needed
   */
  _initAccountsConfig() {
    try {
      if (!fs.existsSync(this.config.accountsPath)) {
        fs.mkdirSync(this.config.accountsPath, { recursive: true });
      }

      const accountsToml = path.join(this.config.accountsPath, 'accounts.toml');
      if (!fs.existsSync(accountsToml)) {
        const toml = `next_id = 1\nselected_account = 4294967295\naccounts = []\n`;
        fs.writeFileSync(accountsToml, toml);
      }
    } catch (e) {
      try { console.error('DeltaChat _initAccountsConfig failed:', e && e.stack ? e.stack : e); } catch (_) {}
    }
  }

  /**
   * Setup or load account
   */
  async _setupAccount() {
    if (!this.client || !this.client.rpc) throw new Error('no rpc client');

    try {
      const accounts = await this._safeRpcCall('getAllAccounts', () => this.client.rpc.getAllAccounts());
      if (!Array.isArray(accounts)) throw new Error('invalid accounts list');

      if (accounts.length === 0) {
        // Create new account
        this.accountId = await this._safeRpcCall('addAccount', () => this.client.rpc.addAccount());
        console.log('DeltaChat: Created account', this.accountId);
        // Configure
        await this._safeRpcCall('batchSetConfig', () => this.client.rpc.batchSetConfig(this.accountId, {
          addr: this.config.email,
          mail_pw: this.config.password,
          ...(this.config.server && {
            mail_server: this.config.server,
            send_server: this.config.server
          })
        }));

        await this._safeRpcCall('configure', () => this.client.rpc.configure(this.accountId));

        // Wait for configuration
        await this._waitForConfiguration();
      } else {
        // Use existing account
        this.accountId = accounts[0].id;
        const info = await this._safeRpcCall('getAccountInfo', () => this.client.rpc.getAccountInfo(this.accountId));
        if (!info) throw new Error('no account info');

        if (info.kind !== 'Configured') {
          console.log('DeltaChat: Reconfiguring account', this.accountId);
          await this._safeRpcCall('batchSetConfig', () => this.client.rpc.batchSetConfig(this.accountId, {
            addr: this.config.email,
            mail_pw: this.config.password
          }));
          await this._safeRpcCall('configure', () => this.client.rpc.configure(this.accountId));
          await this._waitForConfiguration();
        } else {
          console.log('DeltaChat: Using configured account', info.addr);
        }
      }

      // Start IO
      await this._safeRpcCall('startIoForAllAccounts', () => this.client.rpc.startIoForAllAccounts());
      await this._sleep(1000);
    } catch (e) {
      throw e;
    }
  }

  /**
   * Wait for account configuration
   */
  async _waitForConfiguration(timeout = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const info = await this._safeRpcCall('getAccountInfo', () => this.client.rpc.getAccountInfo(this.accountId));
        if (info && info.kind === 'Configured') {
          return info;
        }
      } catch (e) {
        // keep waiting unless stopping
        if (this._stopping) break;
      }
      await this._sleep(1000);
    }
    throw new Error('Account configuration timeout');
  }

  /**
   * Start processing events
   */
  _startEventProcessing() {
    const processEvents = async () => {
      console.log('Starting processing events');
      while (this.connected && !this._stopping) {
        try {
          if (!this.client || !this.client.rpc) {
            await this._sleep(1000);
            continue;
          }

          let event = null;
          try {
            event = await this._safeRpcCall('getNextEvent', () => this.client.rpc.getNextEvent(), { timeout: 30000 });
          } catch (e) {
            // transient error — continue loop
            console.error('DeltaChat getNextEvent error:', e && e.stack ? e.stack : e);
            await this._sleep(1000);
            continue;
          }

          if (event && event.event && event.event.kind) {
            try {
              await this._handleEvent(event.event);
            } catch (e) {
              console.error('DeltaChat _handleEvent error:', e && e.stack ? e.stack : e);
            }
          }
        } catch (err) {
          try { console.error('DeltaChat event loop unexpected error:', err && err.stack ? err.stack : err); } catch (_) {}
          // Sleep to avoid hot loop on fatal errors
          await this._sleep(1000);
        }
      }
      // ensure connected state cleared
      this.connected = false;
    };

    // run async
    processEvents().catch(e => {
      try { console.error('DeltaChat processEvents fatal:', e && e.stack ? e.stack : e); } catch (_) {}
      this.connected = false;
    });
  }

  /**
   * Handle DeltaChat events
   */
  async _handleEvent(event) {
    try {
      switch (event.kind) {
        case 'IncomingMsg': {
          if (this.messageCallback) {
            try {
              const message = await this._normalizeMessage(this.accountId, event.msgId);
              if (message) {
                try { this.messageCallback(message); } catch (e) { console.error('messageCallback error:', e && e.stack ? e.stack : e); }
              }
            } catch (err) {
              console.error('DeltaChat message handling error:', err && err.stack ? err.stack : err);
            }
          }
          break;
        }
        case 'ConnectivityChanged':
          // Optional: emit connectivity status
          break;
        case 'Info':
          try { console.log(event.msg); } catch (_) {}
          break;
        default:
          // Ignore other events
          break;
      }
    } catch (e) {
      console.error('DeltaChat _handleEvent unexpected error:', e && e.stack ? e.stack : e);
    }
  }

  /**
   * Normalize DeltaChat message to OpenClaw format
   */
  async _normalizeMessage(accountId, msgId) {
    try {
      const msg = await this._safeRpcCall('getMessage', () => this.client.rpc.getMessage(accountId, msgId));
      if (!msg || msg.isBot) return null;

      const chat = await this._safeRpcCall('getFullChatById', () => this.client.rpc.getFullChatById(accountId, msg.chatId));
      const chatType = chat.chatType === 'Group' ? 'group' : 'direct';

      return {
        id: String(msg.id),
        text: msg.text || '',
        from: {
          id: String(msg.fromId),
          name: chat.name || String(msg.fromId),
          username: null
        },
        chat: {
          id: String(msg.chatId),
          type: chatType,
          name: chat.name || (chatType === 'direct' ? 'Direct' : 'Group')
        },
        timestamp: msg.timestamp * 1000,
        attachments: [],
        replyTo: msg.quote ? String(msg.quote.messageId) : null,
        raw: msg
      };
    } catch (e) {
      console.error('DeltaChat _normalizeMessage failed:', e && e.stack ? e.stack : e);
      return null;
    }
  }

  /**
   * Send message
   */
  async send(chatId, text, options = {}) {
    if (!this.connected || !this.accountId) {
      throw new Error('DeltaChat channel not connected');
    }

    const chatIdNum = parseInt(chatId, 10);
    const msgData = { text };

    if (options.replyTo) {
      msgData.quotedMsgId = parseInt(options.replyTo, 10);
    }

    const msgId = await this._safeRpcCall('sendMsg', () => this.client.rpc.sendMsg(this.accountId, chatIdNum, msgData));
    return { id: String(msgId) };
  }

  /**
   * Get chat info
   */
  async getChat(chatId) {
    if (!this.connected || !this.accountId) return null;

    const chatIdNum = parseInt(chatId, 10);
    const chat = await this._safeRpcCall('getFullChatById', () => this.client.rpc.getFullChatById(this.accountId, chatIdNum));
    if (!chat) return null;
    
    return {
      id: String(chatIdNum),
      name: chat.name,
      type: chat.chatType === 'Group' ? 'group' : 'direct'
    };
  }

  /**
   * List chats
   */
  async listChats() {
    if (!this.connected || !this.accountId) return [];

    const entries = await this._safeRpcCall('getChatlistEntries', () => this.client.rpc.getChatlistEntries(this.accountId, 0, null, null));
    const chats = [];

    if (!Array.isArray(entries)) return chats;

    for (const chatId of entries) {
      try {
        const chat = await this._safeRpcCall('getBasicChatInfo', () => this.client.rpc.getBasicChatInfo(this.accountId, chatId));
        if (chat) chats.push({ id: String(chatId), name: chat.name, type: chat.chatType === 'Group' ? 'group' : 'direct' });
      } catch (e) {
        // Skip problematic chats
      }
    }

    return chats;
  }

  /**
   * Get bot info
   */
  async getSelf() {
    if (!this.connected || !this.accountId) return null;
    
    const info = await this._safeRpcCall('getAccountInfo', () => this.client.rpc.getAccountInfo(this.accountId));
    if (!info) return null;
    return {
      id: String(this.accountId),
      name: info.displayName || this.config.email,
      username: null
    };
  }

  /**
   * Set message handler callback
   */
  onMessage(callback) {
    try { console.log('DeltaChatChannel: onMessage handler attached (via context or host)'); } catch (e) {}
    this.messageCallback = callback;
  }

  /**
   * Stop the channel
   */
  async stop() {
    this._stopping = true;
    this.connected = false;
    this.messageCallback = null;

    if (this.client && this.client.rpc) {
      try {
        await this._safeRpcCall('stopIoForAllAccounts', () => this.client.rpc.stopIoForAllAccounts());
      } catch (e) {
        // Ignore
      }
    }

    if (this.rpcProcess) {
      try {
        this.rpcProcess.kill();
      } catch (e) {}
      this.rpcProcess = null;
    }

    this.client = null;

    try { console.log('DeltaChat channel stopped'); } catch (_) {}
  }

  /**
   * Utility: Sleep
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Helper: safe RPC call with timeout and logging
   */
  async _safeRpcCall(name, fn, opts = {}) {
    const timeout = opts.timeout || 15000;
    if (!this.client || !this.client.rpc) throw new Error('rpc-not-available');

    let finished = false;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        if (finished) return;
        finished = true;
        const err = new Error(`rpc ${name} timeout`);
        try { console.error(err.message); } catch (_) {}
        reject(err);
      }, timeout);

      Promise.resolve().then(() => fn()).then((res) => {
        if (finished) return;
        finished = true;
        clearTimeout(to);
        resolve(res);
      }).catch((e) => {
        if (finished) return;
        finished = true;
        clearTimeout(to);
        try { console.error(`rpc ${name} error:`, e && e.stack ? e.stack : e); } catch (_) {}
        reject(e);
      });
    });
  }
}

module.exports = { DeltaChatChannel };
