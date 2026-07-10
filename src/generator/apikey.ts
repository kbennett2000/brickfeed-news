import type { GenerationInput, Generator, GeneratorOutput } from "../types.js";

/**
 * API-key (Messages API) generator — documented stub for Slice 2b. It sits behind
 * the same Generator interface so config can already select "apikey", but calling
 * it throws NotImplemented rather than silently doing nothing. The subscription
 * path is the default and the only implemented provider this slice.
 *
 * When implemented, this will read ANTHROPIC_API_KEY via src/secrets.ts and call
 * the Messages API.
 */
export class ApiKeyGenerator implements Generator {
  async generate(_input: GenerationInput): Promise<GeneratorOutput | null> {
    throw new Error(
      "NotImplemented: API-key (Messages API) generator is Slice 2b. " +
        'Use generator.provider "subscription" for now.',
    );
  }
}
