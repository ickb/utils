import type { ccc } from "@ckb-ccc/core";
import type { SmartTransaction } from "./transaction.js";

// Symbol to represent the isCapacity property of Capacity Cells
const isCapacitySymbol = Symbol("isCapacity");

/**
 * Class for managing Capacity cells.
 */
export class CapacityManager {
  public readonly isCapacitySymbol = isCapacitySymbol;

  /**
   * Checks if a cell is a Capacity Cell.
   * @param cell - The cell to check.
   * @returns {boolean} True if the cell is a Capacity Cell, false otherwise.
   */
  static isCapacity(cell: ccc.Cell): boolean {
    return cell.cellOutput.type === undefined && cell.outputData === "0x";
  }

  /**
   * Adds Capacity cells to a transaction.
   * @param tx - The transaction to which Capacity cells will be added.
   * @param capacities - An array of Capacity cells to add.
   */
  static addCapacities(tx: SmartTransaction, capacities: CapacityCell[]): void {
    for (const { cell } of capacities) {
      tx.addInput(cell);
    }
  }

  /**
   * Finds Capacity cells based on the provided locks and options.
   * @param client - The client used to interact with the blockchain.
   * @param locks - An array of scripts to lock the cells.
   * @param options - Optional parameters for the search.
   * @returns {AsyncGenerator<CapacityCell>} An async generator that yields Capacity cells.
   */
  static async *findCapacities(
    client: ccc.Client,
    locks: ccc.ScriptLike[],
    options?: {
      onChain?: boolean;
    },
  ): AsyncGenerator<CapacityCell> {
    for (const lock of locks) {
      const findCellsArgs = [
        {
          script: lock,
          scriptType: "lock",
          filter: {
            scriptLenRange: [0, 1] as [ccc.NumLike, ccc.NumLike],
            outputDataLenRange: [0, 1] as [ccc.NumLike, ccc.NumLike],
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
          [isCapacitySymbol]: true,
        };
      }
    }
  }
}

/**
 * Interface representing a Capacity Cell.
 */
export interface CapacityCell {
  /**
   * The underlying cell associated with the Capacity Cell.
   */
  cell: ccc.Cell;

  /**
   * A symbol property indicating that this cell is a Capacity Cell.
   * This property is always set to true.
   */
  [isCapacitySymbol]: true;
}
