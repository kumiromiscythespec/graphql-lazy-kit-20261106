/** Standalone runtime copied into generated clients; it has no GraphQL dependency. */
export interface SchemaMeta {
  roots: { query?: string; mutation?: string; subscription?: string };
  types: Record<
    string,
    {
      fields: Record<
        string,
        { type: string; args?: Record<string, string>; optionalArgs?: readonly string[]; object?: string }
      >;
    }
  >;
}

export interface FragmentSpec {
  document: string;
  dependencies: readonly string[];
}

export interface BuiltOperation<T> {
  query: string;
  variables: Record<string, unknown>;
  readonly __data?: T;
}

type OperationKind = "query" | "mutation" | "subscription";
type PlainRecord = Record<string, unknown>;
const owns = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validName(value: string, context: string): void {
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(value)) {
    throw new TypeError(`Invalid GraphQL ${context}: ${JSON.stringify(value)}`);
  }
}

/** Reject values JSON would omit or silently change, before sending variables. */
function assertJson(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${path} must be a JSON value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a circular JSON value`);
  if (!Array.isArray(value) && !isRecord(value)) {
    throw new TypeError(`${path} must contain plain JSON objects`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    // An indexed loop also checks array holes, which JSON would turn into null.
    for (let index = 0; index < value.length; index += 1) {
      assertJson(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    for (const key of Object.keys(value)) assertJson(value[key], `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build a document while loading only the fragment modules the selection uses. */
export async function buildOperation<T>(
  meta: SchemaMeta,
  kind: OperationKind,
  selection: unknown,
  loadFragment: (name: string) => Promise<FragmentSpec>,
  operationName?: string,
): Promise<BuiltOperation<T>> {
  if (kind !== "query" && kind !== "mutation" && kind !== "subscription") {
    throw new TypeError(`Unsupported operation kind: ${String(kind)}`);
  }
  const root = meta.roots[kind];
  if (!root) throw new Error(`Schema has no ${kind} root`);
  if (operationName !== undefined) validName(operationName, "operation name");

  const variables: Record<string, unknown> = {};
  const definitions: string[] = [];
  const requestedFragments = new Set<string>();

  const render = (typeName: string, fields: unknown, path: string): string => {
    if (!isRecord(fields)) throw new TypeError(`${path} selection must be an object`);
    const type = owns(meta.types, typeName) ? meta.types[typeName] : undefined;
    if (!type) throw new Error(`Schema metadata is missing object type ${typeName}`);
    const rendered: string[] = [];

    for (const fieldName of Object.keys(fields)) {
      const chosen = fields[fieldName];
      if (fieldName === "$fragments") {
        if (!Array.isArray(chosen)) throw new TypeError(`${path}.$fragments must be an array`);
        const localFragments = new Set<string>();
        for (const name of chosen as unknown[]) {
          if (typeof name !== "string") {
            throw new TypeError(`${path}.$fragments must contain fragment names`);
          }
          validName(name, "fragment name");
          if (!localFragments.has(name)) {
            localFragments.add(name);
            requestedFragments.add(name);
            rendered.push(`...${name}`);
          }
        }
        continue;
      }

      const fieldPath = `${path}.${fieldName}`;
      if (fieldName === "__typename") {
        if (chosen !== true) throw new TypeError(`${fieldPath} must be true`);
        rendered.push("__typename");
        continue;
      }
      const field = owns(type.fields, fieldName) ? type.fields[fieldName] : undefined;
      if (!field) throw new Error(`Unknown field ${fieldPath} on ${typeName}`);
      validName(fieldName, "field name");
      if (chosen !== true && !isRecord(chosen)) {
        throw new TypeError(`${fieldPath} must be true or an object with args/select`);
      }
      const config: PlainRecord = chosen === true ? {} : chosen;
      if (chosen !== true && Object.keys(config).length === 0) {
        throw new TypeError(`${fieldPath} selection object cannot be empty; use true for a leaf field`);
      }
      for (const key of Object.keys(config)) {
        if (key !== "args" && key !== "select") {
          throw new TypeError(`Unknown selection option ${fieldPath}.${key}`);
        }
      }
      const provided = owns(config, "args") ? config.args : {};
      if (!isRecord(provided)) throw new TypeError(`${fieldPath}.args must be an object`);
      const argTypes = field.args ?? {};
      for (const name of Object.keys(provided)) {
        if (!owns(argTypes, name)) throw new Error(`Unknown argument ${fieldPath}(${name})`);
      }
      for (const name of Object.keys(argTypes)) {
        const argType = argTypes[name];
        if (
          argType &&
          argType.trim().endsWith("!") &&
          !field.optionalArgs?.includes(name) &&
          !owns(provided, name)
        ) {
          throw new Error(`Missing required argument ${fieldPath}(${name}: ${argType})`);
        }
      }
      const argumentsText: string[] = [];
      for (const name of Object.keys(provided)) {
        validName(name, "argument name");
        const argType = argTypes[name];
        if (!argType) throw new Error(`Missing GraphQL type for argument ${fieldPath}(${name})`);
        const value = provided[name];
        if (value === null && argType.trim().endsWith("!")) {
          throw new TypeError(`Required argument ${fieldPath}(${name}: ${argType}) cannot be null`);
        }
        assertJson(value, `${fieldPath}.args.${name}`);
        const variable = `v${definitions.length}`;
        definitions.push(`$${variable}: ${argType}`);
        variables[variable] = value;
        argumentsText.push(`${name}: $${variable}`);
      }
      const argumentsSuffix = argumentsText.length ? `(${argumentsText.join(", ")})` : "";
      if (field.object) {
        if (!owns(config, "select")) {
          throw new Error(`${fieldPath} returns ${field.object}; provide a nonempty select object`);
        }
        rendered.push(`${fieldName}${argumentsSuffix} ${render(field.object, config.select, fieldPath)}`);
      } else {
        if (owns(config, "select")) throw new Error(`Leaf field ${fieldPath} cannot have select`);
        rendered.push(`${fieldName}${argumentsSuffix}`);
      }
    }
    if (!rendered.length) throw new Error(`${path} selection cannot be empty`);
    return `{ ${rendered.join(" ")} }`;
  };

  const body = render(root, selection, kind);
  const documents: string[] = [];
  const loaded = new Set<string>();
  const visiting: string[] = [];
  const visit = async (name: string, parent?: string): Promise<void> => {
    if (loaded.has(name)) return;
    if (visiting.includes(name)) {
      throw new Error(`Fragment dependency cycle: ${[...visiting, name].join(" -> ")}`);
    }
    visiting.push(name);
    let fragment: FragmentSpec;
    try {
      fragment = await loadFragment(name);
    } catch (error) {
      const context = parent ? ` required by fragment ${parent}` : "";
      throw new Error(`Cannot load fragment ${name}${context}: ${errorMessage(error)}`, { cause: error });
    }
    if (
      !fragment ||
      typeof fragment.document !== "string" ||
      !fragment.document.trim() ||
      !Array.isArray(fragment.dependencies)
    ) {
      throw new Error(`Invalid fragment specification for ${name}`);
    }
    // Generator documents are standalone named fragment definitions, never operations.
    const declaration = /^\s*fragment\s+([_A-Za-z][_0-9A-Za-z]*)\s+on\s+/.exec(fragment.document);
    if (declaration?.[1] !== name) {
      throw new Error(`Fragment module ${name} must define fragment ${name}`);
    }
    for (const dependency of fragment.dependencies) {
      if (typeof dependency !== "string") throw new Error(`Invalid dependency in fragment ${name}`);
      validName(dependency, "fragment dependency");
      await visit(dependency, name);
    }
    visiting.pop();
    loaded.add(name);
    documents.push(fragment.document.trim());
  };
  for (const name of requestedFragments) await visit(name);

  const name = operationName === undefined ? "" : ` ${operationName}`;
  const declaration = definitions.length ? `(${definitions.join(", ")})` : "";
  return {
    query: `${kind}${name}${declaration} ${body}${documents.length ? `\n${documents.join("\n")}` : ""}`,
    variables,
  };
}

export interface GraphQLRequestErrorDetails {
  errors?: readonly unknown[];
  data?: unknown;
  status?: number;
  response?: unknown;
  cause?: unknown;
}

/** Transport and GraphQL failures retain error details and any partial data. */
export class GraphQLRequestError extends Error {
  readonly errors: readonly unknown[];
  readonly data: unknown;
  readonly partialData: unknown;
  readonly status: number | undefined;
  readonly response: unknown;

  constructor(message: string, details: GraphQLRequestErrorDetails = {}) {
    super(message, { cause: details.cause });
    this.name = "GraphQLRequestError";
    this.errors = details.errors ?? [];
    this.data = details.data;
    this.partialData = details.data;
    this.status = details.status;
    this.response = details.response;
  }
}

export function createClient(config: {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}): {
  execute<T>(operation: BuiltOperation<T>, options?: { signal?: AbortSignal }): Promise<T>;
} {
  const fetcher = config.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("A fetch implementation is required");
  if (!config.url) throw new TypeError("A GraphQL endpoint URL is required");
  return {
    async execute<T>(operation: BuiltOperation<T>, options?: { signal?: AbortSignal }): Promise<T> {
      if (!operation || typeof operation.query !== "string" || !operation.query.trim()) {
        throw new TypeError("A nonempty GraphQL operation is required");
      }
      if (!isRecord(operation.variables)) throw new TypeError("Operation variables must be an object");
      assertJson(operation.variables, "variables");
      let response: Response;
      try {
        response = await fetcher(config.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...config.headers },
          body: JSON.stringify({ query: operation.query, variables: operation.variables }),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        throw new GraphQLRequestError(`GraphQL network request failed: ${errorMessage(error)}`, { cause: error });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await response.text()) as unknown;
      } catch (error) {
        throw new GraphQLRequestError(`GraphQL response was not valid JSON (HTTP ${response.status})`, {
          status: response.status,
          cause: error,
        });
      }
      const envelope = isRecord(payload) ? payload : undefined;
      const errors = envelope && Array.isArray(envelope.errors) ? (envelope.errors as unknown[]) : [];
      const details: GraphQLRequestErrorDetails = {
        errors,
        data: envelope?.data,
        status: response.status,
        response: payload,
      };
      if (!response.ok) {
        throw new GraphQLRequestError(`GraphQL HTTP request failed (${response.status} ${response.statusText})`, details);
      }
      if (!envelope || (owns(envelope, "errors") && !Array.isArray(envelope.errors))) {
        throw new GraphQLRequestError("Invalid GraphQL response envelope", details);
      }
      if (errors.length) {
        const summary = errors.map((error) =>
          isRecord(error) && typeof error.message === "string" ? error.message : "Unspecified GraphQL error",
        );
        throw new GraphQLRequestError(`GraphQL errors: ${summary.join("; ")}`, details);
      }
      if (!owns(envelope, "data")) {
        throw new GraphQLRequestError("GraphQL response has neither data nor errors", details);
      }
      return envelope.data as T;
    },
  };
}
