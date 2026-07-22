import { randomBytes } from "node:crypto";

export interface RandomSource {
  next(): number;
}

const MAX_RANDOM_INTEGER = 2 ** 48;

export class CryptoRandomSource implements RandomSource {
  next(): number {
    return randomBytes(6).readUIntBE(0, 6) / MAX_RANDOM_INTEGER;
  }
}
