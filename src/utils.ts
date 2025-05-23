import { ccc } from "@ckb-ccc/core";

/**
 * Represents the components of a value, including CKB and UDT amounts.
 */
export interface ValueComponents {
  /** The CKB amount as a `ccc.FixedPoint`. */
  ckbValue: ccc.FixedPoint;

  /** The UDT amount as a `ccc.FixedPoint`. */
  udtValue: ccc.FixedPoint;
}

/**
 * Represents the exchange ratio between CKB and a UDT.
 * This interface is usually used in conjunction with `ValueComponents` to understand the values of entities.
 *
 * For example, if `v` implements `ValueComponents` and `r` is an `ExchangeRatio`:
 * - The absolute value of `v` is calculated as:
 *   `v.ckbValue * r.ckbScale + v.udtValue * r.udtScale`
 * - The equivalent CKB value of `v` is calculated as:
 *   `v.ckbValue + (v.udtValue * r.udtScale + r.ckbScale - 1n) / r.ckbScale`
 * - The equivalent UDT value of `v` is calculated as:
 *   `v.udtValue + (v.ckbValue * r.ckbScale + r.udtScale - 1n) / r.udtScale`
 */
export interface ExchangeRatio {
  /** The CKB scale as a `ccc.Num`. */
  ckbScale: ccc.Num;

  /** The UDT scale as a `ccc.Num`. */
  udtScale: ccc.Num;
}

/**
 * Interface representing the full configuration needed for interacting with a Script
 */
export interface ScriptDeps {
  /**
   * The script for which additional information is being provided.
   * @type {ccc.Script}
   */
  script: ccc.Script;

  /**
   * An array of cell dependencies associated with the script.
   * @type {ccc.CellDep[]}
   */
  cellDeps: ccc.CellDep[];
}

/**
 * Represents a key for retrieving a block header.
 *
 * The `HeaderKey` can be one of three shapes:
 *
 * 1. For hash type:
 *    - `type`: Indicates that the header key is a block hash type, which is "hash".
 *    - `value`: The value associated with the header key, represented as `ccc.Hex`.
 *
 * 2. For number type:
 *    - `type`: Indicates that the header key is a block number type, which is "number".
 *    - `value`: The value associated with the header key, represented as `ccc.Num`.
 *
 * 3. For transaction hash type:
 *    - `type`: Indicates that the header key is a transaction hash type, which is "txHash".
 *    - `value`: The value associated with the header key, represented as `ccc.Hex`.
 */
export type HeaderKey =
  | {
      type: "hash";
      value: ccc.Hex;
    }
  | {
      type: "number";
      value: ccc.Num;
    }
  | {
      type: "txHash";
      value: ccc.Hex;
    };

/**
 * Retrieves the block header based on the provided header key.
 *
 * @param client - An instance of `ccc.Client` used to interact with the blockchain.
 * @param headerKey - An object of type `HeaderKey` that specifies how to retrieve the header.
 * @returns A promise that resolves to a `ccc.ClientBlockHeader` representing the block header.
 * @throws Error if the header is not found for the given header key.
 */
export async function getHeader(
  client: ccc.Client,
  headerKey: HeaderKey,
): Promise<ccc.ClientBlockHeader> {
  const { type, value } = headerKey;
  let header: ccc.ClientBlockHeader | undefined = undefined;
  if (type === "hash") {
    header = await client.getHeaderByHash(value);
  } else if (type === "number") {
    header = await client.getHeaderByNumber(value);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  } else if (type === "txHash") {
    header = (await client.getTransactionWithHeader(value))?.header;
  }

  if (!header) {
    throw new Error("Header not found");
  }

  return header;
}

/**
 * Compares two epochs and returns an integer indicating their order.
 *
 * @param a - The first epoch to compare.
 * @param b - The second epoch to compare.
 * @returns 1 if a > b, -1 if a < b, and 0 if they are equal.
 */
export function epochCompare(a: ccc.Epoch, b: ccc.Epoch): 1 | 0 | -1 {
  const [aNumber, aIndex, aLength] = a;
  const [bNumber, bIndex, bLength] = b;

  if (aNumber < bNumber) {
    return -1;
  }
  if (aNumber > bNumber) {
    return 1;
  }

  const v0 = aIndex * bLength;
  const v1 = bIndex * aLength;
  if (v0 < v1) {
    return -1;
  }
  if (v0 > v1) {
    return 1;
  }

  return 0;
}

