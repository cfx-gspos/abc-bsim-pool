const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'dist/app/walletconnect.js'), 'utf8');
const HOUR = 3600000;
const START = 1800000000000;
const EXPIRY = START + 7 * 24 * HOUR;
const PREFIX = 'abc:bim:disconnected:';
let topicNumber = 0;
const options = { chainId: 1030, rpcUrl: 'https://rpc.invalid' };
const session = (topic = 'test-session', expiry = EXPIRY) => ({ topic, expiry: expiry / 1000 });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// 使用模拟钱包和虚拟时间测试，不访问真实钱包，也不发送链上交易。
function fixture({ restored, now = START, storage = new Map(), storageDisabled = false, rejectConnect = false, offline = false, hangDisconnect = false } = {}) {
  const timers = new Map();
  const events = new EventEmitter();
  const documentEvents = new EventEmitter();
  const client = new EventEmitter();
  const sessions = new Map(restored ? [[restored.topic, restored]] : []);
  client.session = { get(topic) { if (!sessions.has(topic)) throw new Error('Missing session'); return sessions.get(topic); } };
  const raw = new EventEmitter();
  let timerId = 0;
  let initCalls = 0;
  raw.session = restored;
  raw.signer = { client };
  raw.chainId = 1030;
  raw.connectCalls = 0;
  raw.disconnectCalls = 0;
  raw.requests = [];
  raw.connect = async () => {
    raw.connectCalls++;
    if (rejectConnect) throw Object.assign(new Error('Rejected'), { code: 4001 });
    raw.session = session('new-session-' + (++topicNumber), now + 7 * 24 * HOUR);
    sessions.set(raw.session.topic, raw.session);
  };
  raw.disconnect = async () => {
    raw.disconnectCalls++;
    if (offline) throw new Error('Offline');
    if (hangDisconnect) return new Promise(() => {});
    if (raw.session) sessions.delete(raw.session.topic);
    raw.session = undefined;
    raw.emit('disconnect', { code: 4900 });
  };
  raw.request = async (args) => {
    raw.requests.push(args);
    if (args.method === 'eth_chainId') return '0x406';
    if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') return ['0x' + '1'.repeat(40)];
    return 'test-result';
  };
  const global = {
    ABC_WALLETCONNECT_CONFIG: { projectId: '0'.repeat(32) },
    ABCWalletConnectProvider: { EthereumProvider: { init: async () => { initCalls++; return raw; } } },
    location: { origin: 'https://test.invalid' },
    localStorage: {
      getItem(key) { if (storageDisabled) throw new Error('Denied'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageDisabled) throw new Error('Denied'); storage.set(key, value); },
    },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener: events.on.bind(events),
    removeEventListener: events.removeListener.bind(events),
  };
  vm.runInNewContext(source, {
    window: global,
    document: { addEventListener: documentEvents.on.bind(documentEvents), removeEventListener: documentEvents.removeListener.bind(documentEvents) },
    Date: { now: () => now },
  });
  return {
    api: global.ABCWalletConnect, raw, client, sessions, storage, events, documentEvents,
    get initCalls() { return initCalls; },
    async advance(time, runTimers = true) {
      now = time;
      if (runTimers) {
        for (const [id, task] of [...timers]) {
          if (task.at <= now && timers.has(id)) { timers.delete(id); task.fn(); }
        }
      }
      await flush();
    },
  };
}

test('一小时后仍有效，按钱包真实到期时间退出', async () => {
  const f = fixture();
  const provider = await f.api.connect(options);
  let disconnected = 0;
  provider.on('disconnect', () => disconnected++);
  await f.advance(START + HOUR);
  assert.equal(provider.isSessionActive(), true);
  await f.advance(EXPIRY - 1);
  await provider.request({ method: 'eth_accounts' });
  await f.advance(EXPIRY);
  assert.equal(disconnected, 1);
  assert.equal(provider.session, undefined);
  await assert.rejects(provider.request({ method: 'personal_sign' }), { code: 4900 });
  await assert.rejects(provider.request({ method: 'eth_sendTransaction' }), { code: 4900 });
  assert.deepEqual(f.raw.requests.map(x => x.method), ['eth_accounts']);
});

test('刷新复用原会话但不延长钱包有效期', async () => {
  const f = fixture({ restored: session(), now: EXPIRY - HOUR });
  const provider = await f.api.connect(options);
  assert.equal(f.raw.connectCalls, 0);
  assert.equal(provider.session.expiry, EXPIRY / 1000);
  assert.equal(await f.api.connect(options), provider);
  await f.advance(EXPIRY);
  assert.equal(provider.isSessionActive(), false);
});

test('恢复过期会话时清理并重新授权', async () => {
  const f = fixture({ restored: session('expired', START - 1000) });
  const provider = await f.api.connect(options);
  assert.equal(f.raw.disconnectCalls, 1);
  assert.equal(f.raw.connectCalls, 1);
  assert.equal(provider.isSessionActive(), true);
});

