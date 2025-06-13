import { ccc, mol } from "@ckb-ccc/core";
import {
  collect,
  sum,
  unique,
  type ScriptDeps,
  type ValueComponents,
} from "./utils.js";
import type { SmartTransaction } from "./transaction.js";
import { defaultFindCellsLimit } from "./capacity.js";

/**
 * Interface representing a handler for User Defined Tokens (UDTs).
 * This interface extends the ScriptDeps interface, meaning it also includes
 * the properties defined in ScriptDeps: `script` and `cellDeps`.
 */
export interface UdtHandler extends ScriptDeps {
  /**
   * Asynchronously retrieves the balance of UDT inputs for a given transaction.
   * @param {ccc.Client} client - The client used to interact with the blockchain.
   * @param {SmartTransaction} tx - The transaction for which to retrieve the UDT input balance.
   * @returns {Promise<ccc.FixedPoint>} A promise that resolves to the balance of UDT inputs.
   */
  getInputsUdtBalance: (
    client: ccc.Client,
    tx: SmartTransaction,
  ) => Promise<ccc.FixedPoint>;

  /**
   * Retrieves the balance of UDT outputs for a given transaction.
   * @param {SmartTransaction} tx - The transaction for which to retrieve the UDT output balance.
   * @returns {ccc.FixedPoint} The balance of UDT outputs.
   */
  getOutputsUdtBalance: (tx: SmartTransaction) => ccc.FixedPoint;

  /**
   * Adjusts a SmartTransaction by collecting and adding UDT change if needed.
   * @param {ccc.Signer} signer - Signer carrying client & address info.
   * @param {SmartTransaction} tx - Transaction to complete.
   * @returns A tuple [number of added UDT inputs, whether change output was added].
   */
  completeUdt: (
    signer: ccc.Signer,
    tx: SmartTransaction,
  ) => Promise<[number, boolean]>;

  /** Number of decimals for this UDT (Default: 8). */
  udtDecimals: number;
}

/**
 * UdtManager is a class that implements the UdtHandler interface.
 * It is responsible for handling UDT (User Defined Token) operations.
 */
export class UdtManager implements UdtHandler {
  /**
   * @param script - The UDT type script.
   * @param cellDeps - Cell deps required by the UDT script.
   * @param udtDecimals - Decimal precision of the UDT.
   */
  constructor(
    public readonly script: ccc.Script,
    public readonly cellDeps: ccc.CellDep[],
    public readonly udtDecimals: number,
  ) {}

  /**
   * Checks if a cell is a User Defined Token (UDT).
   * @param cell - The cell to check.
   * @returns {boolean} True if the cell is a UDT, false otherwise.
   */
  isUdt(cell: ccc.Cell): boolean {
    return (
      Boolean(cell.cellOutput.type?.eq(this.script)) &&
      cell.outputData.length >= 34
    );
  }

  /**
   * Retrieves the UDT balance of inputs in a transaction.
   * @param tx - The smart transaction containing the inputs.
   * @param client - The client used to interact with the blockchain.
   * @returns {Promise<ccc.FixedPoint>} A promise that resolves to the total UDT balance of the inputs.
   */
  getInputsUdtBalance(
    client: ccc.Client,
    tx: SmartTransaction,
  ): Promise<ccc.FixedPoint> {
    return ccc.reduceAsync(
      tx.inputs,
      async (acc, input) => {
        // Get all cell info
        await input.completeExtraInfos(client);
        const { previousOutput: outPoint, cellOutput, outputData } = input;

        // Input is not well defined
        if (!cellOutput || !outputData) {
          throw Error("Unable to complete input");
        }

        // Input is not an UDT
        const cell = new ccc.Cell(outPoint, cellOutput, outputData);
        if (!this.isUdt(cell)) {
          return acc;
        }

        // Input is an UDT
        return acc + ccc.udtBalanceFrom(outputData);
      },
      0n,
    );
  }

  /**
   * Retrieves the UDT balance of outputs in a transaction.
   * @param tx - The smart transaction containing the outputs.
   * @returns {ccc.Num} The total UDT balance of the outputs.
   */
  getOutputsUdtBalance(tx: SmartTransaction): ccc.Num {
    return tx.outputs.reduce((acc, output, i) => {
      if (!output.type?.eq(this.script)) {
        return acc;
      }

      return acc + ccc.udtBalanceFrom(tx.outputsData[i] ?? "0x");
    }, 0n);
  }

