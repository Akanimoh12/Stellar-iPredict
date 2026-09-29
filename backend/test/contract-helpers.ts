import type { FastifyInstance } from "fastify";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const validators = new WeakMap<object, Ajv>();

// ── OpenAPI Specification Helper ──────────────────────────────────────────────

export async function getOpenApiSpec(app: FastifyInstance): Promise<any> {
  await app.ready();
  return app.swagger();
}

// ── OpenAPI Response Validation Engine (Ajv) ──────────────────────────────────

export interface ContractValidationResult {
  valid: boolean;
  errors: string[];
  schemaFound: boolean;
}

export function validateResponseAgainstSpec(
  spec: any,
  method: string,
  path: string,
  statusCode: number,
  responseBody: any
): ContractValidationResult {
  const normMethod = method.toLowerCase();
  const pathObj = spec.paths?.[path];

  if (!pathObj || !pathObj[normMethod]) {
    return {
      valid: false,
      errors: [`No OpenAPI spec path definition found for [${method.toUpperCase()} ${path}]`],
      schemaFound: false,
    };
  }

  const responseObj = pathObj[normMethod].responses?.[statusCode.toString()];
  if (!responseObj) {
    return {
      valid: false,
      errors: [
        `No declared OpenAPI response schema found for status code ${statusCode} under [${method.toUpperCase()} ${path}]`,
      ],
      schemaFound: false,
    };
  }

  // Extract JSON schema from response object
  const schema = responseObj.content?.["application/json"]?.schema || responseObj.schema;
  if (!schema) {
    return {
      valid: false,
      errors: [`No JSON schema definition found in responses for status ${statusCode} under [${method.toUpperCase()} ${path}]`],
      schemaFound: false,
    };
  }

  let ajv = validators.get(spec);
  if (!ajv) {
    ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validators.set(spec, ajv);
  }
  const pointer = `/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}/${normMethod}/responses/${statusCode}`;
  let validate = ajv.getSchema(pointer);
  if (!validate) {
    // Establish the document as the base for local OpenAPI component references.
    validate = ajv.compile({ ...schema, $id: pointer, components: spec.components ?? {} });
  }
  const valid = validate(responseBody) as boolean;

  const errors = (validate.errors || []).map(
    (err) => `${err.instancePath || "/"} ${err.message} (${JSON.stringify(err.params)})`
  );

  return { valid, errors, schemaFound: true };
}

// Compare handler output with serialized JSON, including nested arrays and objects.
export interface FieldDroppingResult {
  hasDroppedFields: boolean;
  droppedFields: string[];
}

export function detectDroppedFields(raw: unknown, serialized: unknown): FieldDroppingResult {
  const droppedFields: string[] = [];
  function visit(source: unknown, target: unknown, path: string): void {
    if (!source || typeof source !== "object" || source instanceof Date) return;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const childPath = Array.isArray(source) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      if (!target || typeof target !== "object" || !Object.prototype.hasOwnProperty.call(target, key)) {
        droppedFields.push(childPath);
      } else {
        visit(value, (target as Record<string, unknown>)[key], childPath);
      }
    }
  }
  visit(raw, serialized, "");
  return { hasDroppedFields: droppedFields.length > 0, droppedFields };
}