/**
 * Adds to an epoch a duration expressed in another epoch and returns the resulting epoch.
 *
 * @param epoch - The base epoch to which the delta will be added.
 * @param delta - The duration to add to the base epoch.
 * @returns The resulting epoch after addition.
 * @throws Error if either epoch has a length of zero.
 */
export function epochAdd(epoch: ccc.Epoch, delta: ccc.Epoch): ccc.Epoch {
  const [eNumber, eIndex, eLength] = epoch;
  const [dNumber, dIndex, dLength] = delta;

  if (eLength === 0n || dLength === 0n) {
    throw new Error("Zero EpochSinceValue length");
  }

  let rawIndex = eIndex;
  if (eLength !== dLength) {
    rawIndex += (dIndex * eLength + dLength - 1n) / dLength;
  } else {
    rawIndex += dIndex;
  }

  const length = eLength;
  const index = rawIndex % length;
  const number = eNumber + dNumber + (rawIndex - index) / length;

  return [number, index, length];
}

/**
 * Shuffles in-place an array using the Durstenfeld shuffle algorithm.
 * @link https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle
 *
 * @param array - The array to shuffle.
 * @returns The same array containing the shuffled elements.
 */
export function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    [array[i], array[j]] = [array[j]!, array[i]!];
  }
  return array;
}

/**
 * Performs a binary search to find the smallest index `i` in the range [0, n)
 * such that the function `f(i)` returns true. It is assumed that for the range
 * [0, n), if `f(i)` is true, then `f(i+1)` is also true. This means that there
 * is a prefix of the input range where `f` is false, followed by a suffix where
 * `f` is true. If no such index exists, the function returns `n`.
 *
 * The function `f` is only called for indices in the range [0, n).
 *
 * @param n - The upper bound of the search range (exclusive).
 * @param f - A function that takes an index `i` and returns a boolean value.
 * @returns The smallest index `i` such that `f(i)` is true, or `n` if no such index exists.
 *
 * @credits go standard library authors, this implementation is just a translation:
 * https://go.dev/src/sort/search.go
 *
 * @example
 * // Example usage:
 * const isGreaterThanFive = (i: number) => i > 5;
 * const index = binarySearch(10, isGreaterThanFive); // Returns 6
 *
 */
export function binarySearch(n: number, f: (i: number) => boolean): number {
  // Define f(-1) == false and f(n) == true.
  // Invariant: f(i-1) == false, f(j) == true.
  let [i, j] = [0, n];
  while (i < j) {
    const h = Math.trunc((i + j) / 2);
    // i ≤ h < j
    if (!f(h)) {
      i = h + 1; // preserves f(i-1) == false
    } else {
      j = h; // preserves f(j) == true
    }
  }
  // i == j, f(i-1) == false, and f(j) (= f(i)) == true  =>  answer is i.
  return i;
}

/**
 * Performs asynchronously a binary search to find the smallest index `i` in the range [0, n)
 * such that the function `f(i)` returns true. It is assumed that for the range
 * [0, n), if `f(i)` is true, then `f(i+1)` is also true. This means that there
 * is a prefix of the input range where `f` is false, followed by a suffix where
 * `f` is true. If no such index exists, the function returns `n`.
 *
 * The function `f` is only called for indices in the range [0, n).
 *
 * @param n - The upper bound of the search range (exclusive).
 * @param f - An async function that takes an index `i` and returns a boolean value.
 * @returns The smallest index `i` such that `f(i)` is true, or `n` if no such index exists.
 *
 * @credits go standard library authors, this implementation is just a translation or that code:
 * https://go.dev/src/sort/search.go *
 */
export async function asyncBinarySearch(
  n: number,
  f: (i: number) => Promise<boolean>,
): Promise<number> {
  // Define f(-1) == false and f(n) == true.
  // Invariant: f(i-1) == false, f(j) == true.
  let [i, j] = [0, n];
  while (i < j) {
    const h = Math.trunc((i + j) / 2);
    // i ≤ h < j
    if (!(await f(h))) {
      i = h + 1; // preserves f(i-1) == false
    } else {
      j = h; // preserves f(j) == true
    }
  }
  // i == j, f(i-1) == false, and f(j) (= f(i)) == true  =>  answer is i.
  return i;
}

/**
 * Converts an asynchronous generator into an array.
 *
 * This function takes an `AsyncGenerator<T>` as input and returns a promise that resolves
 * to an array containing all the elements yielded by the generator.
 *
 * @template T - The type of elements in the input generator.
 * @param {AsyncGenerator<T>} inputs - The asynchronous generator to convert into an array.
 * @returns {Promise<T[]>} A promise that resolves to an array of elements.
 */
