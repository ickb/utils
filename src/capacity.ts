import { ccc } from "@ckb-ccc/core";
import type { SmartTransaction } from "./transaction.js";
import type { ValueComponents } from "./utils.js";

/**
 * Symbol to represent the isCapacity property of Capacity Cells.
 */
const isCapacitySymbol = Symbol("isCapacity");

/**
 * The CapacityManager class is used for managing Capacity cells.
 *
 * @remarks
 * This class provides methods to check if a cell qualifies as a Capacity Cell,
 * add Capacity cells to a transaction, and find Capacity cells based on the provided scripts and options.
 * It supports configuring the criteria for a cell to qualify based on the cell's output data length and
 * an additional predicate callback function.
 */
export class CapacityManager {
  /**
   * Creates an instance of a CapacityManager.
   *
   * @param outputDataLenRange - A tuple specifying the inclusive lower bound and exclusive upper bound of the output data length.
   *                             When defined, only cells with outputData length within this range are considered.
   *                             For example, [0n, 1n] indicates no outputData.
   * @param isCapacityFunc - A function that defines additional checks on the given cell to determine if it qualifies as a Capacity Cell.
   *                         This function is called internally when the outputData length criteria are met.
   */
  constructor(
    public readonly outputDataLenRange: [ccc.Num, ccc.Num] | undefined,
    public readonly isCapacityFunc: (cell: ccc.Cell) => boolean,
  ) {}

  /**
   * Creates a CapacityManager instance that only accepts cells with no output data.
   *
   * @returns An instance of CapacityManager configured with an output data length range of [0n, 1n]
   *          and an isCapacity function that always returns true.
   */
  static noOutputData(): CapacityManager {
    return new CapacityManager([0n, 1n], () => true);
  }

  /**
   * Creates a CapacityManager instance that accepts cells regardless of their output data.
   *
   * @returns An instance of CapacityManager with no output data length filtering (undefined)
   *          and an isCapacity function that always returns true.
   */
  static anyOutputData(): CapacityManager {
    return new CapacityManager(undefined, () => true);
  }

  /**
   * Checks if the provided cell qualifies as a Capacity Cell.
   *
   * @param cell - The cell to check.
   * @returns True if the cell is considered a Capacity Cell; otherwise, false.
   *
   * @remarks
   * A cell is considered a Capacity Cell if:
   * - It does not have a type defined in its cell output.
   * - If an outputDataLenRange is provided, the effective length of the cell's outputData (calculated as (length - 2) / 2)
   *   falls within the specified [start, end) range.
   * - When the outputData length criteria is satisfied (or if no criteria is provided), the cell must pass the additional
   *   check specified by the isCapacityFunc.
   */
  isCapacity(cell: ccc.Cell): boolean {
    if (cell.cellOutput.type !== undefined) {
      return false;
    }

    if (!this.outputDataLenRange) {
      return this.isCapacityFunc(cell);
    }

    const [start, end] = this.outputDataLenRange;
    const dataLen = (cell.outputData.length - 2) / 2;
    if (start <= dataLen && dataLen < end) {
      return this.isCapacityFunc(cell);
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
   * @param locks - An array of scripts that act as locks for the cells to be found.
   * @param options - Optional parameters for the search.
   *                  - onChain: If true, cells are searched on chain; otherwise, cached cells are returned first.
   *
   * @yields CapacityCell objects that satisfy the criteria.
   *
   * @remarks
   * For each provided lock script, the method uses the client's cell finding capability (either directly on chain
   * or via a cached search) with a filter that includes the configuration for script length (specified as [0n, 1n])
   * and the outputData length range (if provided). Each found cell is then checked:
   * - If the cell has a non-undefined type, it is immediately disqualified.
   * - If the cell's output data length is validated (when an outputDataLenRange is present) and the additional
   *   isCapacityFunc check passes, and the cell's lock script equals the provided lock,
   *   the cell is yielded as a valid CapacityCell.
   *
   * Note: The number "400" is specified to align with a particular pull request on the Nervos CKB repository
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
    for (const lock of locks) {
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
        400, // https://github.com/nervosnetwork/ckb/pull/4576
      ] as const;

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
 * A CapacityCell consists of the underlying cell and associated value components.
 * It also includes a symbol property indicating that this cell is a Capacity Cell.
 */
export interface CapacityCell extends ValueComponents {
  /**
   * The underlying cell associated with this Capacity Cell.
   */
  cell: ccc.Cell;

  /**
   * A symbol property indicating that this cell is a Capacity Cell.
   * This property is always set to true.
   */
  [isCapacitySymbol]: true;
}
