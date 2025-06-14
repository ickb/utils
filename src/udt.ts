import { ccc, mol } from "@ckb-ccc/core";
import { unique, type ScriptDeps, type ValueComponents } from "./utils.js";
import type { SmartTransaction } from "./transaction.js";
import { defaultFindCellsLimit } from "./capacity.js";

/**
 * Interface representing a handler for User Defined Tokens (UDTs).
 * Extends the ScriptDeps interface to include `script` and `cellDeps`.
 */
export interface UdtHandler extends ScriptDeps {
  /**
   * Asynchronously retrieves the UDT input balance (token amount and capacity)
   * for a given transaction.
   *
   * @param client - The CKB client to query cell data.
   * @param tx - The smart transaction whose inputs are to be balanced.
   * @returns A promise resolving to a tuple:
   *   - [0]: Total UDT amount in inputs (as `ccc.FixedPoint`).
   *   - [1]: Total capacity in UDT inputs (as `ccc.FixedPoint`).
   */
  getInputsUdtBalance(
    client: ccc.Client,
    tx: SmartTransaction,
  ): Promise<[ccc.FixedPoint, ccc.FixedPoint]>;

  /**
   * Retrieves the UDT output balance (token amount and capacity)
   * for a given transaction.
   *
   * @param tx - The smart transaction whose outputs are to be balanced.
   * @returns A tuple:
   *   - [0]: Total UDT amount in outputs (as `ccc.FixedPoint`).
   *   - [1]: Total capacity in UDT outputs (as `ccc.FixedPoint`).
   */
  getOutputsUdtBalance(tx: SmartTransaction): [ccc.FixedPoint, ccc.FixedPoint];

  /**
   * Completes a transaction by adding UDT inputs and/or UDT change outputs as needed.
   *
   * @param signer - Signer providing client access and account scripts.
   * @param tx - The smart transaction to adjust.
   * @param options.shouldAddInputs - Whether to add inputs if insufficient. Defaults to `true`.
   * @param options.compressState - Whether to collect all UDT cells to compress state rent. Defaults to `false`.
   * @returns A promise resolving to a tuple:
   *   - [0]: Number of UDT inputs added.
   *   - [1]: `true` if a UDT change output was appended; otherwise `false`.
   */
  completeUdt(
    signer: ccc.Signer,
    tx: SmartTransaction,
    options?: {
      shouldAddInputs?: boolean;
      compressState?: boolean;
    },
  ): Promise<[number, boolean]>;

  /** The canonical name of the UDT. */
  name: string;

  /** The ticker or symbol of the UDT. */
  symbol: string;

  /** The number of decimal places of precision for the UDT. */
  decimals: number;
}

/**
 * Error thrown when a transaction has insufficient UDT balance.
 * Extends the CKB core `ErrorTransactionInsufficientCoin` by including token symbol
 * and decimal precision in the error message.
 *
 * UDT Handler implementer should use this error class where appropriate.
 */
export class ErrorTransactionInsufficientCoin extends ccc.ErrorTransactionInsufficientCoin {
  /**
   * @param amount - The additional amount required (in fixed-point).
   * @param type - The UDT type script.
   * @param symbol - Token symbol (e.g., "USDT").
   * @param decimals - Decimal precision of the token.
   */
  constructor(
    amount: ccc.Num,
    type: ccc.Script,
    public readonly symbol: string,
    public readonly decimals: number,
  ) {
    super(amount, type);
    this.message = `Insufficient coin, need ${ccc.fixedPointToString(
      amount,
      decimals,
    )} extra ${symbol} coin`;
  }
}

/**
 * UdtManager implements UdtHandler for managing UDT operations:
 * - Detecting UDT cells
 * - Computing input/output balances
 * - Adding inputs or change outputs to meet desired UDT amounts
 */
export class UdtManager implements UdtHandler {
  /**
   * @param script - The UDT type script.
   * @param cellDeps - Cell dependencies required to use the UDT script.
   * @param name - The token's full name.
   * @param symbol - The token's symbol or ticker.
   * @param decimals - Decimal precision for token amounts.
   */
  constructor(
    public readonly script: ccc.Script,
    public readonly cellDeps: ccc.CellDep[],
    public readonly name: string,
    public readonly symbol: string,
    public readonly decimals: number,
  ) {}

