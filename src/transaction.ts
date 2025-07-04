import { ccc, mol } from "@ckb-ccc/core";
import { getHeader, hexFrom, type HeaderKey } from "./utils.js";
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
   *
   * @param version - The version of the transaction.
   * @param cellDeps - The cell dependencies for the transaction.
   * @param headerDeps - The header dependencies for the transaction.
   * @param inputs - The inputs for the transaction.
   * @param outputs - The outputs for the transaction.
   * @param outputsData - The data associated with the outputs.
   * @param witnesses - The witnesses for the transaction.
   * @param udtHandlers - A map of UDT handlers associated with the transaction.
   * @param headers - A map of headers associated with the transaction, indexed by their hash, number, and possibly transaction hash.
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
   *
   * @param args - The parameters for the completeFee method, as defined by ccc.Transaction["completeFee"].
   * @returns A promise that resolves to a tuple:
   *          [number, boolean] where the number is the quantity of added input cells and the boolean
   *          indicates if an output change cell was added.
   *
   * The function will:
   * - Add change cells for all the defined UDTs using udtHandlers's completeUdt.
   * - Add capacity change cells via the superclass method.
   * - Enforce a condition on NervosDAO transactions to have at most 64 output cells.
   */
  override async completeFee(
    ...args: Parameters<ccc.Transaction["completeFee"]>
  ): Promise<[number, boolean]> {
    const signer = args[0];
    const options = args[4];

    let inAdded = 0;
    let addedChange = false;

    // Add change cells for all defined UDTs.
    for (const handler of this.udtHandlers.values()) {
      const res = await handler.completeUdt(signer, this, options);
      inAdded += res[0];
      addedChange ||= res[1];
    }

    // Add capacity change cells.
    const res = await super.completeFee(...args);
    inAdded += res[0];
    addedChange ||= res[1];

    // Check that, if NervosDAO cells are included, then there are at most 64 output cells.
    // See: https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md#gotchas
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

    return [inAdded, addedChange];
  }

  /**
   * Retrieves the balance of UDT inputs using the appropriate handler if it exists.
   *
   * @param client - The client instance used to interact with the blockchain.
   * @param udtLike - The UDT script or script-like object.
   * @returns A promise that resolves to the balance of UDT inputs as a ccc.FixedPoint.
   *
   * If a custom UDT handler exists for the provided UDT, its getInputsUdtBalance method is used.
   * Otherwise, the balance is derived from the superclass's implementation.
   */
  override getInputsUdtBalance(
    client: ccc.Client,
    udtLike: ccc.ScriptLike,
  ): Promise<ccc.FixedPoint> {
    const udt = ccc.Script.from(udtLike);
    return (
      this.getUdtHandler(udt)
        ?.getInputsUdtBalance(client, this)
        .then((b) => b[0]) ?? super.getInputsUdtBalance(client, udt)
    );
  }

  /**
   * Retrieves the balance of UDT outputs using the appropriate handler if it exists.
   *
   * @param udtLike - The UDT script or script-like object.
   * @returns The balance of UDT outputs as a ccc.FixedPoint.
   *
   * If a custom UDT handler exists for the provided UDT, its getOutputsUdtBalance method is used.
   * Otherwise, the balance is derived from the superclass's implementation.
   */
  override getOutputsUdtBalance(udtLike: ccc.ScriptLike): ccc.FixedPoint {
    const udt = ccc.Script.from(udtLike);
    return (
      this.getUdtHandler(udt)?.getOutputsUdtBalance(this)[0] ??
      super.getOutputsUdtBalance(udt)
    );
  }

  /**
   * Asynchronously retrieves the total capacity of inputs, taking into account the extra capacity
   * produced by deposit withdrawals.
   *
   * @param client - The client instance used to interact with the blockchain.
   * @returns A promise that resolves to the total capacity of inputs as a ccc.Num.
   *
   * The method works by:
   * - Iterating over all inputs.
   * - Completing extra information for each input.
   * - Summing the capacities.
   * - Recognizing and then compensating for NervosDAO withdrawal requests by calculating DAO profits.
   */
  override async getInputsCapacity(client: ccc.Client): Promise<ccc.Num> {
    const { hashType, codeHash } = await client.getKnownScript(
      ccc.KnownScript.NervosDao,
    );
    const dao = ccc.Script.from({ codeHash, hashType, args: "0x" });

    return ccc.reduceAsync(
      this.inputs,
      async (total, input) => {
        // Get all cell information.
        await input.completeExtraInfos(client);
        const { previousOutput: outPoint, cellOutput, outputData } = input;

        // Input is not well defined.
        if (!cellOutput || !outputData) {
          throw Error("Unable to complete input");
        }
        const cell = ccc.Cell.from({
          outPoint,
          cellOutput,
          outputData,
        });

        total += cellOutput.capacity;

        // If not a NervosDAO Withdrawal Request cell, return the running total.
        if (outputData === "0x0000000000000000" || !cellOutput.type?.eq(dao)) {
          return total;
        }

        // For a withdrawal request cell, retrieve the corresponding deposit header and calculate the profit.
        const withdrawHeader = await this.getHeader(client, {
          type: "txHash",
          value: outPoint.txHash,
        });

        const depositHeader = await this.getHeader(client, {
          type: "number",
          value: mol.Uint64LE.decode(outputData),
        });

        return (
          total +
          ccc.calcDaoProfit(cell.capacityFree, depositHeader, withdrawHeader)
        );
      },
      0n,
    );
  }

  /**
   * Gets the unique key for a UDT based on its script.
   *
   * @param udt - The UDT script or script-like object.
   * @returns A string representing the unique key for the UDT in the udtHandlers map.
   */
  encodeUdtKey(udt: ccc.ScriptLike): string {
    return hexFrom(ccc.Script.from(udt));
  }

  /**
   * Retrieves the UDT handler associated with a given UDT.
   *
   * @param udt - The UDT script or script-like object.
   * @returns The UdtHandler for the provided UDT, or undefined if no handler exists.
   */
  getUdtHandler(udt: ccc.ScriptLike): UdtHandler | undefined {
    return this.udtHandlers.get(this.encodeUdtKey(udt));
  }

  /**
   * Checks if a UDT handler exists for a given UDT.
   *
   * @param udt - The UDT script or script-like object.
   * @returns True if a handler exists for the provided UDT; otherwise, false.
   */
  hasUdtHandler(udt: ccc.ScriptLike): boolean {
    return this.udtHandlers.has(this.encodeUdtKey(udt));
  }

  /**
   * Adds UDT handlers to the transaction.
   *
   * @param udtHandlers - One or more UDT handlers (or arrays of them) to add.
   *
   * For every added UDT handler, the method:
   * - Adds or substitutes the handler in the udtHandlers map.
   * - Adds the handler's cell dependencies to the transaction.
   */
  addUdtHandlers(...udtHandlers: (UdtHandler | UdtHandler[])[]): void {
    udtHandlers.flat().forEach((udtHandler) => {
      this.udtHandlers.set(this.encodeUdtKey(udtHandler.script), udtHandler);
      this.addCellDeps(udtHandler.cellDeps);
    });
  }

  /**
   * Encodes a header key based on the provided HeaderKey object.
   *
   * @param headerKey - An object containing the type and value used to generate the header key.
   * @returns A string representing the generated header key, combining the type and the byte representation of the value.
   */
  encodeHeaderKey(headerKey: HeaderKey): string {
    const { type, value } = headerKey;
    return hexFrom(value) + type;
  }

  /**
   * Adds one or more transaction headers to the headers cache, indexed by their hash, number, and optional transaction hash.
   *
   * @param headers - One or more TransactionHeader objects (or arrays of them) to be added.
   * @throws Error if two different headers (by hash) are found for the same encoded key.
   *
   * The method:
   * - Encodes keys from header hash, number, and (optionally) transaction hash.
   * - Stores headers uniquely, retaining the old header if one already exists for a key.
   * - Adds the header's hash to headerDeps if not already present.
   */
  addHeaders(...headers: (TransactionHeader | TransactionHeader[])[]): void {
    headers.flat().forEach(({ header, txHash }) => {
      const { hash, number } = header;
      // Encode Hash, Number and possibly TxHash as header keys.
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

      // Add Header by each key. Retain the old header if one already exists with the same hash.
      for (const key of keys) {
        const h = this.headers.get(key);
        if (!h) {
          this.headers.set(key, header);
        } else if (hash == h.hash) {
          // Keep old header.
          header = h;
        } else {
          throw Error("Found two hashes for the same header");
        }
      }

      // Add the header's hash to headerDeps if not already present.
      if (!this.headerDeps.some((h) => h === hash)) {
        this.headerDeps.push(hash);
      }
    });
  }

  /**
   * Retrieves a block header based on the provided header key, caching the result for future use.
   *
   * @param client - An instance of ccc.Client used to interact with the blockchain.
   * @param headerKey - An object of type HeaderKey specifying how to retrieve the header.
   * @returns A promise that resolves to a ccc.ClientBlockHeader representing the fetched block header.
   * @throws Error if the header cannot be added to or found in header dependencies.
   *
   * The method:
   * - Attempts to retrieve the header from a local cache.
   * - If not found, fetches it from the blockchain.
   * - Caches the retrieved header and ensures it is present in headerDeps.
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
      // Double check that header is present in headerDeps.
      const { hash } = header;
      if (!this.headerDeps.some((h) => h === hash)) {
        throw Error("Header not found in HeaderDeps");
      }
    }

    return header;
  }

  /**
   * Creates a default instance of SmartTransaction.
   *
   * @returns A new instance of SmartTransaction with default values.
   *
   * The default instance has:
   * - version set to 0n,
   * - empty arrays for cellDeps, headerDeps, inputs, outputs, outputsData and witnesses,
   * - new Maps for udtHandlers and headers.
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
   *
   * @returns A new instance of SmartTransaction that is a clone of the current instance.
   *
   * Note that the method reuses the udtHandlers and headers maps to ensure that they are shared among descendants.
   */
  override clone(): SmartTransaction {
    const result = SmartTransaction.from(super.clone());
    result.udtHandlers = this.udtHandlers;
    result.headers = this.headers;
    return result;
  }

  /**
   * Copies data from an input transaction.
   *
   * @param txLike - The transaction-like object to copy data from.
   *
   * This method copies the transaction details including cellDeps, headerDeps, inputs,
   * outputs, outputsData and witnesses. If the udtHandlers or headers instances differ,
   * their entries are merged from the source transaction.
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
    // If udtHandlers are different, merge entries from tx's udtHandlers into this.udtHandlers.
    if (this.udtHandlers !== tx.udtHandlers) {
      for (const [k, h] of tx.udtHandlers.entries()) {
        this.udtHandlers.set(k, h);
      }
    }
    // If headers are different, merge entries from tx's headers into this.headers.
    if (this.headers !== tx.headers) {
      for (const [k, h] of tx.headers.entries()) {
        this.headers.set(k, h);
      }
    }
  }

  /**
   * Creates a SmartTransaction from a Lumos transaction skeleton.
   *
   * @param skeleton - The Lumos transaction skeleton to convert.
   * @returns A new instance of SmartTransaction created from the provided skeleton.
   *
   * This method converts the given Lumos skeleton into a SmartTransaction using the base class conversion,
   * and then adapting it for the SmartTransaction type.
   */
  static override fromLumosSkeleton(
    skeleton: ccc.LumosTransactionSkeletonType,
  ): SmartTransaction {
    return SmartTransaction.from(super.fromLumosSkeleton(skeleton));
  }

  /**
   * Creates a SmartTransaction from an input transaction-like object.
   *
   * @param txLike - The transaction-like object to create the SmartTransaction from.
   *                 May contain missing udtHandlers and headers, which will be defaulted to new Maps.
   * @returns A new instance of SmartTransaction created from the input transaction.
   *
   * If the input object is already an instance of SmartTransaction, it is returned directly.
   * Otherwise, a new SmartTransaction is constructed by copying properties from the input.
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
   * An optional transaction hash associated with the transaction, represented as `ccc.Hex`.
   * This property may be undefined if the transaction hash is not applicable.
   */
  txHash?: ccc.Hex;
}