for (const trigger of ['focus', 'pageshow', 'visibilitychange', 'request']) {
  test('后台计时器暂停时仍检查到期: ' + trigger, async () => {
    const f = fixture();
    const provider = await f.api.connect(options);
    let disconnected = false;
    provider.on('disconnect', () => { disconnected = true; });
    await f.advance(EXPIRY, false);
    if (trigger === 'request') await assert.rejects(provider.request({ method: 'personal_sign' }), { code: 4900 });
    else if (trigger === 'visibilitychange') f.documentEvents.emit(trigger);
    else f.events.emit(trigger);
    assert.equal(disconnected, true);
    assert.equal(f.raw.requests.length, 0);
  });
}

test('续期读取 SignClient 最新会话，不受旧对象到期时间影响', async () => {
  const f = fixture({ restored: session('renewed', START + HOUR) });
  const provider = await f.api.connect(options);
  f.sessions.set('renewed', session('renewed', EXPIRY));
  f.client.emit('session_extend', { topic: 'renewed' });
  await f.advance(START + HOUR);
  assert.equal(provider.isSessionActive(), true);
  assert.equal(f.raw.session.expiry, (START + HOUR) / 1000);
  assert.equal(provider.session.expiry, EXPIRY / 1000);
  await f.advance(EXPIRY);
  assert.equal(provider.isSessionActive(), false);
});

test('超过浏览器计时上限的会话不会立即过期', async () => {
  const f = fixture({ restored: session('long-session', START + 60 * 24 * HOUR) });
  const provider = await f.api.connect(options);
  await f.advance(START + 2147483647);
  assert.equal(provider.isSessionActive(), true);
  await f.advance(START + 60 * 24 * HOUR);
  assert.equal(provider.isSessionActive(), false);
});

for (const event of ['session_delete', 'session_expire']) {
  test('直接处理 SignClient 原生事件: ' + event, async () => {
    const f = fixture();
    const provider = await f.api.connect(options);
    let calls = 0;
    provider.on('disconnect', () => calls++);
    f.client.emit(event, { topic: 'another-topic' });
    assert.equal(calls, 0);
    f.client.emit(event, { topic: provider.session.topic });
    assert.equal(calls, 1);
    f.raw.emit('disconnect');
    assert.equal(calls, 1);
    assert.equal(f.client.listenerCount(event), 0);
    await assert.rejects(provider.request({ method: 'eth_accounts' }), { code: 4900 });
  });
}

test('SDK 会话已删除但 provider 缓存仍在时立即退出', async () => {
  const f = fixture();
  const provider = await f.api.connect(options);
  f.sessions.clear();
  assert.equal(provider.isSessionActive(), false);
});

test('主动断开立即禁止旧请求，支持重新连接', async () => {
  const f = fixture();
  const provider = await f.api.connect(options);
  const topic = provider.session.topic;
  const pending = f.api.disconnect();
  assert.equal(provider.isSessionActive(), false);
  await pending;
  assert.equal(f.raw.disconnectCalls, 1);
  assert.equal(f.storage.get(PREFIX + topic), '1');
  const fresh = await f.api.connect(options);
  assert.equal(fresh.isSessionActive(), true);
  await assert.rejects(provider.request({ method: 'personal_sign' }), { code: 4900 });
});

test('另一标签页主动断开同一会话后，本页同步退出', async () => {
  const storage = new Map();
  const a = fixture({ restored: session(), storage });
  const b = fixture({ restored: session(), storage });
  await a.api.connect(options);
  const second = await b.api.connect(options);
  await a.api.disconnect();
  b.events.emit('storage', { key: PREFIX + 'test-session' });
  assert.equal(second.isSessionActive(), false);
});

test('并发点击只初始化和连接一次', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.api.connect(options), f.api.connect(options)]);
  assert.equal(a, b);
  assert.equal(f.initCalls, 1);
  assert.equal(f.raw.connectCalls, 1);
});

test('拒绝授权允许重试', async () => {
  const f = fixture({ rejectConnect: true });
  await assert.rejects(f.api.connect(options), { code: 4001 });
  await assert.rejects(f.api.connect(options), { code: 4001 });
  assert.equal(f.raw.connectCalls, 2);
});

test('断开请求失败后也退出本地，刷新不能直接恢复被断开的会话', async () => {
  const f = fixture({ offline: true });
  const provider = await f.api.connect(options);
  await assert.rejects(f.api.disconnect(), /Offline/);
  assert.equal(provider.isSessionActive(), false);
  const refreshed = fixture({ restored: f.raw.session, storage: f.storage });
  await refreshed.api.connect(options);
  assert.equal(refreshed.raw.disconnectCalls, 1);
  assert.equal(refreshed.raw.connectCalls, 1);
});

