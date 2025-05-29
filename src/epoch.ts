import { ccc } from "@ckb-ccc/core";
import { gcd } from "./utils.js";

/**
 * Compares two epochs.
 *
 * The epochs are normalized first, then compared based on their whole part
 * and fractional (index/length) part.
 *
 * @param a - The first epoch to compare.
 * @param b - The second epoch to compare.
 * @returns 1 if epoch a is greater than b, -1 if a is less than b, or 0 if they are equal.
 */
export function epochCompare(a: ccc.Epoch, b: ccc.Epoch): 1 | 0 | -1 {
  const [aNumber, aIndex, aLength] = epochNormalize(a);
  const [bNumber, bIndex, bLength] = epochNormalize(b);

  if (aNumber < bNumber) {
    return -1;
  }
  if (aNumber > bNumber) {
    return 1;
  }

  // Compare fractions by cross-multiplying indices with denominators.
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
 * Adds two epochs.
 *
 * The function first normalizes the input epochs and then aligns them to a common denominator if needed,
 * before summing their whole number and fractional parts.
 *
 * @param epoch - The initial epoch.
 * @param delta - The epoch delta to add.
 * @returns The resulting epoch after addition in normalized form.
 */
export function epochAdd(epoch: ccc.Epoch, delta: ccc.Epoch): ccc.Epoch {
  // Normalize the input epochs to ensure they are in proper form.
  const [eNumber, eIndex, eLength] = epochNormalize(epoch);
  const [dNumber, dIndex, dLength] = epochNormalize(delta);

  // Sum the whole number parts.
  const number = eNumber + dNumber;
  let index: ccc.Num;
  let length: ccc.Num;

  // If the epochs have different denominators (lengths), align them to a common denominator.
  if (eLength !== dLength) {
    index = dIndex * eLength + eIndex * dLength;
    length = eLength * dLength;
  } else {
    // If denominators are equal, simply add the indices.
    index = eIndex + dIndex;
    length = eLength;
  }

  // Normalize the resulting epoch tuple.
  return epochNormalize([number, index, length]);
}

/**
 * Subtracts the delta epoch from the given epoch.
 *
 * This function reuses epochAdd by negating the number and index parts of the delta.
 *
 * @param epoch - The epoch from which to subtract.
 * @param delta - The epoch delta to subtract.
 * @returns The resulting epoch after subtraction in normalized form.
 */
export function epochSub(epoch: ccc.Epoch, delta: ccc.Epoch): ccc.Epoch {
  // Destructure delta into its constituents.
  const [number, index, length] = delta;
  return epochAdd(epoch, [-number, -index, length]);
}

/**
 * Normalizes an epoch represented as a tuple [number, index, length].
 *
 * The function ensures that:
 * - The denominator is positive. (Throws an error if it is not.)
 * - Negative index values are corrected by borrowing from the whole number.
 * - The fraction (index/length) is reduced to its simplest form using the greatest common divisor.
 * - Whole number overflow from the fraction is accounted for.
 *
 * @param e - The epoch tuple to normalize.
 * @returns The normalized epoch tuple.
 * @throws {Error} If the epoch length is not positive.
 */
export function epochNormalize(e: ccc.Epoch): ccc.Epoch {
  let [number, index, length] = e;

  // Ensure the epoch has a positive denominator.
  if (length > 0n) {
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

  return [number, index, length];
}

/**
 * A constant representing the epoch duration in milliseconds.
 *
 * Calculated as 4 hours in milliseconds:
 * 4 hours * 60 minutes per hour * 60 seconds per minute * 1000 milliseconds per second.
 */
const epochInMilliseconds = 14400000n;

/**
 * Converts an epoch to a Unix timestamp relative to a reference block header.
 *
 * This function computes the difference between the provided epoch and the reference epoch,
 * multiplies the resulting difference (both whole number and fractional parts) by the epoch duration,
 * and then adds the result to the reference timestamp.
 *
 * @param epoch - The epoch to convert.
 * @param reference - The reference block header containing the reference epoch and its timestamp.
 * @returns The Unix timestamp (as bigint) corresponding to the given epoch.
 */
export function epochToTimestamp(
  epoch: ccc.Epoch,
  reference: ccc.ClientBlockHeader,
): bigint {
  // Calculate the difference between the provided epoch and the reference epoch
  // by subtracting the reference epoch from the provided epoch.
  const [number, index, length] = epochSub(epoch, reference.epoch);

  return (
    reference.timestamp +
    epochInMilliseconds * number +
    (epochInMilliseconds * index) / length
  );
}
