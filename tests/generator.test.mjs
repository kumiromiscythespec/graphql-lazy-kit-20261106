import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSchema, graphql, introspectionFromSchema, parse, validate, extendSchema } from 'graphql';
import { generate } from '../dist/generator.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
let workspace, sdl, fragments, schema, fromSdl, fromIntrospection;

async function compile(directory, extraSource) {
  if (extraSource) await fs.writeFile(path.join(directory, 'types.ts'), extraSource);
  await fs.writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, rootDir: '.', outDir: 'compiled', noEmitOnError: true }, include: ['generated/**/*.ts', 'types.ts'] }));
  const result = await exec(process.execPath, [tsc, '--project', path.join(directory, 'tsconfig.json')], { cwd: root, maxBuffer: 2_000_000 });
  return { ...result, client: await import(pathToFileURL(path.join(directory, 'compiled/generated/index.js')).href) };
}

before(async () => {
  await fs.mkdir(path.join(root, '.test-work'), { recursive: true });
  workspace = await fs.mkdtemp(path.join(root, '.test-work/integration-'));
  sdl = await fs.readFile(path.join(root, 'examples/schema.graphql'), 'utf8');
  fragments = await fs.readFile(path.join(root, 'examples/fragments.graphql'), 'utf8');
  schema = buildSchema(sdl);
  for (const [name, input] of [['sdl', sdl], ['introspection', introspectionFromSchema(schema)]]) {
    const directory = path.join(workspace, name);
    await generate({ schema: input, outDir: path.join(directory, 'generated'), fragments, scalars: { DateTime: 'string', JSON: 'Record<string, unknown>' } });
    const result = await compile(directory);
    if (name === 'sdl') fromSdl = result.client;
    else fromIntrospection = result.client;
  }
});

test('SDL and introspection inputs generate equivalent executable operations', async () => {
  const selection = { user: { args: { id: 'u1' }, select: { id: true, username: true, joinedAt: true, tags: true } } };
  const left = await fromSdl.buildQuery(selection, 'UserFromSdl');
  const right = await fromIntrospection.buildQuery(selection, 'UserFromSdl');
  assert.deepEqual(left, right);
  assert.deepEqual(validate(schema, parse(left.query)), []);
  assert.match(left.query, /\$\w+/);
  assert.ok(Object.values(left.variables).includes('u1'));
  assert.ok(!left.query.includes('"u1"'), 'argument values are encoded as variables, not interpolated');
});

test('generated query executes nested objects, custom scalars, nulls and lists against GraphQL', async () => {
  const operation = await fromSdl.buildQuery({
    user: {
      args: { id: 'u1' },
      select: {
        id: true, username: true, displayName: true, joinedAt: true, profile: true, tags: true,
        manager: { select: { id: true } },
        organizations: { select: { id: true, projects: { args: { includeArchived: false }, select: { id: true, metadata: true } } } },
      },
    },
  }, 'CurrentUser');
  const user = { id: 'u1', username: 'ada', displayName: null, joinedAt: '2026-11-01T10:00:00Z', profile: { timezone: 'Asia/Tokyo' }, tags: ['engineer', null], manager: null, organizations: [{ id: 'o1', projects: [{ id: 'p1', metadata: { archived: false } }] }] };
  let requestedId;
  const result = await graphql({ schema, source: operation.query, variableValues: operation.variables, rootValue: { user: ({ id }) => { requestedId = id; return user; } } });
  assert.equal(result.errors, undefined);
  assert.equal(requestedId, 'u1');
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), { user });
});

test('generated mutation transports typed nested input and an enum into a real resolver', async () => {
  const input = { projectId: 'p1', title: 'Ship a typed client', labels: ['typescript'], dueAt: null, metadata: { priority: 2 } };
  const operation = await fromSdl.buildMutation({ createTask: { args: { input }, select: { id: true, title: true, status: true, labels: true, dueAt: true } } }, 'CreateTask');
  let received;
  const result = await graphql({ schema, source: operation.query, variableValues: operation.variables, rootValue: { createTask: ({ input: value }) => { received = value; return { id: 't1', ...value, status: 'TODO' }; } } });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(received)), input);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), { createTask: { id: 't1', title: input.title, status: 'TODO', labels: ['typescript'], dueAt: null } });
});

