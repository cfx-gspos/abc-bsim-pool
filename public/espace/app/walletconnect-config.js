(function (global) {
  'use strict';

  // Project ID 是前端公开标识，不是私钥；生产域名已在 Reown 控制台加入允许列表。
  global.ABC_WALLETCONNECT_CONFIG = Object.assign({
    projectId: 'b30741c24e2c6261993e564e415a761e',
    sdkUrl: '/app/walletconnect-provider.min.js',
    // BIM Wallet（BSIM 硬件卡钱包）Android 3.0.0 已注册 bimwallet:// 与 wc:。
    // Universal Link / Explorer ID 尚未在官方包中确认，留空时仍可扫码连接。
    bsimWallet: {
      id: 'bim-wallet',
      name: 'BIM Wallet (BSIM)',
      native: 'bimwallet://',
      universal: '',
      explorerId: '',
    },
  }, global.ABC_WALLETCONNECT_CONFIG || {});
})(window);
