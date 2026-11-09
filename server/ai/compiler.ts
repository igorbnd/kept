// Promise compiler. OWNER: ai agent. Plain-English promise -> CompiledPromise (structured output, validated by zod).
import type { CompiledPromise, Product } from "../types.ts";

export async function compilePromise(text: string, product: Product, merchantTimezone: string): Promise<CompiledPromise> {
  throw new Error("not implemented");
}
