export class ZodValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZodValidationError";
  }
}

export interface Schema<T> {
  parse(value: unknown): T;
}

export function schema<T>(parse: (value: unknown) => T): Schema<T> {
  return { parse };
}

export type infer<T extends Schema<unknown>> = T extends Schema<infer Output> ? Output : never;
