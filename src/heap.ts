/**
 * A class representing a minimum heap data structure.
 * @template T - The type of elements in the heap.
 *
 * @credits go standard library authors, this implementation is just a translation:
 * https://go.dev/src/container/heap/heap.go
 */
export class MinHeap<T> {
  /**
   * Creates an instance of MinHeap.
   * @param {(heap: T[], i: number, j: number) => boolean} lessFunc - A function that evaluates if element at index i is less than element at index j.
   * @param {T[]} heap - The initial array of elements in the heap.
   */
  constructor(
    public readonly lessFunc: (heap: T[], i: number, j: number) => boolean,
    public readonly heap: T[],
  ) {}

  /**
   * Initializes the heap from an array of elements.
   * @param {T[]} unordered - The array of unordered elements to create the heap from.
   * @param {(heap: T[], i: number, j: number) => boolean} lessFunc - A function that evaluates if element at index i is less than element at index j.
   * @returns {MinHeap<T>} A new instance of MinHeap.
   */
  static from<T>(
    lessFunc: (heap: T[], i: number, j: number) => boolean,
    unordered: T[] = [],
  ): MinHeap<T> {
    const heap = new MinHeap<T>(lessFunc, [...unordered]);
    const n = heap.len();
    for (let i = (n >> 1) - 1; i >= 0; i--) {
      heap.down(i, n);
    }
    return heap;
  }

  /**
   * Evaluates if the element at index i is less than the element at index j using the external lessFunc.
   * @param {number} i - The index of the first element.
   * @param {number} j - The index of the second element.
   * @returns {boolean} True if the element at index i is less than the element at index j; otherwise, false.
   */
  private less(i: number, j: number): boolean {
    return this.lessFunc(this.heap, i, j);
  }

  /**
   * Returns the number of elements in the heap.
   * @returns {number} The number of elements in the heap.
   */
  len(): number {
    return this.heap.length;
  }

  /**
   * Returns true iff the number of elements in the heap is zero.
   * @returns {number} the emptiness of the array.
   */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Adds an element x to the heap.
   * @param {T} x - The element to be added to the heap.
   */
  push(x: T): void {
    this.heap.push(x);
    this.up(this.len() - 1);
  }

  /**
   * Removes and returns the minimum element from the heap.
   * @returns {T | undefined} The minimum element from the heap, or undefined if the heap is empty.
   */
  pop(): T | undefined {
    if (this.len() === 0) {
      return;
    }

    const n = this.len() - 1;
    this.swap(0, n);
    this.down(0, n);
    return this.heap.pop();
  }

  /**
   * Removes and returns the element at index i from the heap.
   * @param {number} i - The index of the element to be removed.
   * @returns {T | undefined} The removed element, or undefined if the index is out of bounds.
   */
  remove(i: number): T | undefined {
    if (this.len() <= i) {
      return;
    }

    const n = this.len() - 1;
    if (n != i) {
      this.swap(i, n);
      if (!this.down(i, n)) {
        this.up(i);
      }
    }
    return this.pop();
  }

  /**
   * Re-establishes the heap ordering after the element at index i has changed its value.
   * @param {number} i - The index of the element to fix.
   */
  fix(i: number): void {
    if (this.len() <= i) {
      return;
    }

    if (!this.down(i, this.len())) {
      this.up(i);
    }
  }

  /**
   * Moves the element at index j up the heap to restore the heap property.
   * @param {number} j - The index of the element to move up.
   */
  private up(j: number): void {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const i = (j - 1) >> 1; // parent
      if (i == j || !this.less(j, i)) {
        break;
      }
      this.swap(i, j);
      j = i;
    }
  }

  /**
   * Moves the element at index i down the heap to restore the heap property.
   * @param {number} i0 - The index of the element to move down.
   * @param {number} n - The number of elements in the heap.
   * @returns {boolean} True if the element was moved down; otherwise, false.
   */
  private down(i0: number, n: number): boolean {
    let i = i0;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const j1 = (i << 1) + 1; // left child index
      if (j1 >= n || j1 < 0) {
        // j1 < 0 after int overflow
        break;
      }
      let j = j1; // left child
      const j2 = j1 + 1; // right child index
      if (j2 < n && this.less(j2, j1)) {
        j = j2; // choose the smaller child
      }
      if (!this.less(j, i)) {
        break;
      }
      this.swap(i, j);
      i = j;
    }
    return i > i0; // returns true if the position of the element has changed
  }

  /**
   * Swaps the elements at indices i and j in the heap.
   * @param {number} i - The index of the first element.
   * @param {number} j - The index of the second element.
   */
  private swap(i: number, j: number): void {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    [this.heap[i], this.heap[j]] = [this.heap[j]!, this.heap[i]!];
  }
}