test('断开请求超时时本地立即失效，等待有明确上限', async () => {
  const f = fixture({ hangDisconnect: true });
  const provider = await f.api.connect(options);
  const pending = assert.rejects(f.api.disconnect(), /timed out/);
  assert.equal(provider.isSessionActive(), false);
  await flush();
  await f.advance(START + 10000);
  await pending;
});

test('无持久化存储时也能正常连接和主动断开', async () => {
  const f = fixture({ storageDisabled: true });
  const provider = await f.api.connect(options);
  assert.equal(provider.isSessionActive(), true);
  await f.api.disconnect();
  assert.equal(provider.isSessionActive(), false);
});

test('EIP-1193 接口兼容当前 ethers', async () => {
  const ethers = require(path.join(root, 'dist/app/ethers-5.2.umd.min.js'));
  const f = fixture();
  const provider = new ethers.providers.Web3Provider(await f.api.connect(options), 'any');
  assert.equal((await provider.listAccounts()).length, 1);
  assert.equal((await provider.getNetwork()).chainId, 1030);
});

for (const entry of ['dist/app/main.js', 'dist/espace/app/main.js']) {
  const main = fs.readFileSync(path.join(root, entry), 'utf8');
  const indent = entry === 'dist/app/main.js' ? '        ' : '    ';
  function method(name, globals = {}) {
    const code = main.match(new RegExp('^' + indent + '(?:async )?' + name + '\\([^\\n]*\\{[\\s\\S]*?^' + indent + '\\},', 'm'))[0];
    return vm.runInNewContext('({' + code + '}).' + name, globals);
  }

  test(entry + ': 延迟 RPC 返回不能重新填充已断开用户状态', async () => {
    let resolveSummary;
    const app = {
      userInfo: { connected: true, account: 'old-account' },
      contract: { userSummary: () => new Promise(resolve => { resolveSummary = resolve; }) },
    };
    const pending = method('loadUserInfo').call(app);
    app.userInfo = { connected: false, account: '', balance: 0 };
    resolveSummary({ votes: 9n });
    await pending;
    assert.deepEqual(app.userInfo, { connected: false, account: '', balance: 0 });
  });

  test(entry + ': 断开清理账户、输入、监听器并恢复只读 provider', () => {
    const eventProvider = new EventEmitter();
    const handlers = { disconnect() {}, accountsChanged() {}, chainChanged() {} };
    for (const [event, handler] of Object.entries(handlers)) eventProvider.on(event, handler);
    class ReadProvider {}
    const app = {
      _eSpaceEventProvider: eventProvider, _eSpaceProviderHandlers: handlers,
      eSpaceAccount: 'old', stakeCount: 1000, unstakeCount: 1000, walletConnecting: true,
      resetUserInfo() { this.userInfo = { connected: false, account: '' }; },
      contract: { eSpaceContract: { connect(provider) { return { provider }; } } },
    };
    method('resetESpaceConnection', { ethers: { providers: { JsonRpcProvider: ReadProvider } }, CURRENT: options }).call(app, 'Wallet disconnected.');
    assert.equal(app.eSpaceAccount, '');
    assert.equal(app.userInfo.connected, false);
    assert.equal(app.stakeCount, 0);
    assert.equal(app.unstakeCount, 0);
    assert.equal(app.walletConnecting, false);
    assert.equal(app.contract.ethClient instanceof ReadProvider, true);
    assert.equal(eventProvider.listenerCount('disconnect'), 0);
  });

  test(entry + ': 上一次连接的延迟失败不能覆盖新连接状态', async () => {
    let rejectOld;
    let attempts = 0;
    const app = {
      isCore: () => false,
      userInfo: { connected: false },
      connectESpaceProvider() {
        if (++attempts === 1) return new Promise((_, reject) => { rejectOld = reject; });
        this.userInfo.connected = true;
      },
      resetESpaceConnection() { throw new Error('A stale connection must not reset the new session'); },
    };
    const connect = method('connectWalletConnect', {
      CURRENT: { eNetId: 1030, eSpaceRpc: options.rpcUrl },
      window: { ABCWalletConnect: { connect: async () => ({}) } },
    });
    const oldAttempt = connect.call(app);
    await flush();
    app._connectAttempt++;
    app.walletConnecting = false;
    await connect.call(app);
    rejectOld(new Error('Previous RPC timed out'));
    await oldAttempt;
    assert.equal(app.userInfo.connected, true);
    assert.equal(app.walletConnecting, false);
    assert.equal(app.walletNotice, '');
  });
}

test('主站链接同页打开；主页面和备用页都提供断开入口及同一会话模块', () => {
  const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  const link = html.match(/<a class="mainSiteLink"[^>]*>/)[0];
  assert.doesNotMatch(link, /target="_blank"/);
  const alternate = fs.readFileSync(path.join(root, 'dist/espace/espace.html'), 'utf8');
  assert.match(alternate, /src="\/app\/walletconnect.js\?id=20260921-wallet-session"/);
  for (const page of [html, alternate]) assert.match(page, /v-on:click="disconnectWallet">Disconnect<\/button>/);
});
