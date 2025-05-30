import { ccc } from "@ckb-ccc/core";
import { unique, type ScriptDeps, type ValueComponents } from "./utils.js";
import type { SmartTransaction } from "./transaction.js";

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
  getInputsUdtBalance?: (
    client: ccc.Client,
    tx: SmartTransaction,
  ) => Promise<ccc.FixedPoint>;

  /**
   * Retrieves the balance of UDT outputs for a given transaction.
   * @param {SmartTransaction} tx - The transaction for which to retrieve the UDT output balance.
   * @returns {ccc.FixedPoint} The balance of UDT outputs.
   */
  getOutputsUdtBalance?: (tx: SmartTransaction) => ccc.FixedPoint;
}

/**
 * UdtManager is a class that implements the UdtHandler interface.
 * It is responsible for handling UDT (User Defined Token) operations.
 */
export class UdtManager implements UdtHandler {
  /**
   * Creates an instance of UdtManager.
   * @param script - The script associated with the UDT.
   * @param cellDeps - An array of cell dependencies.
   */
  constructor(
    public readonly script: ccc.Script,
    public readonly cellDeps: ccc.CellDep[],
  ) {}

  /**
   * Creates an instance of UdtManager from script dependencies.
   * @param deps - The script dependencies.
   * @param deps.udt - The script dependencies for UDT.
   * @returns An instance of UdtManager.
   */
  static fromDeps(
    { udt }: { udt: ScriptDeps },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ..._: never[]
  ): UdtManager {
    return new UdtManager(udt.script, udt.cellDeps);
  }

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
   * Finds UDT cells based on the provided locks and options.
   * @param client - The client used to interact with the blockchain.
   * @param locks - An array of scripts to lock the cells.
   * @param options - Optional parameters for the search.
   * @returns {AsyncGenerator<UdtCell>} An async generator that yields UDT cells.
   */
  async *findUdts(
    client: ccc.Client,
    locks: ccc.Script[],
    options?: {
      onChain?: boolean;
    },
  ): AsyncGenerator<UdtCell> {
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
        400, // https://github.com/nervosnetwork/ckb/pull/4576
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
