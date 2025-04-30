import { ccc, mol } from "@ckb-ccc/core";
import { getHeader, type HeaderKey } from "./utils.js";
import type { UdtHandler } from "./udt.js";

/**
 * Class representing a smart transaction that extends the base ccc.Transaction.
 * This class manages UDT handlers and transaction headers, providing additional functionality
 * for handling UDTs and ensuring balanced transactions.
 *
 * Notes:
 * - udtHandlers and headers are always shared among descendants.
 * - headers may not contain all headers referenced by headerDeps.
 */
export class SmartTransaction extends ccc.Transaction {
  /**
   * Creates an instance of SmartTransaction.
   * @param version - The version of the transaction.
   * @param cellDeps - The cell dependencies for the transaction.
   * @param headerDeps - The header dependencies for the transaction.
   * @param inputs - The inputs for the transaction.
   * @param outputs - The outputs for the transaction.
   * @param outputsData - The data associated with the outputs.
   * @param witnesses - The witnesses for the transaction.
   * @param udtHandlers - A map of UDT handlers associated with the transaction.
   * @param headers - A map of headers associated with the transaction, indexed by
   *  their hash, number and possibly transaction hash.
   */
  constructor(
    version: ccc.Num,
    cellDeps: ccc.CellDep[],
    headerDeps: ccc.Hex[],
    inputs: ccc.CellInput[],
    outputs: ccc.CellOutput[],
    outputsData: ccc.Hex[],
    witnesses: ccc.Hex[],
    public udtHandlers: Map<string, UdtHandler>,
    public headers: Map<string, ccc.ClientBlockHeader>,
  ) {
    super(
      version,
      cellDeps,
      headerDeps,
      inputs,
      outputs,
      outputsData,
      witnesses,
    );
  }

  /**
   * Automatically adds change cells for both capacity and UDTs for which a handler is defined.
   * @param args - The parameters for the completeFee method.
   * @returns A promise that resolves to a tuple containing the quantity of added capacity cells
   * and a boolean indicating if an output capacity change cells was added.
   */
  override async completeFee(
    ...args: Parameters<ccc.Transaction["completeFee"]>
  ): Promise<[number, boolean]> {
    const signer = args[0];

    // Add change cells for all defined UDTs
    for (const { script: udt } of this.udtHandlers.values()) {
      await this.completeInputsByUdt(signer, udt);
    }

    // Double check that all UDTs are even out
    for (const { script: udt } of this.udtHandlers.values()) {
      const addedCount = await this.completeInputsByUdt(signer, udt);
      if (addedCount > 0) {
        throw Error("UDT Handlers did not produce a balanced Transaction");
      }
    }

    // Add capacity change cells
    const res = super.completeFee(...args);

    // Check that, if NervosDAO cells are included, then there are at most 64 output cells, see:
    // https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#gotchas
    const { hashType, codeHash } = await signer.client.getKnownScript(
      ccc.KnownScript.NervosDao,
    );
    const dao = ccc.Script.from({ codeHash, hashType, args: "0x" });
    const isDaoTx =
      this.inputs.some((c) => c.cellOutput?.type?.eq(dao)) ||
      this.outputs.some((c) => c.type?.eq(dao));
    if (isDaoTx && this.outputs.length > 64) {
      throw Error("More than 64 output cells in a NervosDAO transaction");
    }

    return res;
  }

  /**
   * Retrieves the balance of UDT inputs using the appropriate handler if it exists.
   * @param client - The client instance used to interact with the blockchain.
   * @param udtLike - The UDT script or script-like object.
   * @returns A promise that resolves to the balance of UDT inputs.
   */
  override getInputsUdtBalance(
    client: ccc.Client,
    udtLike: ccc.ScriptLike,
  ): Promise<ccc.FixedPoint> {
    const udt = ccc.Script.from(udtLike);
    return (
      this.getUdtHandler(udt)?.getInputsUdtBalance?.(client, this) ??
      super.getInputsUdtBalance(client, udt)
    );
  }

  /**
   * Retrieves the balance of UDT outputs using the appropriate handler if it exists.
   * @param client - The client instance used to interact with the blockchain.
   * @param udtLike - The UDT script or script-like object.
   * @returns A promise that resolves to the balance of UDT outputs.
   */
  override getOutputsUdtBalance(udtLike: ccc.ScriptLike): ccc.FixedPoint {
    const udt = ccc.Script.from(udtLike);
    return (
      this.getUdtHandler(udt)?.getOutputsUdtBalance?.(this) ??
      super.getOutputsUdtBalance(udt)
    );
  }