test('a non-null argument with a GraphQL default may be omitted', async () => {
  const operation = await fromSdl.buildQuery({ users: { select: { id: true } } }, 'DefaultLimit');
  let receivedLimit;
  const result = await graphql({ schema, source: operation.query, variableValues: operation.variables, rootValue: { users: ({ limit }) => { receivedLimit = limit; return [{ id: 'u1' }]; } } });
  assert.equal(result.errors, undefined);
  assert.equal(receivedLimit, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), { users: [{ id: 'u1' }] });
  await assert.rejects(fromSdl.buildQuery({ users: { args: { limit: null }, select: { id: true } } }), /cannot be null|non-null/i);
});

test('transitive fragments load once and yield a GraphQL-valid document', async () => {
  const operation = await fromSdl.buildQuery({ task: { args: { id: 't1' }, select: { $fragments: ['TaskDetails'] } } }, 'TaskDetail');
  assert.deepEqual(validate(schema, parse(operation.query)), []);
  const definitions = parse(operation.query).definitions.filter(node => node.kind === 'FragmentDefinition').map(node => node.name.value);
  assert.ok(definitions.includes('TaskDetails'));
  assert.ok(definitions.includes('UserIdentity'));
  assert.ok(definitions.includes('CommentDetails'));
  assert.ok(!definitions.includes('OrganizationSummary'), 'unrequested fragments are absent from the document');
  assert.equal(new Set(definitions).size, definitions.length);
});

test('unknown or cyclic fragments are rejected instead of emitting unusable output', async () => {
  await assert.rejects(generate({ schema: sdl, outDir: path.join(workspace, 'missing-fragment'), fragments: 'fragment Broken on User { ...NotDefined }' }), /NotDefined|unknown|missing|fragment/i);
  await assert.rejects(generate({ schema: sdl, outDir: path.join(workspace, 'cyclic-fragments'), fragments: 'fragment A on User { ...B } fragment B on User { ...A }' }), /cycle|cyclic|fragment/i);
});

test('TypeScript checks selections, required arguments, input objects and selected result types', async () => {
  const directory = path.join(workspace, 'types');
  await generate({ schema: sdl, outDir: path.join(directory, 'generated'), fragments, scalars: { DateTime: 'string', JSON: 'Record<string, unknown>' } });
  await compile(directory, `
import { buildQuery, buildMutation } from './generated/index.js';
const op = await buildQuery({ user: { args: { id: 'u1' }, select: { id: true, displayName: true, joinedAt: true, profile: true, tags: true, manager: { select: { id: true } } } } });
type Data = NonNullable<typeof op.__data>;
const absent: Data = { user: null };
const complete: Data = { user: { id: 'u1', displayName: null, joinedAt: '2026-11-06', profile: { flag: true }, tags: ['ok', null], manager: null } };
void absent; void complete;
// @ts-expect-error Only selected fields are present in the result.
const extra: Data = { user: { id: 'u1', username: 'not selected', displayName: null, joinedAt: 'date', profile: null, tags: null, manager: null } };
// @ts-expect-error DateTime scalar mapping is string, not number.
const wrongScalar: Data = { user: { id: 'u1', displayName: null, joinedAt: 123, profile: null, tags: null, manager: null } };
// @ts-expect-error Unknown schema field.
await buildQuery({ imaginaryField: true });
// @ts-expect-error Unknown fields must be rejected alongside valid root fields.
await buildQuery({ serverTime: true, imaginaryField: true });
// @ts-expect-error Unknown nested fields must be rejected alongside valid fields.
await buildQuery({ user: { args: { id: 'u1' }, select: { id: true, imaginaryField: true } } });
// @ts-expect-error Required id argument is missing.
await buildQuery({ user: { select: { id: true } } });
// @ts-expect-error Required argument has an invalid object type.
await buildQuery({ user: { args: { id: { value: 'u1' } }, select: { id: true } } });
// @ts-expect-error Unknown arguments must be rejected alongside a valid argument.
await buildQuery({ user: { args: { id: 'u1', imaginaryArgument: true }, select: { id: true } } });
// @ts-expect-error Object fields require nested selection.
await buildQuery({ user: { args: { id: 'u1' }, select: { manager: true } } });
// @ts-expect-error Enum argument must use a schema enum value.
await buildQuery({ searchTasks: { args: { filter: { status: 'WAITING' } }, select: { id: true } } });
// @ts-expect-error CreateTaskInput requires projectId.
await buildMutation({ createTask: { args: { input: { title: 'missing project' } }, select: { id: true } } });
await buildQuery({ users: { select: { id: true } }, settings: true });
await buildQuery({ user: { args: { id: 'u1' }, select: { $fragments: ['UserIdentity'] } } });
await buildMutation({ updateTask: { args: { id: 't1', input: { status: 'DONE', dueAt: null } }, select: { id: true, labels: true } } });
const listOperation = await buildQuery({ users: { select: { id: true } } });
type ListData = NonNullable<typeof listOperation.__data>;
const emptyList: ListData = { users: [] };
void emptyList;
// @ts-expect-error The users list is non-null in the schema.
const nullList: ListData = { users: null };
// @ts-expect-error List elements are non-null in the schema.
const nullElement: ListData = { users: [null] };
const fragmentOperation = await buildQuery({ user: { args: { id: 'u1' }, select: { $fragments: ['UserIdentity'] } } });
type FragmentData = NonNullable<typeof fragmentOperation.__data>;
const fragmentData: FragmentData = { user: { id: 'u1', username: 'ada', displayName: null } };
void fragmentData;
// @ts-expect-error A selected fragment contributes its required fields to the result.
const missingFragmentField: FragmentData = { user: { id: 'u1', displayName: null } };
`);
});

