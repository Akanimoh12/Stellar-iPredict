/**
 * Renders the endpoint section of docs/API.md from an OpenAPI 3.x document.
 *
 * Pure by design: no I/O and no imports, so the same spec always produces the
 * same Markdown. The generator (../generate-api-reference.ts) supplies the spec
 * from the live route schemas and splices the result between the hand-written
 * preamble and footer.
 */

type Json = Record<string, any>;

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Escapes a value for use inside a Markdown table cell. */
function cell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/** Short, human-readable type name for a JSON Schema node. */
function typeOf(schema: Json | undefined): string {
  if (!schema) return "any";
  if (typeof schema.$ref === "string") return schema.$ref.split("/").pop() ?? "object";
  if (schema.type === "array") return `array of ${typeOf(schema.items)}`;
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.join(" or ");
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(typeOf).join(" or ");
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map(typeOf).join(" or ");
  return "any";
}

/** Appends the allowed values of an enum schema to a description. */
function withEnum(description: string, schema: Json | undefined): string {
  const values = Array.isArray(schema?.enum) ? schema.enum : undefined;
  if (!values || values.length === 0) return description;
  const allowed = `One of ${values.map((v: unknown) => `\`${String(v)}\``).join(", ")}.`;
  if (!description) return allowed;
  const sentence = /[.!?]$/.test(description) ? description : `${description}.`;
  return `${sentence} ${allowed}`;
}

/** Schema of the first media type declared in a `content` map, if any. */
function contentSchema(content: Json | undefined): Json | undefined {
  if (!content) return undefined;
  const first = Object.values(content)[0] as Json | undefined;
  return first?.schema;
}

interface Operation {
  method: (typeof METHODS)[number];
  path: string;
  op: Json;
}

function listOperations(spec: Json): Operation[] {
  const paths = (spec.paths ?? {}) as Record<string, Json>;
  const ops: Operation[] = [];
  for (const path of Object.keys(paths).sort()) {
    for (const method of METHODS) {
      const op = paths[path]?.[method];
      if (op) ops.push({ method, path, op });
    }
  }
  return ops;
}

function renderOperation({ method, path, op }: Operation): string {
  const lines: string[] = [];
  const verb = method.toUpperCase();
  lines.push(`### ${verb} ${path}`, "");

  const description = op.description ?? op.summary;
  if (description) lines.push(String(description), "");

  if (Array.isArray(op.tags) && op.tags.length > 0) {
    lines.push(`**Tags:** ${op.tags.join(", ")}`, "");
  }

  const secured = Array.isArray(op.security) && op.security.length > 0;
  lines.push(
    secured
      ? `**Authentication:** bearer token (${Object.keys(op.security[0]).join(", ")}).`
      : "**Authentication:** none.",
    "",
  );

  const params: Json[] = Array.isArray(op.parameters) ? op.parameters : [];
  const visible = params.filter((p) => p.in === "path" || p.in === "query" || p.in === "header");
  if (visible.length > 0) {
    lines.push("**Parameters:**", "");
    lines.push("| Name | In | Type | Required | Description |");
    lines.push("|------|----|------|----------|-------------|");
    for (const p of visible) {
      const required = p.required ? "yes" : "no";
      const desc = withEnum(p.description ?? "", p.schema);
      lines.push(`| \`${cell(p.name)}\` | ${cell(p.in)} | ${cell(typeOf(p.schema))} | ${required} | ${cell(desc) || "—"} |`);
    }
    lines.push("");
  } else {
    lines.push("**Parameters:** none.", "");
  }

  const body = op.requestBody;
  if (body) {
    const schema = contentSchema(body.content);
    lines.push(`**Request body:** ${typeOf(schema)}${body.required ? " (required)" : ""}.`, "");
  }

  const responses = (op.responses ?? {}) as Record<string, Json>;
  const codes = Object.keys(responses).sort();
  if (codes.length > 0) {
    lines.push("**Responses:**", "");
    lines.push("| Status | Description | Body |");
    lines.push("|--------|-------------|------|");
    for (const code of codes) {
      const r = responses[code];
      const bodyType = contentSchema(r.content);
      lines.push(`| ${cell(code)} | ${cell(r.description) || "—"} | ${cell(bodyType ? typeOf(bodyType) : "none")} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Renders the `## Endpoints` section: an index of every operation followed by
 * one subsection per operation. Operations are sorted by path, then method,
 * so the output is stable across runs.
 */
export function renderEndpoints(spec: Json): string {
  const ops = listOperations(spec);
  const lines: string[] = ["## Endpoints", ""];

  for (const { method, path, op } of ops) {
    const summary = op.summary ? ` — ${op.summary}` : "";
    lines.push(`- \`${method.toUpperCase()} ${path}\`${summary}`);
  }
  lines.push("");

  for (const operation of ops) {
    lines.push("---", "", renderOperation(operation));
  }

  return lines.join("\n");
}
