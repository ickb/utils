import { ccc } from "@ckb-ccc/core";
import type { SmartTransaction } from "./transaction.js";
import { unique, type ValueComponents } from "./utils.js";

/**
 * Symbol to represent the isCapacity property of Capacity Cells.
 */
const isCapacitySymbol = Symbol("isCapacity");

/**
 * The CapacityManager class is used for managing Capacity cells.
 *
 * @remarks
 * This class provides methods to:
 *   - Check if a cell qualifies as a Capacity Cell.
 *   - Add Capacity cells to a transaction.
 *   - Find Capacity cells based on the provided scripts and options.
 *
 * The criteria for a cell to qualify may be configured based on the cell's output data length
 * and an additional optional predicate function.
 */
export class CapacityManager {
  /**
   * Creates an instance of CapacityManager.
   *
   * @param outputDataLenRange - A tuple specifying the inclusive lower bound and exclusive upper bound of the output data length.
   *                             When defined, only cells whose output data length falls within this range are considered.
   *                             For example, [0n, 1n] indicates cells with no output data.
   */
  constructor(
    public readonly outputDataLenRange: [ccc.Num, ccc.Num] | undefined,
  ) {}

  /**
   * Creates a CapacityManager instance that only accepts cells with no output data.
   *
   * @returns An instance of CapacityManager configured with an output data length range of [0n, 1n].
   */
  static withEmptyData(): CapacityManager {
    return new CapacityManager([0n, 1n]);
  }

  /**
   * Creates a CapacityManager instance that accepts cells regardless of their output data.
   *
   * @returns An instance of CapacityManager with no output data length filtering.
   */
  static withAnyData(): CapacityManager {
    return new CapacityManager(undefined);
  }

  /**
   * Checks if the provided cell qualifies as a Capacity Cell.
   *
   * @param cell - The cell to check.
   * @returns True if the cell qualifies as a Capacity Cell; otherwise, false.
   *
   * @remarks
   * A cell is considered a Capacity Cell if:
   *   - It does not have a type defined in its cell output.
   *   - If an outputDataLenRange is provided, the effective length of the cell's output data (calculated as (length - 2) / 2)
   *     falls within the specified [start, end) range.
   */
  isCapacity(cell: ccc.Cell): boolean {
    if (cell.cellOutput.type !== undefined) {
      return false;
    }

    if (!this.outputDataLenRange) {
      return true;
    }

    const [start, end] = this.outputDataLenRange;
    const dataLen = (cell.outputData.length - 2) / 2;
    if (start <= dataLen && dataLen < end) {
      return true;
    }

    return false;
  }

  /**
   * Adds Capacity cells to the specified smart transaction.
   *
   * @param tx - The smart transaction to which Capacity cells will be added.
   * @param capacities - An array of Capacity cells to be added.
   *
   * @remarks
   * The method iterates over each CapacityCell and adds its underlying cell as an input to the transaction.
   */
  static addCapacities(tx: SmartTransaction, capacities: CapacityCell[]): void {
    for (const { cell } of capacities) {
      tx.addInput(cell);
    }
  }

  /**
   * Async generator that finds and yields capacity-only cells matching the given lock scripts.
   *
   * @param client
   *   A CKB client instance providing two methods:
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
   *       Otherwise, uses local cache via `findCells` first. Default: `false`.
   *   - `limit?: number`
   *       Maximum number of cells to fetch per lock script in each batch.
   *       Defaults to the constant `defaultFindCellsLimit` (400).
   *
   * @yields
   *   {@link CapacityCell} objects for each valid capacity-only cell found.
   *
   * @remarks
   * - Deduplicates `locks` via `unique(locks)` to avoid redundant queries.
   * - Applies an RPC filter:
   *     • `scriptLenRange: [0n, 1n]`
   *     • `outputDataLenRange: this.outputDataLenRange`
   * - Skips any cell that:
   *     1. Has a non-null type script
   *     2. Fails the data-length filter
   *     3. Whose lock script does not exactly match the queried `lock`
   * - Each yielded `CapacityCell` contains:
   *     • `cell`: original cell data with status
   *     • `ckbValue`: capacity in shannons
   *     • `udtValue`: always `0n` (no UDT on capacity-only cells)
   *     • a hidden `[isCapacitySymbol]: true` marker
   */
  async *findCapacities(
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
  ): AsyncGenerator<CapacityCell> {
    const limit = options?.limit ?? defaultFindCellsLimit;
    // Loop through each unique lock script.
    for (const lock of unique(locks)) {
      const findCellsArgs = [
        {
          script: lock,
          scriptType: "lock",
          filter: {
            scriptLenRange: [0n, 1n] as [ccc.Num, ccc.Num],
            outputDataLenRange: this.outputDataLenRange,
          },
          scriptSearchMode: "exact",
          withData: true,
        },
        "asc",
        limit,
      ] as const;

      // Depending on options, choose the correct client function to find cells.
      for await (const cell of options?.onChain
        ? client.findCellsOnChain(...findCellsArgs)
        : client.findCells(...findCellsArgs)) {
        if (!this.isCapacity(cell) || !cell.cellOutput.lock.eq(lock)) {
          continue;
        }

        yield {
          cell,
          ckbValue: cell.cellOutput.capacity,
          udtValue: 0n,
          [isCapacitySymbol]: true,
        };
      }
    }
  }
}

/**
 * Interface representing a Capacity Cell.
 *
 * @remarks
 * A CapacityCell consists of:
 *   - The underlying blockchain cell.
 *   - Associated value components.
 *   - A symbol property indicating that this cell is a Capacity Cell.
 */
export interface CapacityCell extends ValueComponents {
  /**
   * The underlying cell associated with this Capacity Cell.
   */
  cell: ccc.Cell;

  /**
   * A symbol property indicating that this cell is a Capacity Cell.
   * The property is always set to true.
   */
  [isCapacitySymbol]: true;
}

/**
 * The default upper limit on the number of cells to return when querying the chain.
 *
 * This limit is aligned with Nervos CKB’s pull request #4576
 * (https://github.com/nervosnetwork/ckb/pull/4576) to avoid excessive paging.
 *
 * @remarks
 * When searching for capacity-only cells, callers may override this limit
 * by passing a custom `limit` in their options. If no override is provided,
 * this constant controls how many cells will be fetched in a single batch.
 */
export const defaultFindCellsLimit = 400;
