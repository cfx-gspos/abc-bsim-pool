let coreClient = new TreeGraph.Conflux(CURRENT);
console.log('SDK version: ', coreClient.version);

let hashModal = new bootstrap.Modal(document.getElementById('hashModal'), {});
let withdrawModal = new bootstrap.Modal(document.getElementById('withdrawModal'), {});

const PoSPool = {
  watch: {
    'space.value'(newSpace, old) {
      console.log('Space change: ', newSpace);
      this.contract.setCurrentNetwork(newSpace);
      //
      if (newSpace === 'Core') {
        if (this.coreAccount) {
          this.userInfo.account = this.coreAccount;
          this.userInfo.connected = true;
          this.loadAllUserInfo();
        } else {
          this.userInfo.account = '';
          this.userInfo.connected = false;
          this.resetUserInfo();
        }
      } else if(newSpace === 'eSpace') {
        if (this.eSpaceAccount) {
          this.userInfo.account = this.eSpaceAccount;
          this.userInfo.connected = true;
          this.loadAllUserInfo();
        } else {
          this.userInfo.account = '';
          this.userInfo.connected = false;
          this.resetUserInfo();
        }
      }
      this.loadPoolInfo();
    } 
  },
  data() {
    return {
      space: spaceStore,
      config: configStore,
      chainStatus: {},
      poolInfo: {
        // status: 'Good', // TODO load the real pool status
        status: {},
        name: '',
        totalLocked: 0,
        totalRevenue: 0,
        userShareRatio: 0n,
        apy: 0,
        lastRewardTime: 0,
        stakerNumber: '0',
        posAddress: '',
        inCommittee: false,
      },
      userInfo: {
        balance: 0,
        connected: false,
        votes: 0n,
        available: 0n,
        userInterest: 0,
        account: '',
        locked: 0n,
        unlocked: 0n,
        userInQueue: [],
        userOutOueue: [],
        nftCount: 0,
      },
      stakeCount: 0,  // stake input value
      unstakeCount: 0, // unstake input value
      txhash: '',
      eSpaceBlockNumber: 0,
      eSpaceAccount: '',
      walletConnecting: false,
      walletDisconnecting: false,
      walletNotice: '',
      coreAccount: '',
    }
  },

  async created() {
 // Detect current network
 try{
    if (window.conflux) {
 
      let status = await confluxRequest({method: 'cfx_getStatus'});
      let netId = Number(status.chainId);
      if (netId === MAINNET.networkId) {
        CURRENT = MAINNET;
      } else if (netId === TESTNET.networkId) {
        CURRENT = TESTNET;
      }
    } else if (window.ethereum) {
 
      if (window.ethereum.networkVersion == MAINNET.eNetId) {
        CURRENT = MAINNET;
      } else if (window.ethereum.networkVersion == TESTNET.eNetId) {
        CURRENT = TESTNET;
      }
    }

}catch(ex){
      console.warn('Wallet network detection failed:', ex);
}
    console.log('Current network: ', CURRENT);
    this.config.value = CURRENT;
    coreClient = new TreeGraph.Conflux(CURRENT);
    
    this.contract = new PoSPoolContract({
      network: this.space.value,
      coreAddress: CURRENT.poolAddress,
      coreRpc: CURRENT.url,
      coreNetId: CURRENT.networkId,
      eSpaceAddress: CURRENT.eSpaceAddress,
      eSpaceRpc: CURRENT.eSpaceRpc,
    });
    
    // load pool info
    this.loadPoolInfo();
    await this.loadPoolMetaInfo();
    this.loadRewardChartData();

    if (CURRENT.networkId === MAINNET.networkId) {
      this.loadLastRewardTime();
      this.loadPosNodeStatus();
    }
  },

  mounted () {
    // toggle visibility of the app element
    const app = document.getElementById('app');
    app.setAttribute('class', 'container');
  },

  computed: {
    perFee() {
      return (10000n - this.poolInfo.userShareRatio) / 100n;
    },

    formatedTotalLocked() {
      return formatUnit(this.poolInfo.totalLocked.toString(), "CFX");
    },

    formatedTotalRevenue() {
      return formatUnit(this.poolInfo.totalRevenue.toString(), "CFX");
    },

    prettyTotalLocked() {
      const totalLocked = this.poolInfo.totalLocked;
      if (totalLocked === 0) return 0;
      return prettyFormat(totalLocked.toString());
    },

    prettyTotalRevenue() {
      const totalRevenue = this.poolInfo.totalRevenue;
      if (totalRevenue == 0) return 0;
      return prettyFormat(totalRevenue.toString());
    },

    userStakedCFX() {
      return this.userInfo.votes * BigInt(ONE_VOTE_CFX);
    },

    unstakeableCFX() {
      return this.userInfo.locked * BigInt(ONE_VOTE_CFX);
    },

    withdrawableCFX() {
      return this.userInfo.unlocked * BigInt(ONE_VOTE_CFX);
    },

    shortenAccount() {
      const account = this.userInfo.account;
      if (account.match(':')) {
        return TreeGraph.address.shortenCfxAddress(account);
      } else {
        return `${account.slice(0, 4)}...${account.slice(-4)}`;
      }
    },

    lastRewardTime() {
      const lastTime = new Date(this.poolInfo.lastRewardTime * 1000);
      return formatDateTime(lastTime);
    },

    shortPosAddress() {
      if (!this.poolInfo.posAddress) {
        return 'Loading...';
      }
      const start = this.poolInfo.posAddress.slice(0, 6);
      return `${start}...`;
    },

    posAddressLink() {
      return `${CURRENT.scanURL}/pos/accounts/${this.poolInfo.posAddress}`;
    },

    shortHash() {
      if (!this.txhash) return '';
      return this.txhash.slice(0, 10) + '...';
    },

    txScanLink() {
      if (!this.txhash) return '#';
      return `${CURRENT.scanURL}/transaction/${this.txHash}`;
    },

    vip() {
      const available = this.userInfo.available;
      if (available >= 1000) { // VIP4(100w) 2%
        return 4;
      } else if (available >= 100) { // VIP3(10w) 3%
        return 3;
      } else if (available >= 50){ // VIP2(5w) 4%
        return 2;
      } else if (available >= 10) { // VIP1(1w) 5%
        return 1;
      } else {
        return 0;
      }
    }
  },

  methods: {

    isCore() {
      return this.space.value === 'Core';
    },

    resetUserInfo() {
      this.userInfo = {
        balance: 0,
        connected: false,
        votes: 0n,
        available: 0n,
        userInterest: 0,
        account: '',
        locked: 0n,
        unlocked: 0n,
        userInQueue: [],
        userOutOueue: [],
        nftCount: 0,
      };
    },

    async loadCoreChainInfo() {
      const status = await coreClient.cfx.getStatus();
      this.chainStatus = status;
      return status;
    },

    parseESpaceChainId(chainId) {
      return typeof chainId === 'string' && chainId.toLowerCase().startsWith('0x')
        ? parseInt(chainId, 16)
        : Number(chainId);
    },

    async ensureESpaceNetwork(externalProvider) {
      const expectedChainId = Number(CURRENT.eNetId);
      const expectedChainHex = '0x' + expectedChainId.toString(16);
      let currentChainId = this.parseESpaceChainId(await externalProvider.request({ method: 'eth_chainId' }));
      if (currentChainId === expectedChainId) return;

      try {
        await externalProvider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: expectedChainHex }],
        });
      } catch (switchError) {
        if (switchError.code !== 4902) throw switchError;
        await externalProvider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: expectedChainHex,
            chainName: CURRENT.networkId === MAINNET.networkId ? 'Conflux eSpace' : 'Conflux eSpace Testnet',
            nativeCurrency: { name: 'Conflux', symbol: 'CFX', decimals: 18 },
            rpcUrls: [CURRENT.eSpaceRpc],
            blockExplorerUrls: [CURRENT.eSpaceScanURL],
          }],
        });
      }

      currentChainId = this.parseESpaceChainId(await externalProvider.request({ method: 'eth_chainId' }));
      if (currentChainId !== expectedChainId) {
        throw new Error('Please switch wallet to Conflux eSpace network');
      }
    },

    resetESpaceConnection(message = '') {
      if (this._eSpaceEventProvider?.removeListener && this._eSpaceProviderHandlers) {
        for (const [event, handler] of Object.entries(this._eSpaceProviderHandlers)) {
          this._eSpaceEventProvider.removeListener(event, handler);
        }
      }
      this._eSpaceEventProvider = null;
      this._eSpaceProviderHandlers = null;
      this._walletAttempt = (this._walletAttempt || 0) + 1;
      this._connectAttempt = (this._connectAttempt || 0) + 1;
      this.walletConnecting = false;
      this.eSpaceAccount = '';
      this.resetUserInfo();
      this.stakeCount = 0;
      this.unstakeCount = 0;
      this.walletNotice = message;
      if (this.contract?.eSpaceContract) {
        const readProvider = new ethers.providers.JsonRpcProvider(CURRENT.eSpaceRpc);
        this.contract.ethClient = readProvider;
        this.contract.eSpaceContract = this.contract.eSpaceContract.connect(readProvider);
      }
    },

    async disconnectWallet() {
      if (this.walletDisconnecting) return;
      this.walletDisconnecting = true;
      this.resetESpaceConnection('Disconnecting wallet…');
      try {
        await window.ABCWalletConnect.disconnect();
        this.walletNotice = 'Wallet disconnected.';
      } catch (_) {
        this.walletNotice = 'Disconnected on this page. Please also disconnect this site in BIM Wallet if it still appears connected.';
      } finally {
        this.walletDisconnecting = false;
      }
    },

    bindESpaceProviderEvents(externalProvider) {
      if (!externalProvider?.on || this._eSpaceEventProvider === externalProvider) return;

      if (this._eSpaceEventProvider?.removeListener && this._eSpaceProviderHandlers) {
        this._eSpaceEventProvider.removeListener('accountsChanged', this._eSpaceProviderHandlers.accountsChanged);
        this._eSpaceEventProvider.removeListener('chainChanged', this._eSpaceProviderHandlers.chainChanged);
        this._eSpaceEventProvider.removeListener('disconnect', this._eSpaceProviderHandlers.disconnect);
      }

      const resetESpaceAccount = () => {
        this.resetESpaceConnection();
      };
      const handlers = {
        accountsChanged: async (accounts) => {
          if (!accounts?.length) {
            resetESpaceAccount();
            return;
          }
          this.eSpaceAccount = accounts[0];
          if (!this.isCore()) {
            if (this.userInfo.account !== accounts[0]) this.resetUserInfo();
            this.userInfo.account = accounts[0];
            this.userInfo.connected = true;
            await this.loadAllUserInfo();
          }
        },
        chainChanged: (chainId) => {
          if (this.parseESpaceChainId(chainId) !== Number(CURRENT.eNetId)) {
            resetESpaceAccount();
            alert('Please switch wallet to Conflux eSpace network');
          }
        },
        disconnect: (error) => this.resetESpaceConnection(error?.message || 'Wallet disconnected.'),
      };

      externalProvider.on('accountsChanged', handlers.accountsChanged);
      externalProvider.on('chainChanged', handlers.chainChanged);
      externalProvider.on('disconnect', handlers.disconnect);
      this._eSpaceEventProvider = externalProvider;
      this._eSpaceProviderHandlers = handlers;
    },

    async connectESpaceProvider(externalProvider) {
      const attempt = (this._walletAttempt || 0) + 1;
      this._walletAttempt = attempt;
      this.bindESpaceProviderEvents(externalProvider);
      const accounts = await externalProvider.request({ method: 'eth_requestAccounts' });
      if (!accounts?.length) throw new Error('Request account failed');

      await this.ensureESpaceNetwork(externalProvider);
      if (attempt !== this._walletAttempt || (externalProvider.isSessionActive && !externalProvider.isSessionActive())) {
        throw new Error('Wallet session expired or disconnected. Please reconnect BIM Wallet.');
      }
      const provider = new ethers.providers.Web3Provider(externalProvider, 'any');
      this.contract.setESpaceProvider(provider);

      this.eSpaceAccount = accounts[0];
      this.userInfo.account = accounts[0];
      this.userInfo.connected = true;
      this.eSpaceBlockNumber = await provider.getBlockNumber();
      if (attempt !== this._walletAttempt) return;
      await this.loadAllUserInfo();
    },

    async connectWalletConnect() {
      if (this.walletConnecting || this.walletDisconnecting) return;
      if (this.isCore()) {
        alert('BIM / WalletConnect is currently available for eSpace');
        return;
      }
      this.walletConnecting = true;
      const connectAttempt = (this._connectAttempt || 0) + 1;
      this._connectAttempt = connectAttempt;
      this.walletNotice = '';
      try {
        const externalProvider = await window.ABCWalletConnect.connect({
          chainId: CURRENT.eNetId,
          rpcUrl: CURRENT.eSpaceRpc,
        });
        if (connectAttempt !== this._connectAttempt) return;
        await this.connectESpaceProvider(externalProvider);
      } catch (error) {
        if (connectAttempt !== this._connectAttempt) return;
        const message = error.code === 4001 ? 'Wallet connection cancelled.' : (error.message || 'Wallet connection failed.');
        if (!this.userInfo.connected) this.resetESpaceConnection(message);
        else this.walletNotice = message;
      } finally {
        if (connectAttempt === this._connectAttempt) this.walletConnecting = false;
      }
    },

    async connectWallet() {
      try {
        if (this.isCore()) {
          if (!window.conflux) {
            alert('Please install Conflux Wallet');
            return;
          }
          const accounts = await requestCoreAccounts();
          if (accounts.length === 0) {
            alert('Request account failed');
            return;
          }
          const account = accounts[0];
          this.userInfo.account = account;
          this.userInfo.connected = true;
          this.coreAccount = account;
          await this.loadAllUserInfo();
          this.loadUserNFTInfo();
          this.contract.setCoreProvider(window.conflux);
          await this.loadCoreChainInfo();

          if (this.chainStatus.chainId !== CURRENT.networkId) {
            alert('Please switch wallet to ' + CURRENT.networkId);
          }
          return;
        }

        if (!window.ethereum) {
          await this.connectWalletConnect();
          return;
        }
        await this.connectESpaceProvider(window.ethereum);
      } catch (error) {
        if (![4001, -32000, -32002].includes(error.code)) {
          alert(error.message || 'Connect wallet failed');
        }
      }
    },

    async loadAllUserInfo() {
      this.loadUserInfo();
      this.loadUserLockingList();
      this.loadUserUnlockingList();
    },

    mapQueueItem(item) {
      let now = new Date().getTime();
      let unlockTime;
      if (this.isCore()) {
        let unlockBlockNumber = Number(item.endBlock) - this.chainStatus.blockNumber;
        unlockTime = new Date(now + unlockBlockNumber / 2 * 1000);
      } else {
        let unlockBlockNumber = Number(item.endBlock) - this.eSpaceBlockNumber;
        unlockTime = new Date(now + unlockBlockNumber * 1000);
      }
      return {
        amount: voteToCFX(item.votePower),
        endTime: formatDateTime(unlockTime),
      }
    },

    async loadUserInfo() {
      const userInfo = this.userInfo;
      if (!userInfo.connected) return;
      const userSummary = await this.contract.userSummary(userInfo.account);
      if (this.userInfo !== userInfo) return;
      this.userInfo.votes = userSummary.votes;
      this.userInfo.available = userSummary.available;
      this.userInfo.locked = userSummary.locked;
      this.userInfo.unlocked = userSummary.unlocked;

      const userInterest = await this.contract.userInterest(userInfo.account);
      if (this.userInfo !== userInfo) return;
      this.userInfo.userInterest = trimPoints(TreeGraph.Drip(userInterest.toString()).toCFX());

      const balance = await this.contract.getBalance(userInfo.account);
      if (this.userInfo !== userInfo) return;
      this.userInfo.balance = trimPoints(TreeGraph.Drip(balance.toString()).toCFX());
    },

    // only need load once
    async loadPoolMetaInfo() {
      this.poolInfo.name = await this.contract.poolName();
      this.poolInfo.userShareRatio = await this.contract.poolUserShareRatio();
      let poolPosAddress = await this.contract.posAddress();
      this.poolInfo.posAddress = TreeGraph.format.hex(poolPosAddress);
    },

    async loadPosNodeStatus() {
      const account = await coreClient.pos.getAccount(this.poolInfo.posAddress);
      this.poolInfo.status = account.status;
    },

    async loadPoolInfo() {
      const poolSummary = await this.contract.poolSummary();
      this.poolInfo.totalLocked = poolSummary.available * BigInt(ONE_VOTE_CFX) * BigInt("1000000000000000000");
      this.poolInfo.totalRevenue = poolSummary.totalInterest;
      this.poolInfo.apy = Number(await this.contract.poolAPY()) / 100;

      const stakerNumber = await this.contract.stakerNumber();
      this.poolInfo.stakerNumber = stakerNumber.toString();
    },

    async loadLastRewardTime() {
      const {epoch} = await coreClient.pos.getStatus();
      let lastReward = await coreClient.pos.getRewardsByEpoch(epoch - 1);
      if (!lastReward) {
        lastReward = await coreClient.pos.getRewardsByEpoch(epoch - 2);
      }
      const block = await coreClient.cfx.getBlockByHash(lastReward.powEpochHash, false);
      this.poolInfo.lastRewardTime = block.timestamp;
    },

    async loadUserLockingList() {
      const userInfo = this.userInfo;
      if (!userInfo.connected) return;
      const list = await this.contract.userInQueue(userInfo.account);
      if (this.userInfo !== userInfo) return;
      const queue = await Promise.all(list.map(item => this.mapQueueItem(item)));
      if (this.userInfo === userInfo) userInfo.userInQueue = queue;
    },

    async loadUserUnlockingList() {
      const userInfo = this.userInfo;
      if (!userInfo.connected) return;
      const list = await this.contract.userOutQueue(userInfo.account);
      if (this.userInfo !== userInfo) return;
      const queue = await Promise.all(list.map(item => this.mapQueueItem(item)));
      if (this.userInfo === userInfo) userInfo.userOutOueue = queue;
    },

    async loadUserNFTInfo() {
      if (!CURRENT.nftAddress) return;
      nftContract = coreClient.Contract({
        abi: PoSNFTABI,
        address: CURRENT.nftAddress
      });
      const count = await nftContract.balanceOf(this.userInfo.account);
      this.userInfo.nftCount = Number(count.toString());
    },

    async stake() {
      if (this.stakeCount === 0 || this.stakeCount % ONE_VOTE_CFX != 0 ) {
        alert('Stake count should be multiple of 1000');
        return;
      }
      if (Number(this.userInfo.balance) < Number(this.stakeCount)) {
        alert('Insufficient balance');
        return;
      }

      const hash = await this
        .contract
        .increaseStake(this.stakeCount, this.userInfo.account);
      this.txHash = hash;
      hashModal.show();

      this.contract.waitTx(hash).then(receipt => {
        hashModal.hide();
        if (receipt.status === 0) { // success
          this.loadUserInfo();
          this.loadUserLockingList();
          this.stakeCount = 0;  // clear stake count
        } else {
          alert('Stake failed');
        }
      });
    }, 

    async claim() {
      if (this.userInfo.userInterest == 0 ) {
        alert('No claimable interest');
        return;
      }
      let hash = await this
        .contract
        .claimAllInterest(this.userInfo.account);
      this.txHash = hash;
      hashModal.show();

      this.contract.waitTx(hash).then(receipt => {
        hashModal.hide();
        if (receipt.status === 0) {
          this.loadUserInfo();
        } else {
          alert('Claim failed');
        }
      });
    }, 

    async unstake() {
      if (this.userInfo.locked === BigInt(0)) {
        alert('No unstakeable funds');
        return;
      }
      if (this.unstakeCount === 0 || this.unstakeCount % ONE_VOTE_CFX != 0 ) {
        alert('Unstake count should be multiple of 1000');
        return;
      }
      const unstakeVotePower = this.unstakeCount / ONE_VOTE_CFX;

      let hash = await this
        .contract
        .decreaseStake(unstakeVotePower, this.userInfo.account);

      this.txHash = hash;
      hashModal.show();

      this.contract.waitTx(hash).then(receipt => {
        hashModal.hide();
        if (receipt.status === 0) {
          this.loadUserInfo();
          this.loadUserUnlockingList();
          this.unstakeCount = 0;  // clear unstake count
        } else {
          alert('UnStake failed');
        }
      });
    },

    async withdraw() {
      if (this.userInfo.unlocked === BigInt(0)) {
        alert('No withdrawable funds');
        return;
      }

      try {
        console.log(488,Number(this.userInfo.unlocked),this.userInfo.unlocked,this.userInfo.account,'aaaaaaaaaaaaaaaaa')
        let hash = await this
          .contract    
 .withdrawStake(Number(this.userInfo.unlocked), this.userInfo.account);
//.withdrawStake(12, this.userInfo.account);
  // .withdrawStake(this.userInfo.unlocked, this.userInfo.account);
console.log(492,hash)
        this.txHash = hash;
        hashModal.show();
console.log(495)
        this.contract.waitTx(hash).then(receipt => {
          hashModal.hide();
          if (receipt.status === 0) {
            this.loadUserInfo();
          } else {
            alert('Withdraw failed');
          }
        });
      } catch(err) {
        console.log(506,err)
        console.log("The unlock time is estimated by PoW block number is not very accurate. Your votes is still unlocking, please try again several hours later", err);
        withdrawModal.show();
      }
    },

    loadRewardChartData() {
      let posAddress = this.poolInfo.posAddress;
      const url = `${CURRENT.scanURL}/stat/list-pos-account-reward?identifier=${posAddress}&limit=20&orderBy=createdAt&reverse=true`;
      fetch(url)
        .then(response => response.json())
        .then(initLineChart);
    }
  }
};

Vue.createApp(PoSPool).mount('#app');

function initLineChart(rewards) {
  const { list } = rewards;
  if (list.length === 0) return;
  const labels = list.map(item => formatTime(new Date(item.createdAt)));
  const items = list.map(item => {
    const formated = formatUnit(item.reward, 'CFX');
    const onlyValue = formated.split(' ')[0];
    return Number(onlyValue);
  });

  const data = {
    labels: labels.reverse(),
    datasets: [{
      label: 'Rewards Per Hour (CFX)',
      backgroundColor: 'rgb(66, 184, 131)',
      borderColor: 'cornflowerblue',
      data: items.reverse(),
    }]
  };

  const config = {
    type: 'line',
    data: data,
    options: {}
  };

  document.getElementById('rewardChartContainer').removeAttribute('style');
  const chartEle = document.getElementById('rewardChart')
  const rewardChart = new Chart(chartEle, config);
  return rewardChart;
}