export async function collect<T>(inputs: AsyncGenerator<T>): Promise<T[]> {
  const res = [];
  for await (const i of inputs) {
    res.push(i);
  }
  return res;
}

/**
 * A buffered generator that tries to maintain a fixed-size buffer of values.
 */
export class BufferedGenerator<T> {
  public buffer: T[] = [];

  /**
   * Creates an instance of Buffered.
   * @param generator - The generator to buffer values from.
   * @param maxSize - The maximum size of the buffer.
   */
  constructor(
    public generator: Generator<T, void, void>,
    public maxSize: number,
  ) {
    // Try to populate the buffer
    for (const value of generator) {
      this.buffer.push(value);
      if (this.buffer.length >= this.maxSize) {
        break;
      }
    }
  }

  /**
   * Advances the buffer by the specified number of steps.
   * @param n - The number of steps to advance the buffer.
   */
  public next(n: number): void {
    for (let i = 0; i < n; i++) {
      this.buffer.shift();
      const { value, done } = this.generator.next();
      if (!done) {
        this.buffer.push(value);
      }
    }
  }
}

/**
 * Returns the maximum value from a list of values.
 *
 * This function compares a starting value against additional values and returns the largest one.
 *
 * @param res - The initial value used as a starting point for comparisons.
 * @param rest - A variable number of additional values to compare.
 * @returns The maximum value among the provided values.
 *
 * @example
 * // Example usage:
 * const maximum = max(1, 5, 3, 9, 2); // Returns 9
 */
export function max<T>(res: T, ...rest: T[]): T {
  for (const v of rest) {
    if (v > res) {
      res = v;
    }
  }
  return res;
}

/**
 * Returns the minimum value from a list of values.
 *
 * This function compares a starting value against additional values and returns the smallest one.
 *
 * @param res - The initial value used as a starting point for comparisons.
 * @param rest - A variable number of additional values to compare.
 * @returns The minimum value among the provided values.
 *
 * @example
 * // Example usage:
 * const minimum = min(1, 5, 3, 9, 2); // Returns 1
 */
export function min<T>(res: T, ...rest: T[]): T {
  for (const v of rest) {
    if (v < res) {
      res = v;
    }
  }
  return res;
}

/**
 * Returns the sum of a list of values.
 *
 * This function adds together an initial value with a variable number of additional values.
 * The operation is performed in a pairwise reduction manner to improve performance by reducing
 * the number of allocations, while achieving on numbers better numerical stability than naive summation.
 * It supports numbers (the main target) and bigints.
 *
 * @param res - The initial value used as the starting point for the sum.
 * @param rest - A variable number of additional values to be added.
 * @returns The sum of all provided values.
 *
 * @example
 * // Example usage with numbers:
 * const result = sum(1, 5, 3, 9, 2); // Returns 20
 *
 * @example
 * // Example usage with bigints:
 * const resultBigInt = sum(1n, 5n, 3n, 9n, 2n); // Returns 20n
 */
export function sum(res: number, ...rest: number[]): number;
export function sum(res: bigint, ...rest: bigint[]): bigint;
export function sum<T>(res: T, ...rest: T[]): T {
  const elements = [res, ...rest] as number[];
  let n = elements.length;

  // Perform pairwise reduction until a single value remains.
  while (n > 1) {
    const half = n >> 1;
    const isOdd = n % 2;
    // If there is an odd element, elements[half] is already in the correct place.
    for (let i = 0; i < half; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      elements[i]! += elements[n - i - 1]!;
    }
    n = half + isOdd;
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return elements[0]! as T;
}

/**
 * Calculates the greatest common divisor (GCD) of multiple `bigint` numbers.
 *
 * This function extends the Euclidean algorithm to an array of values. It calculates the GCD
 * by iteratively computing the GCD of the current result and each subsequent number.
 *
 * @param res - The initial `bigint` value to start the GCD calculation.
 * @param rest - An array of additional `bigint` values whose GCD will be computed with `res`.
 * @returns The greatest common divisor of all the provided numbers as a `bigint`.
 */
export function gcd(res: bigint, ...rest: bigint[]): bigint {
  for (let v of rest) {
    while (v !== 0n) {
      [res, v] = [v, res % v];
    }
  }
  return res;
}
