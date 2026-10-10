/** Enumerable membership without owning the objects' lifetime. */
export class WeakRegistry<T extends object> {
  private readonly entries = new Set<WeakRef<T>>();
  private readonly references = new WeakMap<T, WeakRef<T>>();

  add(value: T): void {
    let reference = this.references.get(value);
    if (!reference) {
      reference = new WeakRef(value);
      this.references.set(value, reference);
    }
    this.entries.add(reference);
  }

  clear(): void {
    this.entries.clear();
  }

  delete(value: T): void {
    const reference = this.references.get(value);
    if (reference) {
      this.entries.delete(reference);
      this.references.delete(value);
    }
  }

  *values(): IterableIterator<T> {
    for (const reference of this.entries) {
      const value = reference.deref();
      if (value) {
        yield value;
      } else {
        this.entries.delete(reference);
      }
    }
  }
}