test('schema-transform and generated-file plugin hooks are invoked', async () => {
  const transformed = [];
  const written = [];
  const outDir = path.join(workspace, 'plugins/generated');
  await generate({ schema: sdl, outDir, plugins: [{ transformSchema(current) { transformed.push(current); return extendSchema(current, parse('extend type Query { pluginHealth: String! }')); }, onFile(file) { written.push(file); return { ...file, content: file.content + '\n// inspected by test plugin\n' }; } }] });
  assert.equal(transformed.length, 1);
  assert.ok(written.length > 0);
  assert.match(await fs.readFile(path.join(outDir, 'index.ts'), 'utf8'), /inspected by test plugin/);
  const result = await compile(path.dirname(outDir));
  const operation = await result.client.buildQuery({ pluginHealth: true });
  assert.match(operation.query, /pluginHealth/);
});

test('plugin output cannot escape its destination or overwrite another generated file', async () => {
  const escapeOut = path.join(workspace, 'plugins-escape/generated');
  await assert.rejects(generate({ schema: sdl, outDir: escapeOut, plugins: [{ onFile(file) { return { ...file, path: '../escaped.ts' }; } }] }), /escape|outside|path/i);
  assert.equal(await fs.access(path.join(workspace, 'plugins-escape/escaped.ts')).then(() => true, () => false), false);
  await assert.rejects(generate({ schema: sdl, outDir: path.join(workspace, 'plugins-collision/generated'), plugins: [{ onFile(file) { return { ...file, path: 'same-file.ts' }; } }] }), /same|duplicate|collision|path/i);
});

test('CLI creates a usable client and rejects invalid options with a nonzero exit', async () => {
  const outDir = path.join(workspace, 'cli/generated');
  const pluginPath = path.join(workspace, 'cli-plugin.mjs');
  await fs.writeFile(pluginPath, `import { extendSchema, parse } from 'graphql';\nexport default { transformSchema(schema) { return extendSchema(schema, parse('extend type Query { cliPluginHealth: String! }')); } };\n`);
  await exec(process.execPath, [path.join(root, 'dist/cli.js'), '--schema', path.join(root, 'examples/schema.graphql'), '--out', outDir, '--fragments', path.join(root, 'examples/fragments.graphql'), '--scalar', 'DateTime=string', '--scalar', 'JSON=Record<string, unknown>', '--plugin', pluginPath], { cwd: root });
  assert.ok((await fs.stat(path.join(outDir, 'index.ts'))).isFile());
  const result = await compile(path.dirname(outDir));
  assert.match((await result.client.buildQuery({ cliPluginHealth: true })).query, /cliPluginHealth/);
  await assert.rejects(exec(process.execPath, [path.join(root, 'dist/cli.js'), '--schema'], { cwd: root }), error => error.code !== 0);
  await assert.rejects(exec(process.execPath, [path.join(root, 'dist/cli.js'), '--unknown-option'], { cwd: root }), error => error.code !== 0);
  const malformedSchema = path.join(workspace, 'malformed.graphql');
  await fs.writeFile(malformedSchema, 'type Query { broken: }');
  await assert.rejects(exec(process.execPath, [path.join(root, 'dist/cli.js'), '--schema', malformedSchema, '--out', path.join(workspace, 'malformed-output')], { cwd: root }), error => error.code !== 0);
});
