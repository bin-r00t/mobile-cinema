import { describe, expect, it } from "vitest";

import {
  clearPosition,
  positionKey,
  readPosition,
  resumePosition,
  writePosition,
  type ProgressStorage,
} from "./progress";

function memoryStorage(): ProgressStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

describe("the position of a movie", () => {
  it("is kept under a key of its own", () => {
    expect(positionKey(7)).toBe("mobile-cinema:progress:7");
  });

  it("is read back after it is written", () => {
    const storage = memoryStorage();
    writePosition(7, 42_000, storage);
    expect(readPosition(7, storage)).toBe(42_000);
  });

  it("is nothing when it was never written", () => {
    expect(readPosition(7, memoryStorage())).toBeNull();
  });

  it("is forgotten when the movie is cleared", () => {
    const storage = memoryStorage();
    writePosition(7, 42_000, storage);
    clearPosition(7, storage);
    expect(readPosition(7, storage)).toBeNull();
  });

  it("is not kept when the movie has barely started", () => {
    const storage = memoryStorage();
    writePosition(7, 3_000, storage);
    expect(readPosition(7, storage)).toBeNull();
  });

  it("is not kept when the number is nonsense", () => {
    const storage = memoryStorage();
    writePosition(7, Number.NaN, storage);
    writePosition(7, -1, storage);
    expect(readPosition(7, storage)).toBeNull();
  });

  it("is resumed where the movie was left", () => {
    const storage = memoryStorage();
    writePosition(7, 42_000, storage);
    expect(resumePosition(7, 3_600_000, storage)).toBe(42_000);
  });

  it("is not resumed when the movie was nearly over", () => {
    const storage = memoryStorage();
    writePosition(7, 59_000, storage);
    expect(resumePosition(7, 60_000, storage)).toBeNull();
  });

  it("is not resumed when it is too early to be worth it", () => {
    const storage = memoryStorage();
    writePosition(7, 3_000, storage);
    expect(resumePosition(7, 3_600_000, storage)).toBeNull();
  });

  it("survives a storage that holds a broken value", () => {
    const storage = memoryStorage();
    storage.setItem(positionKey(7), "not a number");
    expect(readPosition(7, storage)).toBeNull();
  });
});