  /**
   * Asynchronously retrieves the total capacity of inputs, accounting for deposit withdrawals' extra capacity.
   * @param client - The client instance used to interact with the blockchain.
   * @returns A promise that resolves to the total capacity of inputs.
   */
  override async getInputsCapacity(client: ccc.Client): Promise<ccc.Num> {
    const { hashType, codeHash } = await client.getKnownScript(
      ccc.KnownScript.NervosDao,
    );
    const dao = ccc.Script.from({ codeHash, hashType, args: "0x" });

    return ccc.reduceAsync(
      this.inputs,
      async (total, input) => {
        // Get all cell info
        await input.completeExtraInfos(client);
        const { previousOutput: outPoint, cellOutput, outputData } = input;

        // Input is not well defined
        if (!cellOutput || !outputData) {
          throw Error("Unable to complete input");
        }
        const cell = ccc.Cell.from({
          outPoint,
          cellOutput,
          outputData,
        });

        total += cellOutput.capacity;

        // If not a NervosDAO Withdrawal Request cell, return
        if (outputData === "0x0000000000000000" || !cellOutput.type?.eq(dao)) {
          return total;
        }

        // Get header of NervosDAO cell and check its inclusion in HeaderDeps
        const withdrawHeader = await this.getHeader(client, {
          type: "txHash",
          value: outPoint.txHash,
        });

        // It's a withdrawal request cell, get header of previous deposit cell
        const depositHeader = await this.getHeader(client, {
          type: "number",
          value: mol.Uint64LE.decode(outputData),
        });

        return (
          total +
          ccc.calcDaoProfit(cell.capacityFree, depositHeader, withdrawHeader)
        );
      },
      ccc.Zero,
    );
  }

  /**
   * Gets the unique key for a UDT based on its script.
   * @param udt - The UDT script or script-like object.
   * @returns A string representing the unique key for the UDT in udtHandlers.
   */
  encodeUdtKey(udt: ccc.ScriptLike): string {
    return ccc.Script.from(udt).toBytes().toString();
  }

  /**
   * Retrieves the UDT handler associated with a given UDT.
   * @param udt - The UDT script or script-like object.
   * @returns The UdtHandler associated with the UDT, or undefined if not found.
   */
  getUdtHandler(udt: ccc.ScriptLike): UdtHandler | undefined {
    return this.udtHandlers.get(this.encodeUdtKey(udt));
  }

  /**
   * Checks if a UDT handler exists for a given UDT.
   * @param udt - The UDT script or script-like object.
   * @returns A boolean indicating whether a UDT handler exists for the UDT.
   */
  hasUdtHandler(udt: ccc.ScriptLike): boolean {
    return this.udtHandlers.has(this.encodeUdtKey(udt));
  }

  /**
   * Adds UDT handlers to the transaction, substituting in-place if a handler for the same UDT already exists.
   * @param udtHandlers - One or more UDT handlers to add.
   */
  addUdtHandlers(...udtHandlers: (UdtHandler | UdtHandler[])[]): void {
    udtHandlers.flat().forEach((udtHandler) => {
      this.udtHandlers.set(this.encodeUdtKey(udtHandler.script), udtHandler);
      this.addCellDeps(udtHandler.cellDeps);
    });
  }

  /**
   * Encode a header key based on the provided `HeaderKey` object.
   *
   * @param headerKey - An object of type `HeaderKey` that contains the type and value
   *   used to generate the header key.
   * @returns A string representing the generated header key, which is a combination
   *   of the type and the byte representation of the value.
   */
  encodeHeaderKey(headerKey: HeaderKey): string {
    const { type, value } = headerKey;

    return ccc.numFrom(value).toString() + type;
  }

  /**
   * Adds one or more transaction headers to headers, indexed by their hash, number, and optional transaction hash.
   *
   * This method accepts either a single `TransactionHeader` or an array of `TransactionHeader` objects.
   * It encodes the header's hash, number, and optional transaction hash into keys and ensures that each header
   * is uniquely stored. If a header with the same hash already exists, it retains the old header.
   *
   * @param headers - One or more transaction headers to be added. This can be a single `TransactionHeader`
   *   or an array of `TransactionHeader` objects.
   * @throws Error if two different hashes are found for the same header.
   */
  addHeaders(...headers: (TransactionHeader | TransactionHeader[])[]): void {
    headers.flat().forEach(({ header, txHash }) => {
      const { hash, number } = header;

      // Encode Hash, Number and possibly TxHash as header keys
      const keys = [
        this.encodeHeaderKey({
          type: "hash",
          value: hash,
        }),
        this.encodeHeaderKey({
          type: "number",
          value: number,
        }),
      ];
      if (txHash) {
        keys.push(
          this.encodeHeaderKey({
            type: "txHash",
            value: txHash,
          }),
        );
      }

      // Add Header by Hash, Number and possibly TxHash
      for (const key of keys) {
        const h = this.headers.get(key);
        if (!h) {
          this.headers.set(key, header);
        } else if (hash == h.hash) {
          // Keep old header
          header = h;
        } else {
          throw Error("Found two hashes for the same header");
        }
      }

      // Add Header to HeaderDeps
      if (!this.headerDeps.some((h) => h === hash)) {
        this.headerDeps.push(hash);
      }
    });
  }