  /**
   * Adjusts a SmartTransaction by collecting and adding UDT change if needed.
   * If additional input UDTs are required, this method will greedily add all udt cells to compress state rent.
   * @param {ccc.Signer} signer - Signer carrying client & address info.
   * @param {SmartTransaction} tx - Transaction to complete.
   * @returns A tuple [number of added UDT inputs, whether change output was added].
   */
  async completeUdt(
    signer: ccc.Signer,
    tx: SmartTransaction,
  ): Promise<[number, boolean]> {
    const client = signer.client;
    const inUdt = await this.getInputsUdtBalance(client, tx);
    let outUdt = this.getOutputsUdtBalance(tx);
    let inAdded = 0;

    if (inUdt < outUdt) {
      const locks = (await signer.getAddressObjs()).map((a) => a.script);
      const udts = await collect(this.findUdts(client, locks));
      // Greedily add all UDTs to compress state rent
      this.addUdts(tx, udts);
      outUdt += sum(0n, ...udts.map((u) => u.udtValue));
      inAdded = udts.length;
    }

    if (inUdt < outUdt) {
      throw Error(
        `Insufficient coin, need ${ccc.fixedPointToString(outUdt - inUdt, this.udtDecimals)} extra coin`,
      );
    }

    if (inUdt === outUdt) {
      return [inAdded, false];
    }

    tx.addOutput(
      {
        lock: (await signer.getRecommendedAddressObj()).script,
        type: this.script,
      },
      mol.Uint128LE.encode(inUdt - outUdt),
    );

    return [inAdded, true];
  }

  /**
   * Adds UDT cells to a transaction.
   * @param tx - The smart transaction to which UDT cells will be added.
   * @param udts - An array of UDT cells to add.
   */
  addUdts(tx: SmartTransaction, udts: UdtCell[]): void {
    if (udts.length === 0) {
      return;
    }

    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this);

    for (const { cell } of udts) {
      tx.addInput(cell);
    }
  }

  /**
   * Async generator that finds and yields UDT (User‐Defined Token) cells matching the given lock scripts.
   *
   * @param client
   *   A CKB client instance providing:
   *   - `findCells(query, order, limit)` for cached searches
   *   - `findCellsOnChain(query, order, limit)` for on-chain searches
   *
   * @param locks
   *   An array of lock scripts. Only cells whose `cellOutput.lock` matches one of these
   *   scripts exactly will be considered.
   *
   * @param options
   *   Optional parameters to control the search behavior:
   *   - `onChain?: boolean`
   *       If `true`, queries the chain directly via `findCellsOnChain`.
   *       Otherwise, uses local cache via `findCells`. Default: `false`.
   *   - `limit?: number`
   *       Maximum number of cells to fetch per lock script in each batch.
   *       Defaults to `defaultFindCellsLimit` (400).
   *
   * @yields
   *   {@link UdtCell} objects for each valid UDT cell found.
   *
   * @remarks
   * - Deduplicates `locks` via `unique(locks)` to avoid redundant queries.
   * - Applies an RPC filter:
   *     • `script: this.script` (the UDT type script)
   * - Skips any cell that:
   *     1. Does not pass `this.isUdt(cell)`
   *     2. Whose lock script does not exactly match the queried `lock`
   * - Each yielded `UdtCell` contains:
   *     • `cell`: original cell data with status
   *     • `ckbValue`: capacity in shannons
   *     • `udtValue`: token amount parsed via `ccc.udtBalanceFrom(cell.outputData)`
   *     • a hidden `[isUdtSymbol]: true` marker
   */
  async *findUdts(
    client: ccc.Client,
    locks: ccc.Script[],
    options?: {
      /**
       * If true, fetch cells directly from the chain RPC. Otherwise, use cached results.
       * @default false
       */
      onChain?: boolean;
      /**
       * Batch size per lock script. Defaults to {@link defaultFindCellsLimit}.
       */
      limit?: number;
    },
  ): AsyncGenerator<UdtCell> {
    const limit = options?.limit ?? defaultFindCellsLimit;
    for (const lock of unique(locks)) {
      const findCellsArgs = [
        {
          script: lock,
          scriptType: "lock",
          filter: {
            script: this.script,
          },
          scriptSearchMode: "exact",
          withData: true,
        },
        "asc",
        limit,
      ] as const;

      for await (const cell of options?.onChain
        ? client.findCellsOnChain(...findCellsArgs)
        : client.findCells(...findCellsArgs)) {
        if (!this.isUdt(cell) || !cell.cellOutput.lock.eq(lock)) {
          continue;
        }

        yield {
          cell,
          ckbValue: cell.cellOutput.capacity,
          udtValue: ccc.udtBalanceFrom(cell.outputData),
          [isUdtSymbol]: true,
        };
      }
    }
  }
}

/**
 * Interface representing a UdtCell Cell.
 */
export interface UdtCell extends ValueComponents {
  /**
   * The underlying cell associated with the UDT Cell.
   */
  cell: ccc.Cell;

  /**
   * A symbol property indicating that this cell is a UDT Cell.
   * This property is always set to true.
   */
  [isUdtSymbol]: true;
}

// Symbol to represent the isUdt property of UDT Cells
const isUdtSymbol = Symbol("isUdt");
