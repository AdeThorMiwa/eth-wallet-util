import { EventEmitter } from "events";
import HdKey from "hdkey";
import Web3 from "web3";
import BigNumber from "bignumber.js";
import { generateMnemonic, mnemonicToSeed } from "bip39";
import {
  privateToPublic,
  publicToAddress,
  toChecksumAddress,
} from "ethereumjs-util";
import { Transaction as Tx } from "ethereumjs-tx";
import erc20Tokens from "./tokens";
import erc20ContractAbi from "./abis/erc20";
import {
  NetTypes,
  WalletTypes,
  TokenTypes,
  EventType,
  IWalletClass,
  IWallet,
  ITransaction,
  ICreateWalletOptions,
  IGetBalanceOptions,
  ISend,
  BN,
  TToken,
  IEstimate,
} from "./types";

export default class Wallet extends EventEmitter implements IWalletClass {
  net: NetTypes;
  provider: Web3;
  socketProvider: Web3;
  private static DEFAULT_DERIVATION_PATH = "m/44'/60'/0'/0/0";

  constructor(net: NetTypes = NetTypes.TEST) {
    super();
    this.net = net;
    this.provider = this.initProvider(
      `https://${
        net === NetTypes.MAIN ? "mainnet" : "ropsten"
      }.infura.io/v3/c01fb7971b8747c58f5035e4a5a7f6d2`
    );
    this.socketProvider = this.initSocketProvider(
      `wss://${
        net === NetTypes.MAIN ? "mainnet" : "ropsten"
      }.infura.io/ws/v3/c0c01fb7971b8747c58f5035e4a5a7f6d21fb7971b8747c58f5035e4a5a7f6d2`
    );
  }

  public static newInstance(net: NetTypes) {
    return new Wallet(net);
  }

  public setNet(net: NetTypes) {
    this.net = net;
  }

  public setJsonRcpUrl(url: string) {
    this.initProvider(url);
  }

  private initProvider(url: string) {
    this.provider = new Web3(url);
    return this.provider;
  }

  private initSocketProvider(url: string) {
    this.socketProvider = new Web3(url);
    return this.socketProvider;
  }

  /**
   * Create a new ethereum wallet with erc20 token support
   * @param type the type of wallet to be create (DEFAULT | HD | MultiSig)
   */
  public async createWallet(opts?: ICreateWalletOptions): Promise<IWallet> {
    if (opts && opts.type === WalletTypes.MULTISIG) {
      throw new Error("Wallet type not supported yet.");
    }

    const mnemonics = opts?.mnemonics || generateMnemonic();

    const seed = await mnemonicToSeed(mnemonics);

    const root = HdKey.fromMasterSeed(seed);

    const addressNode = root.derive(Wallet.DEFAULT_DERIVATION_PATH);

    const privateKey = opts?.privateKey
      ? Buffer.from(opts?.privateKey)
      : addressNode.privateKey;

    const pubKey = privateToPublic(privateKey);
    const address = "0x" + publicToAddress(pubKey).toString("hex");
    const checkSumAddress = toChecksumAddress(address);

    return {
      address,
      checkSumAddress,
      publicKey: addressNode.publicKey.toString("hex"),
      privateKey: privateKey.toString("hex"),
      mnemonics,
    };
  }

  public async estimateFees(opts: ISend): Promise<IEstimate> {
    const { from, to, token, amount } = opts;
    const trxCount = await this.transactionCount(from);
    const nonce: unknown = this.provider.utils.toHex(trxCount);
    const gasPrice = await this.provider.eth.getGasPrice();

    let trxObj = {};
    if (token && !this.isEth(token)) {
      const netSupportedTokens: TToken[] = erc20Tokens[this.net];
      const _token = netSupportedTokens.find(
        (t) => t.symbol === (token || "").toLowerCase()
      );
      const contractAddress = _token ? _token.contractAddress : "";

      const contract = this.getTokenContract(token, contractAddress, from);

      const _amount = this.provider.utils.toBN(amount);
      const decimal = this.provider.utils.toBN(_token ? _token.decimals : 18);
      const value = _amount.mul(this.provider.utils.toBN(10).pow(decimal));
      const data = contract.methods.transfer(to, value.toString()).encodeABI();

      trxObj = {
        nonce: nonce as number,
        to: contractAddress,
        data,
      };

      const gasLimit = await this.provider.eth.estimateGas({
        ...trxObj,
        from,
      });

      trxObj = {
        ...trxObj,
        value: "0x0",
        gasLimit,
        gasPrice,
      };
    } else {
      const value = this.provider.utils.toHex(
        this.provider.utils.toWei(amount, "ether")
      );

      trxObj = {
        nonce: nonce as number,
        to,
        value,
      };

      const gasLimit = await this.provider.eth.estimateGas({
        ...trxObj,
        from,
      });

      trxObj = {
        ...trxObj,
        gasLimit,
        gasPrice,
      };
    }

    return trxObj as IEstimate;
  }

