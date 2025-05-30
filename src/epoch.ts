import { ccc } from "@ckb-ccc/core";
import { gcd } from "./utils.js";

/**
 * Represents an Epoch in two possible forms:
 * - An object with { number, index, length } values.
 * - A native ccc.Epoch.
 */
export type EpochLike =
  | {
      number: ccc.Num;
      index: ccc.Num;
      length: ccc.Num;
    }
  | ccc.Epoch;

/**
 * Class representing an Epoch that tracks a value composed of a whole
 * number and a normalized fractional part.
 *
 * The Epoch is stored as three components:
 * - number: the whole number part,
 * - index: the numerator of the fractional part, and
 * - length: the denominator of the fractional part.
 *
 * The class provides static factory methods to construct an Epoch from
 * different representations (including a hexadecimal representation) and
 * implements methods to add, subtract, normalize, compare, and convert to a
 * hexadecimal representation, in addition to converting the epoch to a timestamp.
 */
export class Epoch {
  /**
   * Create an Epoch instance.
   * @param number - The whole number part.
   * @param index - The fractional numerator.
   * @param length - The fractional denominator.
   */
  private constructor(
    public readonly number: ccc.Num,
    public readonly index: ccc.Num,
    public readonly length: ccc.Num,
  ) {}

  /**
   * Create an Epoch instance from an EpochLike representation.
   *
   * The method first de-structures the passed value into the standard tuple,
   * then performs normalization:
   * - Ensures the epoch length is positive.
   * - Corrects negative index by borrowing from the whole number.
   * - Reduces the fractional part using the greatest common divisor.
   * - Carries over any overflow from the fraction.
   *
   * @param epochLike - The EpochLike value to convert.
   * @returns A normalized Epoch instance.
   * @throws Error if the epoch length is non-positive.
   */
  static from(epochLike: EpochLike): Epoch {
    if (epochLike instanceof Epoch) {
      return epochLike;
    }

    let { number, index, length } = deStruct(epochLike);

    // Ensure the epoch has a positive denominator.
    if (length <= 0n) {
      throw new Error("Non positive Epoch length");
    }

    // Normalize negative index values by borrowing from the whole number.
    if (index < 0n) {
      // Calculate how many whole units to borrow.
      const n = (-index + length - 1n) / length;
      number -= n;
      index += length * n;
    }

    // Reduce the fraction (index / length) to its simplest form using the greatest common divisor.
    const g = gcd(index, length);
    index /= g;
    length /= g;

    // Add any whole number overflow from the fraction.
    number += index / length;

    // Calculate the leftover index after accounting for the whole number part from the fraction.
    index %= length;

    return new Epoch(number, index, length);
  }

  /**
   * Create an Epoch from a hexadecimal string representation.
   *
   * @param hex - The hexadecimal representation of the epoch.
   * @returns A normalized Epoch instance.
   */
  static fromHex(hex: ccc.Hex): Epoch {
    return Epoch.from(ccc.epochFromHex(hex));
  }

  /**
   * Convert this Epoch instance to its hexadecimal string representation.
   *
   * @returns The hexadecimal representation of this epoch.
   */
  toHex(): ccc.Hex {
    const { number, index, length } = this;
    return ccc.epochToHex([number, index, length]);
  }

  /**
   * Compare this epoch with another Epoch (or EpochLike).
   *
   * The comparison first checks the whole number parts. If they are equal,
   * it compares the fractions by cross-multiplying the indices with the denominators.
   *
   * @param other - The epoch or epoch-like  to compare with.
   * @returns 1 if this epoch is greater, -1 if less, and 0 if equal.
   */
  compare(other: EpochLike): 1 | 0 | -1 {
    other = Epoch.from(other);

    if (this.number < other.number) {
      return -1;
    }
    if (this.number > other.number) {
      return 1;
    }

    // Compare fractions by cross-multiplying indices with denominators.
    const v0 = this.index * other.length;
    const v1 = other.index * this.length;
    if (v0 < v1) {
      return -1;
    }
    if (v0 > v1) {
      return 1;
    }

    return 0;
  }

  /**
   * Add another Epoch (or EpochLike) to this epoch.
   *
   * When adding, the whole number parts are directly summed. If the epochs have different
   * denominators (lengths), the fractions are first aligned to a common denominator, then
   * normalized.
   *
   * @param other - The epoch or epoch-like value to add.
   * @returns A new normalized Epoch instance representing the sum.
   */
  add(other: EpochLike): Epoch {
    other = Epoch.from(other);

    // Sum the whole number parts.
    const number = this.number + other.number;
    let index: ccc.Num;
    let length: ccc.Num;

    // If the epochs have different denominators (lengths), align them to a common denominator.
    if (this.length !== other.length) {
      index = other.index * this.length + this.index * other.length;
      length = this.length * other.length;
    } else {
      // If denominators are equal, simply add the indices.
      index = this.index + other.index;
      length = this.length;
    }

    // Normalize the resulting epoch tuple.
    return Epoch.from([number, index, length]);
  }

  /**
   * Subtract an Epoch (or EpochLike) from this epoch.
   *
   * This method destructures the provided epoch-like value and then negates the respective
   * components before adding them to this epoch.
   *
   * @param other - The epoch or epoch-like value to subtract.
   * @returns A new normalized Epoch instance representing the difference.
   */
  sub(other: EpochLike): Epoch {
    // Destructure delta into its constituents.
    const { number, index, length } = deStruct(other);
    return this.add([-number, -index, length]);
  }

  /**
   * Convert this epoch to an absolute Unix timestamp.
   *
   * For a given reference block header, the conversion computes the difference between
   * this epoch and the reference epoch, then applies a per-epoch millisecond duration to
   * calculate the absolute Unix timestamp.
   *
   * @param reference - The reference client block header providing an epoch and timestamp.
   * @returns The calculated Unix timestamp as a bigint.
   */
  toUnix(reference: ccc.ClientBlockHeader): bigint {
    // Calculate the difference between the provided epoch and the reference epoch.
    const { number, index, length } = this.sub(reference.epoch);

    return (
      reference.timestamp +
      epochInMilliseconds * number +
      (epochInMilliseconds * index) / length
    );
  }
}

/**
 * Deconstruct an EpochLike value into its constitutive parts.
 *
 * The function handles both array representations and object representations of an epoch.
 *
 * @param epochLike - The epoch-like structure to deconstruct.
 * @returns An object containing { number, index, length }.
 */
function deStruct(epochLike: EpochLike): {
  number: ccc.Num;
  index: ccc.Num;
  length: ccc.Num;
} {
  if (epochLike instanceof Array) {
    const [number, index, length] = epochLike;
    return {
      number,
      index,
      length,
    };
  }

  return epochLike;
}

/**
 * A constant representing the epoch duration in milliseconds.
 *
 * Calculated as 4 hours in milliseconds:
 * 4 hours * 60 minutes per hour * 60 seconds per minute * 1000 milliseconds per second.
 */
const epochInMilliseconds = 14400000n;
