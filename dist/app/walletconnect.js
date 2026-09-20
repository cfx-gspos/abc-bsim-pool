(function (global) {
  'use strict';

  const PROJECT_ID_PATTERN = /^[0-9a-f]{32}$/i;
  const REQUIRED_METHODS = ['eth_sendTransaction', 'personal_sign'];
  const REQUIRED_EVENTS = ['accountsChanged', 'chainChanged'];
  let sdkPromise;
  let providerPromise;
  let walletConnectProvider;

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

    const provider = await EthereumProvider.init(providerOptions);
    provider.on('disconnect', () => {
      if (walletConnectProvider === provider) walletConnectProvider = null;
      providerPromise = null;
    });
    return provider;
  }

  async function connect(options) {
    const chainId = Number(options.chainId);
    if (!Number.isInteger(chainId) || !options.rpcUrl) {
      throw new Error('WalletConnect eSpace 网络配置不完整');
    }

    if (walletConnectProvider?.session && Number(walletConnectProvider.chainId) === chainId) {
      return walletConnectProvider;
    }

    if (!providerPromise) {
      providerPromise = createProvider(options).catch((error) => {
        providerPromise = null;
        throw error;
      });
    }

    const provider = await providerPromise;
    if (!provider.session) await provider.connect();
    walletConnectProvider = provider;
    return provider;
  }

  async function disconnect() {
    const provider = walletConnectProvider;
    walletConnectProvider = null;
    providerPromise = null;
    if (provider?.session) await provider.disconnect();
  }

  global.ABCWalletConnect = Object.freeze({
    connect,
    disconnect,
    isConfigured: () => PROJECT_ID_PATTERN.test(String(getConfig().projectId || '').trim()),
  });
})(window);
