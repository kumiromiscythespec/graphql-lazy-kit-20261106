import { readFile, stat } from 'node:fs/promises';
import {
  assertValidSchema,
  buildClientSchema,
  buildSchema,
  isSchema,
  type GraphQLSchema,
  type IntrospectionQuery,
} from 'graphql';

export type SchemaInput = string | GraphQLSchema | object;

/** Accept SDL text, a schema filename, or either introspection JSON envelope. */
export async function loadSchema(input: SchemaInput): Promise<GraphQLSchema> {
  try {
    if (isSchema(input)) {
      assertValidSchema(input);
      return input;
    }
    let source: unknown = input;
    if (typeof source === 'string') {
      source = await readTextInput(source, 'schema');
      const text = (source as string).trim();
      source = text.startsWith('{') ? JSON.parse(text) : buildSchema(text);
    }
    let schema: GraphQLSchema;
    if (isSchema(source)) {
      schema = source;
    } else if (source && typeof source === 'object') {
      const object = source as Record<string, unknown>;
      const payload = object.data && typeof object.data === 'object' ? object.data : object;
      if (!('__schema' in (payload as object))) {
        throw new Error('Introspection JSON must contain __schema or data.__schema.');
      }
      schema = buildClientSchema(payload as IntrospectionQuery);
    } else {
      throw new Error('Supply GraphQL SDL, an introspection object, or a GraphQLSchema.');
    }
    assertValidSchema(schema);
    return schema;
  } catch (error) {
    throw new Error(`Invalid GraphQL schema: ${errorMessage(error)}`, { cause: error });
  }
}

/** A file path and inline GraphQL text are both useful in programmatic calls. */
export async function readTextInput(input: string, kind: 'schema' | 'fragments'): Promise<string> {
  if (!input.trim()) throw new Error(`The ${kind} input is empty.`);
  if (!input.includes('\n') && input.length < 4096) {
    try {
      if ((await stat(input)).isFile()) return await readFile(input, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENAMETOOLONG' && code !== 'EINVAL') throw error;
      if (/\.(graphql|gql|json)$/i.test(input)) {
        throw new Error(`Cannot read ${kind} file "${input}": ${errorMessage(error)}`);
      }
    }
  }
  return input;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
