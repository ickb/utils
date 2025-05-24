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
   * Finds Capacity cells using the provided client, locks, and options.
   *
   * @param client - The client used to interact with the blockchain.
   * @param locks - An array of lock scripts specifying the criteria for fetching cells.
   * @param options - Optional parameters for the search.
   *                  - onChain: If true, cells are searched on chain; otherwise, cached cells are returned first.
   * @yields CapacityCell objects that satisfy the criteria.
   *
   * @remarks
   * For each unique lock script provided:
   *  - The method uses the client's cell finding capability (either on chain or cached) with a filter that includes:
   *      - A script length criteria (specified as [0n, 1n]).
   *      - The output data length range (if provided).
   *  - Each found cell is validated:
   *      - If the cell has a defined type in its output, it is immediately disqualified.
   *      - If the cell's output data length meets the configured criteria and the cell’s lock script equals the provided lock,
   *        it is yielded as a valid CapacityCell.
   *
   * Note: The number "400" is used as a limit to align with a particular pull request on the Nervos CKB repository
   * (https://github.com/nervosnetwork/ckb/pull/4576).
   */
  async *findCapacities(
    client: ccc.Client,
    locks: ccc.Script[],
    options?: {
      /**
       * Whether to search for cells directly on chain or return cached ones first.
       */
      onChain?: boolean;
    },
  ): AsyncGenerator<CapacityCell> {
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
        400, // See: https://github.com/nervosnetwork/ckb/pull/4576
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
          udtValue: ccc.Zero,
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
