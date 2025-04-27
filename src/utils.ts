import { ccc } from "@ckb-ccc/core";

/**
 * Represents a key for retrieving a block header.
 *
 * The `HeaderKey` can be one of three shapes:
 *
 * 1. For hash type:
 *    - `type`: Indicates that the header key is a block hash type, which is "hash".
 *    - `value`: The value associated with the header key, represented as `ccc.HexLike`.
 *
 * 2. For number type:
 *    - `type`: Indicates that the header key is a block number type, which is "number".
 *    - `value`: The value associated with the header key, represented as `ccc.Num`.
 *
 * 3. For transaction hash type:
 *    - `type`: Indicates that the header key is a transaction hash type, which is "txHash".
 *    - `value`: The value associated with the header key, represented as `ccc.HexLike`.
 */
export type HeaderKey =
  | {
      type: "hash";
      value: ccc.HexLike;
    }
  | {
      type: "number";
      value: ccc.Num;
    }
  | {
      type: "txHash";
      value: ccc.HexLike;
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
 * Partitions an array of items into two groups based on a reference epoch.
 *
 * @param tt - The array of items to partition.
 * @param get - A function that retrieves the epoch from an item.
 * @param reference - The reference epoch to compare against.
 * @returns An object containing two arrays: `before` and `after`.
 */
export function epochPartition<T>(
  tt: readonly T[],
  get: (t: T) => ccc.Epoch,
  reference: ccc.Epoch,
): {
  after: T[];
  before: T[];
} {
  const before: T[] = [];
  const after: T[] = [];
  for (const t of tt) {
    if (epochCompare(get(t), reference) <= 0) {
      before.push(t);
    } else {
      after.push(t);
    }
  }
  return { after, before };
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
 * @credits go standard library authors, this implementation is just a translation or that code:
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
 * Returns the maximum value from a list of numbers.
 *
 * @param numbers - A variable number of values to compare.
 * @returns The maximum value among the provided numbers.
 *
 * @example
 * // Example usage:
 * const maximum = max(1, 5, 3, 9, 2); // Returns 9
 */
export function max<T>(...numbers: T[]): T {
  return numbers.reduce((a, b) => (a > b ? a : b));
}

/**
 * Returns the minimum value from a list of numbers.
 *
 * @param numbers - A variable number of values to compare.
 * @returns The minimum value among the provided numbers.
 *
 * @example
 * // Example usage:
 * const minimum = min(1, 5, 3, 9, 2); // Returns 1
 */
export function min<T>(...numbers: T[]): T {
  return numbers.reduce((a, b) => (a < b ? a : b));
}

/**
 * Represents an asynchronous iterable type that can be either a synchronous iterable
 * or an asynchronous generator.
 *
 * @template T - The type of elements in the iterable.
 */
export type AsyncIterable<T> = Iterable<T> | AsyncGenerator<T>;

/**
 * Converts an asynchronous iterable into an array.
 *
 * This function takes an `AsyncIterable` as input and returns a promise that resolves
 * to an array containing all the elements yielded by the iterable.
 *
 * @template T - The type of elements in the input iterable.
 * @param {AsyncIterable<T>} inputs - The asynchronous iterable to convert into an array.
 * @returns {Promise<T[]>} A promise that resolves to an array of elements.
 */
export async function arrayFrom<T>(inputs: AsyncIterable<T>): Promise<T[]> {
  const res = [];
  for await (const i of inputs) {
    res.push(i);
  }
  return res;
}