  /**
   * Retrieves a block header based on the provided header key, caching the result for future use.
   *
   * This method first attempts to retrieve the header from a local cache. If the header is not found,
   * it fetches the header from the blockchain using the provided client and header key. After fetching,
   * it adds the header to the cache and verifies its presence in the header dependencies.
   *
   * @param client - An instance of `ccc.Client` used to interact with the blockchain.
   * @param headerKey - An object of type `HeaderKey` that specifies how to retrieve the header.
   * @returns A promise that resolves to a `ccc.ClientBlockHeader` representing the block header.
   * @throws Error if the header is not found in the header dependencies.
   */
  async getHeader(
    client: ccc.Client,
    headerKey: HeaderKey,
  ): Promise<ccc.ClientBlockHeader> {
    const key = this.encodeHeaderKey(headerKey);
    let header = this.headers.get(key);
    if (!header) {
      header = await getHeader(client, headerKey);
      const headerDepsLength = this.headerDeps.length;
      this.addHeaders({
        header,
        txHash: headerKey.type === "txHash" ? headerKey.value : undefined,
      });
      if (headerDepsLength !== this.headerDeps.length) {
        throw Error("Header was not present in HeaderDeps");
      }
    } else {
      // Double check that header is present in HeaderDeps
      const { hash } = header;
      if (!this.headerDeps.some((h) => h === hash)) {
        throw Error("Header not found in HeaderDeps");
      }
    }

    return header;
  }

  /**
   * Creates a default instance of SmartTransaction.
   * @returns A new instance of SmartTransaction with default values.
   */
  static override default(): SmartTransaction {
    return new SmartTransaction(
      0n,
      [],
      [],
      [],
      [],
      [],
      [],
      new Map(),
      new Map(),
    );
  }

  /**
   * Clones the transaction part and shares udtHandlers and headers.
   * @returns A new instance of SmartTransaction that is a clone of the current instance.
   */
  override clone(): SmartTransaction {
    const result = SmartTransaction.from(super.clone());
    result.udtHandlers = this.udtHandlers;
    result.headers = this.headers;
    return result;
  }

  /**
   * Copies data from an input transaction.
   * @param txLike - The transaction-like object to copy from.
   */
  override copy(txLike: SmartTransactionLike): void {
    const tx = SmartTransaction.from(txLike);
    this.version = tx.version;
    this.cellDeps = tx.cellDeps;
    this.headerDeps = tx.headerDeps;
    this.inputs = tx.inputs;
    this.outputs = tx.outputs;
    this.outputsData = tx.outputsData;
    this.witnesses = tx.witnesses;
    this.udtHandlers = tx.udtHandlers;
    this.headers = tx.headers;
  }

  /**
   * Creates a SmartTransaction from a Lumos transaction skeleton.
   * @param skeleton - The Lumos transaction skeleton to convert.
   * @returns A new instance of SmartTransaction created from the skeleton.
   */
  static override fromLumosSkeleton(
    skeleton: ccc.LumosTransactionSkeletonType,
  ): SmartTransaction {
    return SmartTransaction.from(super.fromLumosSkeleton(skeleton));
  }

  /**
   * Creates a SmartTransaction from an input transaction. It shares udtHandlers and headers.
   * @param txLike - The transaction-like object to create the SmartTransaction from.
   * @returns A new instance of SmartTransaction created from the input transaction.
   */
  static override from(txLike: SmartTransactionLike): SmartTransaction {
    if (txLike instanceof SmartTransaction) {
      return txLike;
    }

    const {
      version,
      cellDeps,
      headerDeps,
      inputs,
      outputs,
      outputsData,
      witnesses,
    } = ccc.Transaction.from(txLike);

    const udtHandlers = txLike.udtHandlers ?? new Map<string, UdtHandler>();
    const headers = txLike.headers ?? new Map<string, ccc.ClientBlockHeader>();

    return new SmartTransaction(
      version,
      cellDeps,
      headerDeps,
      inputs,
      outputs,
      outputsData,
      witnesses,
      udtHandlers,
      headers,
    );
  }
}

