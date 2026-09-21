(function (global) {
  'use strict';

  const PROJECT_ID_PATTERN = /^[0-9a-f]{32}$/i;
  const REQUIRED_METHODS = ['eth_sendTransaction', 'personal_sign'];
  const REQUIRED_EVENTS = ['accountsChanged', 'chainChanged'];
  const DISCONNECT_TIMEOUT_MS = 10000;
  const MAX_TIMER_DELAY_MS = 2147483647;
  const REVOKED_SESSION_PREFIX = 'abc:bim:disconnected:';
  let sdkPromise;
  let connectionPromise;
  let disconnectPromise;
  let walletConnectProvider;

  function disconnectedError(expired = false) {
    const error = new Error(expired ? 'Wallet session expired. Please reconnect BIM Wallet.' : 'Wallet disconnected.');
    error.code = 4900;
    return error;
  }

  function getSession(provider) {
    if (!provider.session) return undefined;
    const store = provider.signer?.client?.session;
    try {
      return store ? store.get(provider.session.topic) : provider.session;
    } catch (_) {
      return undefined;
    }
  }

  function wasDisconnected(topic) {
    try {
      return global.localStorage.getItem(REVOKED_SESSION_PREFIX + topic) !== null;
    } catch (_) {
      return false;
    }
  }

  function rememberDisconnect(topic) {
    try {
      // 只记录本网站主动断开的会话，网络失败或其他标签页不能复用它。
      global.localStorage.setItem(REVOKED_SESSION_PREFIX + topic, '1');
    } catch (_) {
      // 存储不可用时，当前页面仍立即清除连接。
    }
  }

  function validSession(provider) {
    const session = getSession(provider);
    return !!session && Number(session.expiry) * 1000 > Date.now() && !wasDisconnected(session.topic);
  }

  function closeProvider(provider) {
    let timer;
    const operation = Promise.race([
      Promise.resolve().then(() => provider.session && provider.disconnect()),
      new Promise((_, reject) => {
        timer = global.setTimeout(() => reject(new Error('Wallet disconnect timed out.')), DISCONNECT_TIMEOUT_MS);
      }),
    ]).finally(() => global.clearTimeout(timer));
    disconnectPromise = operation;
    const clear = () => { if (disconnectPromise === operation) disconnectPromise = null; };
    operation.then(clear, clear);
    return operation;
  }

  function watchSession(provider) {
    const topic = provider.session.topic;
    const client = provider.signer?.client;
    const listeners = new Map();
    let ended = false;
    let timer;
    let facade;

    function emit(event, value) {
      for (const listener of listeners.get(event) || []) listener(value);
    }

    function endSession(error, notifyWallet = false) {
      if (ended) return Promise.resolve();
      ended = true;
      global.clearTimeout(timer);
      global.removeEventListener('focus', refreshSession);
      global.removeEventListener('pageshow', refreshSession);
      global.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', refreshSession);
      for (const [event, handler] of Object.entries(providerHandlers)) provider.removeListener(event, handler);
      for (const [event, handler] of Object.entries(clientHandlers)) client?.off(event, handler);
      if (walletConnectProvider === facade) walletConnectProvider = null;
      if (notifyWallet) rememberDisconnect(topic);
      // 页面和旧签名接口立即失效，不等待远端钱包的网络响应。
      const closing = notifyWallet ? closeProvider(provider) : Promise.resolve();
      emit('disconnect', error);
      return closing;
    }

    function isSessionActive() {
      if (ended) return false;
      if (!validSession(provider) || provider.session?.topic !== topic) {
        endSession(disconnectedError(!wasDisconnected(topic)));
        return false;
      }
      return true;
    }

    function refreshSession() {
      global.clearTimeout(timer);
      if (!isSessionActive()) return;
      // 使用钱包真实到期时间；续期事件会重新安排计时，不另设一小时限制。
      const remaining = Number(getSession(provider).expiry) * 1000 - Date.now();
      timer = global.setTimeout(refreshSession, Math.min(remaining, MAX_TIMER_DELAY_MS));
    }

    function onStorage(event) {
      if (event.key === REVOKED_SESSION_PREFIX + topic || event.key === null) refreshSession();
    }

    const providerHandlers = {
      accountsChanged: (accounts) => {
        if (!accounts?.length) endSession(disconnectedError(), true).catch(() => {});
        else if (isSessionActive()) emit('accountsChanged', accounts);
      },
      chainChanged: (chainId) => { if (isSessionActive()) emit('chainChanged', chainId); },
      disconnect: () => endSession(disconnectedError()),
      session_delete: () => endSession(disconnectedError()),
    };
    const clientHandlers = {
      session_expire: (event) => { if (event.topic === topic) endSession(disconnectedError(true)); },
      session_delete: (event) => { if (event.topic === topic) endSession(disconnectedError()); },
      session_extend: (event) => { if (event.topic === topic) refreshSession(); },
      session_update: (event) => { if (event.topic === topic) refreshSession(); },
    };

    // ethers 使用的 EIP-1193 接口，防止过期或已断开的 provider 继续发起签名。
    facade = {
      get session() { return ended ? undefined : getSession(provider); },
      get chainId() { return provider.chainId; },
      isSessionActive,
      async request(args) {
        if (!isSessionActive()) throw disconnectedError(true);
        return provider.request(args);
      },
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
        return facade;
      },
      removeListener(event, listener) {
        listeners.get(event)?.delete(listener);
        return facade;
      },
      disconnect: () => endSession(disconnectedError(), true),
    };
    for (const [event, handler] of Object.entries(providerHandlers)) provider.on(event, handler);
    for (const [event, handler] of Object.entries(clientHandlers)) client?.on(event, handler);
    global.addEventListener('focus', refreshSession);
    global.addEventListener('pageshow', refreshSession);
    global.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', refreshSession);
    refreshSession();
    return facade;
  }

  function getConfig() {
    return global.ABC_WALLETCONNECT_CONFIG || {};
  }

  function assertConfigured() {
    const projectId = String(getConfig().projectId || '').trim();
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error('WalletConnect 尚未配置，请先在 app/walletconnect-config.js 填入 ABC 的 Reown Project ID');
    }
    return projectId;
  }

  function loadSdk() {
    if (global.ABCWalletConnectProvider?.EthereumProvider) {
      return Promise.resolve(global.ABCWalletConnectProvider.EthereumProvider);
    }
    if (sdkPromise) return sdkPromise;

    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = getConfig().sdkUrl || '/app/walletconnect-provider.min.js';
      script.async = true;
      script.onload = () => {
        const EthereumProvider = global.ABCWalletConnectProvider?.EthereumProvider;
        if (!EthereumProvider) {
          reject(new Error('WalletConnect SDK 加载成功，但未找到 EthereumProvider'));
          return;
        }
        resolve(EthereumProvider);
      };
      script.onerror = () => {
        sdkPromise = null;
        reject(new Error('WalletConnect SDK 加载失败，请检查网络或静态文件部署'));
      };
      document.head.appendChild(script);
    });

    return sdkPromise;
  }

  function buildMetadata() {
    const baseUrl = global.location.origin;
    return {
      name: 'ABC PoS Pool',
      description: 'ABC PoS Pool on Conflux eSpace',
      url: baseUrl,
      icons: [`${baseUrl}/logo192.png`],
    };
  }

  function buildQrModalOptions(config) {
    const qrModalOptions = { enableMobileFullScreen: true };
    const wallet = config.bsimWallet || {};
    const native = String(wallet.native || '').trim();
    const universal = String(wallet.universal || '').trim();
    const explorerId = String(wallet.explorerId || '').trim();

    if (native || universal) {
      const links = {};
      if (native) links.native = native;
      if (universal) links.universal = universal;
      qrModalOptions.mobileWallets = [{
        id: String(wallet.id || 'bim-wallet').trim(),
        name: String(wallet.name || 'BIM Wallet').trim(),
        links,
      }];
    }
    if (explorerId) qrModalOptions.explorerRecommendedWalletIds = [explorerId];
    return qrModalOptions;
  }

  async function createProvider(options) {
    const projectId = assertConfigured();
    const EthereumProvider = await loadSdk();
    const chainId = Number(options.chainId);
    const config = getConfig();
    const providerOptions = {
      projectId,
      chains: [chainId],
      methods: REQUIRED_METHODS,
      events: REQUIRED_EVENTS,
      rpcMap: { [chainId]: options.rpcUrl },
      showQrModal: true,
      disableProviderPing: true,
      metadata: buildMetadata(),
      qrModalOptions: buildQrModalOptions(config),
    };

    return EthereumProvider.init(providerOptions);
  }

  async function connect(options) {
    const chainId = Number(options.chainId);
    if (!Number.isInteger(chainId) || !options.rpcUrl) {
      throw new Error('WalletConnect eSpace 网络配置不完整');
    }

    if (walletConnectProvider?.isSessionActive() && Number(walletConnectProvider.chainId) === chainId) {
      return walletConnectProvider;
    }

    if (!connectionPromise) {
      connectionPromise = (async () => {
        if (walletConnectProvider) await walletConnectProvider.disconnect();
        if (disconnectPromise) await disconnectPromise;
        const provider = await createProvider(options);
        if (provider.session && (!validSession(provider) || Number(provider.chainId) !== chainId)) {
          await closeProvider(provider);
        }
        if (!provider.session) await provider.connect();
        if (!validSession(provider)) throw disconnectedError(true);
        walletConnectProvider = watchSession(provider);
        return walletConnectProvider;
      })().finally(() => { connectionPromise = null; });
    }
    return connectionPromise;
  }

  async function disconnect() {
    if (connectionPromise) await connectionPromise;
    if (walletConnectProvider) await walletConnectProvider.disconnect();
    else if (disconnectPromise) await disconnectPromise;
  }

  global.ABCWalletConnect = Object.freeze({
    connect,
    disconnect,
    isConfigured: () => PROJECT_ID_PATTERN.test(String(getConfig().projectId || '').trim()),
  });
})(window);