  /**
   * Determines whether a cell contains this UDT.
   *
   * @param cell - The cell to inspect.
   * @returns `true` if the cell's type script equals `this.script` and
   *          its data length indicates a UDT; otherwise `false`.
   */
  isUdt(cell: ccc.Cell): boolean {
    return (
      Boolean(cell.cellOutput.type?.eq(this.script)) &&
      cell.outputData.length >= 34
    );
  }

  /**
   * Asynchronously retrieves the UDT input balance (token amount and capacity)
   * for a given transaction.
   *
   * @param client - The CKB client to query cell data.
   * @param tx - The smart transaction whose inputs are to be balanced.
   * @returns A promise resolving to a tuple:
   *   - [0]: Total UDT amount in inputs (as `ccc.FixedPoint`).
   *   - [1]: Total capacity in UDT inputs (as `ccc.FixedPoint`).
   */
  getInputsUdtBalance(
    client: ccc.Client,
    tx: SmartTransaction,
  ): Promise<[ccc.FixedPoint, ccc.FixedPoint]> {
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
        const [udtValue, capacity] = acc;
        return [
          udtValue + ccc.udtBalanceFrom(outputData),
          capacity + cell.cellOutput.capacity,
        ];
      },
      [0n, 0n],
    );
  }

  /**
   * Retrieves the UDT output balance (token amount and capacity)
   * for a given transaction.
   *
   * @param tx - The smart transaction whose outputs are to be balanced.
   * @returns A tuple:
   *   - [0]: Total UDT amount in outputs (as `ccc.FixedPoint`).
   *   - [1]: Total capacity in UDT outputs (as `ccc.FixedPoint`).
   */
  getOutputsUdtBalance(tx: SmartTransaction): [ccc.FixedPoint, ccc.FixedPoint] {
    return tx.outputs.reduce(
      (acc, output, i) => {
        if (!output.type?.eq(this.script)) {
          return acc;
        }

        // Input is an UDT
        const [udtValue, capacity] = acc;
        return [
          udtValue + ccc.udtBalanceFrom(tx.outputsData[i] ?? "0x"),
          capacity + output.capacity,
        ];
      },
      [0n, 0n],
    );
  }

  /**
   * Completes a transaction by adding UDT inputs and/or UDT change outputs as needed.
   *
   * @param signer - Signer providing client access and account scripts.
   * @param tx - The smart transaction to adjust.
   * @param options.shouldAddInputs - Whether to add inputs if insufficient. Defaults to `true`.
   * @param options.compressState - Whether to collect all UDT cells to compress state rent. Defaults to `false`.
   * @returns A promise resolving to a tuple:
   *   - [0]: Number of UDT inputs added.
   *   - [1]: `true` if a UDT change output was appended; otherwise `false`.
   */
  async completeUdt(
    signer: ccc.Signer,
    tx: SmartTransaction,
    options?: {
      shouldAddInputs?: boolean;
      compressState?: boolean;
    },
  ): Promise<[number, boolean]> {
    const client = signer.client;
    let [inUdt, inCapacity] = await this.getInputsUdtBalance(client, tx);
    const [outUdt, outCapacity] = this.getOutputsUdtBalance(tx);
    let inAdded = 0;
    if (
      (inUdt < outUdt || inCapacity < outCapacity) &&
      (options?.shouldAddInputs ?? true)
    ) {
      const compressState = options?.compressState ?? false;
      const locks = (await signer.getAddressObjs()).map((a) => a.script);
      const udts = [];
      for await (const cell of this.findUdts(client, locks)) {
        udts.push(cell);
        inUdt += cell.udtValue;
        inCapacity += cell.ckbValue;
        if (!compressState && inUdt >= outUdt && inCapacity >= outCapacity) {
          break;
        }
      }
      this.addUdts(tx, udts);
      inAdded = udts.length;
    }

    if (inUdt < outUdt) {
      throw new ErrorTransactionInsufficientCoin(
        outUdt - inUdt,
        this.script,
        this.symbol,
        this.decimals,
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
