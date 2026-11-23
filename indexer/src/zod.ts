export class ZodValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZodValidationError";
  }
}

export interface Schema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: Error };
}

export function schema<T>(parse: (value: unknown) => T): Schema<T> {
  return {
    parse,
    safeParse(value: unknown) {
      try {
        return { success: true, data: parse(value) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new ZodValidationError(String(error)),
        };
      }
    },
  };
}

export type infer<T extends Schema<unknown>> = T extends Schema<infer Output> ? Output : never;