/**
 * Type representing a transaction-like object that can include additional properties
 * for smart contract handling.
 *
 * This type extends the `ccc.TransactionLike` type and adds optional properties for
 * user-defined token (UDT) handlers and transaction headers.
 */
export type SmartTransactionLike = ccc.TransactionLike & {
  /**
   * An optional map of user-defined token (UDT) handlers, where the key is a string
   * representing the UDT identifier and the value is an instance of `UdtHandler`.
   */
  udtHandlers?: Map<string, UdtHandler>;

  /**
   * An optional map of transaction headers, where the key is a string representing
   * the header identifier and the value is an instance of `ccc.ClientBlockHeader`.
   */
  headers?: Map<string, ccc.ClientBlockHeader>;
};

/**
 * Represents a transaction header that includes a block header and an optional transaction hash.
 */
export interface TransactionHeader {
  /**
   * The block header associated with the transaction, represented as `ccc.ClientBlockHeader`.
   */
  header: ccc.ClientBlockHeader;

  /**
   * An optional transaction hash associated with the transaction, represented as `ccc.HexLike`.
   * This property may be undefined if the transaction hash is not applicable.
   */
  txHash?: ccc.HexLike;
}

/**
 * Class representing a restricted transaction that extends SmartTransaction.
 * This class overrides certain methods to modify the behavior of the transaction,
 * particularly in how inputs are handled and cloned:
 *
 * - It will never call client.findCell for additional cells, for example when using completeFee.
 * - It will always retain inputs metadata when cloning, so it will not refetch InputCells.
 */
export class RestrictedTransaction extends SmartTransaction {
  /**
   * It does not complete the inputs for the transaction.
   * This method is overridden to disable fetching additional cells.
   * @param _0 - Unused parameter.
   * @param _1 - Unused parameter.
   * @param _2 - Unused parameter.
   * @param init - The initial value to accumulate.
   * @returns A promise that resolves to an object containing the count of added inputs
   * and the accumulated value.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  override async completeInputs<T>(
    _0: never,
    _1: never,
    _2: never,
    init: T,
  ): Promise<{ addedCount: number; accumulated?: T }> {
    // Disable completeInputs, so it will not fetch additional cells
    return {
      addedCount: 0,
      accumulated: init,
    };
  }

  /**
   * Creates a clone of the current RestrictedTransaction instance.
   * @returns A new instance of RestrictedTransaction with the same properties.
   * The inputs metadata is preserved to avoid refetching that data.
   */
  override clone(): RestrictedTransaction {
    const result = super.clone();
    result.inputs = [...this.inputs];
    return new RestrictedTransaction(result);
  }

  // Reimplement the rest of transformations where a new instance is created.

  /**
   * Creates an instance of RestrictedTransaction from a SmartTransaction.
   * @param tx - The SmartTransaction instance to create the RestrictedTransaction from.
   */
  constructor(tx: SmartTransaction) {
    super(
      tx.version,
      tx.cellDeps,
      tx.headerDeps,
      tx.inputs,
      tx.outputs,
      tx.outputsData,
      tx.witnesses,
      tx.udtHandlers,
      tx.headers,
    );
  }

  /**
   * Creates a default instance of RestrictedTransaction.
   * @returns A new instance of RestrictedTransaction with default values.
   */
  static override default(): RestrictedTransaction {
    return new RestrictedTransaction(super.default());
  }

  /**
   * Creates a RestrictedTransaction from a Lumos transaction skeleton.
   * @param skeleton - The LumosTransactionSkeletonType to create the RestrictedTransaction from.
   * @returns A new instance of RestrictedTransaction.
   */
  static override fromLumosSkeleton(
    skeleton: ccc.LumosTransactionSkeletonType,
  ): RestrictedTransaction {
    return new RestrictedTransaction(super.fromLumosSkeleton(skeleton));
  }

  /**
   * Creates a RestrictedTransaction from a transaction-like object.
   * @param txLike - The transaction-like object to create the RestrictedTransaction from.
   * @returns A new instance of RestrictedTransaction.
   */
  static override from(txLike: SmartTransactionLike): RestrictedTransaction {
    return new RestrictedTransaction(SmartTransaction.from(txLike));
  }
}