  public async send(
    opts: IEstimate & { privKey: string }
  ): Promise<ITransaction> {
    const { to, nonce, value, data, gasLimit, gasPrice, privKey } = opts;

    const trxObj = {
      nonce,
      to,
      value,
      gasLimit: this.provider.utils.toHex(gasLimit),
      gasPrice: this.provider.utils.toHex(gasPrice),
      data,
    };

    const trx = new Tx(trxObj, {
      chain: this.net === NetTypes.MAIN ? "mainnet" : "ropsten",
    });

    trx.sign(Buffer.from(privKey, "hex"));

    const serialized = trx.serialize();
    const raw = "0x" + serialized.toString("hex");

    const transaction = await this.broadcastTransaction(raw);
    return transaction as ITransaction;
  }

  /**
   * Get the token balance of given address - gets the ether balance default
   * @param address The address to get it's balance
   * @param token The balance of which token to get - Defaults to ether (eth)
   */
  public async getBalance(opts: IGetBalanceOptions): Promise<string> {
    let balance: BN | string = "";

    if (opts.token && !this.isEth(opts.token)) {
      const netSupportedTokens: TToken[] = erc20Tokens[this.net];
      const token = netSupportedTokens.find(
        (token) => token.symbol === (opts.token || "").toLowerCase()
      );
      const contractAddress = token ? token.contractAddress : "";

      const contract = this.getTokenContract(opts.token, contractAddress);

      const bigNumberBalance = new BigNumber(
        Number(await this.contractBalanceOf(contract, opts.address))
      );
      const bigNumberDecimal = new BigNumber(10).exponentiatedBy(
        token?.decimals || 18
      );

      balance = bigNumberBalance.dividedBy(bigNumberDecimal).toString();
    } else {
      balance = this.provider.utils.fromWei(
        await this.balanceOf(opts.address),
        "ether"
      );
    }

    return balance as string;
  }

  /**
   * Generate a new address for a given HD wallet (provided it's mnemonic's available)
   * @param mnemonics The HD wallet's mnemonics code for address generation
   * @param derivationIndex The derivation index for the address to be generated
   */
  public async generateAddress(
    mnemonics: string,
    derivationIndex: number = 1
  ): Promise<any> {
    if (!this.isValidMnemonic(mnemonics)) throw new Error("Invalid Mnemonics");
    const seed = await mnemonicToSeed(mnemonics);

    const root = HdKey.fromMasterSeed(seed);
    const masterPrivateKey = root.privateKey.toString("hex");
    const masterPublicKey = root.publicKey.toString("hex");

    const addressNode = root.derive(`m/44'/60'/0'/0/${derivationIndex}`);
    const pubKey = privateToPublic(addressNode.privateKey);
    const address = "0x" + publicToAddress(pubKey).toString("hex");
    const checkSumAddress = toChecksumAddress(address);

    return {
      address,
      checkSumAddress,
      publicKey: masterPublicKey,
      privateKey: masterPrivateKey,
      mnemonics,
    };
  }

  /**
   * Get a transaction by it's hash
   * @param trxHash the transaction's hash
   */
  public async getTransaction(trxHash: string): Promise<ITransaction> {
    return (await this.provider.eth.getTransaction(trxHash)) as ITransaction;
  }

  /**
   * adds an address to the monitoring subscription
   */
  public subscribe(vault: string[]): void {
    const subscription = this.socketProvider.eth.subscribe(
      "pendingTransactions",
      (err) => {
        if (err) console.error(err);
      }
    );

    subscription.on("data", (hash) => {
      this.emit(EventType.DATA, hash);
      setTimeout(async () => {
        try {
          const tx = await this.provider.eth.getTransaction(hash);
          if (tx && tx.to && vault.includes(tx.to)) {
            this.emit(EventType.NEW_PAYMENT, tx);
          }
        } catch (e) {
          this.emit(EventType.UNCONFIRMED, e, hash);
        }
      }, 1000 * 60 * 3);
    });
  }

  private balanceOf(address: string, defaultBlock?: any): Promise<string | BN> {
    return new Promise((res, rej) => {
      if (defaultBlock) {
        this.provider.eth.getBalance(address, defaultBlock, (err, balance) => {
          if (err) rej(err);
          res(balance);
        });
      } else {
        this.provider.eth.getBalance(address, (err, balance) => {
          if (err) rej(err);
          res(balance);
        });
      }
    });
  }

  private getTokenContract(
    token: TokenTypes,
    contractAddress: string,
    from?: string
  ) {
    return new this.provider.eth.Contract(
      erc20ContractAbi[token],
      contractAddress,
      { from }
    );
  }

  private contractBalanceOf(contract: any, address: string): Promise<any> {
    return new Promise((res, rej) => {
      contract.methods.balanceOf(address).call((err: any, balanceOf: any) => {
        if (err) rej(err);
        res(balanceOf);
      });
    });
  }

  private transactionCount(address: string): Promise<number> {
    return new Promise((res, rej) => {
      this.provider.eth.getTransactionCount(address, (err, count) => {
        if (err) rej(err);
        res(count);
      });
    });
  }

  private broadcastTransaction(rawTrx: string): Promise<any> {
    return new Promise((res, rej) => {
      this.provider.eth
        .sendSignedTransaction(rawTrx)
        .on("receipt", (receipt) => {
          if (!receipt) rej("Broadcast Transaction Failed!");
          res(receipt);
        });
    });
  }

  private isEth(token: string): boolean {
    return token === TokenTypes.ETH;
  }

  private isValidMnemonic(phrase: string): boolean {
    return phrase.trim().split(/\s+/g).length >= 12;
  }
}
