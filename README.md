# graphql-lazy-kit

Generate a standalone, typed TypeScript GraphQL client from SDL or introspection JSON. Query and mutation builders check field names and arguments, parameterize values, and load only the fragment modules an operation uses.

## Run

Requires Node.js 20.11 or later. The dependencies are pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run example
npm run benchmark
```

The CLI is `node dist/cli.js`. `npm pack` creates an installable package containing the compiled CLI, declarations, and runtime. Installing that tarball exposes the `graphql-lazy-kit` binary.

```sh
node dist/cli.js --schema examples/schema.graphql --out examples/generated \
  --fragments examples/fragments.graphql \
  --scalar DateTime=string --scalar 'JSON=Record<string,unknown>'
```

On Windows Command Prompt, use double quotes around the JSON scalar mapping. `npm run example` already supplies the correct quoting.

SDL, a raw introspection result containing `__schema`, and an HTTP response-shaped object containing `data.__schema` are supported. The CLI reads local files and does not fetch a remote endpoint or credentials.

## Build and execute a query

```ts
import { buildQuery, buildMutation, createClient } from './generated/index.js';

const operation = await buildQuery({
  user: {
    args: { id: 'user-1' },
    select: {
      $fragments: ['UserSummary'],
      tasks: {
        args: { status: 'TODO', limit: 5 },
        select: { id: true, title: true, status: true },
      },
    },
  },
}, 'UserTasks');

const client = createClient({ url: 'https://your-api.example/graphql' });
const data = await client.execute(operation);
// data.user and its selected fields retain the schema's nullability.

const mutation = await buildMutation({
  addComment: {
    args: { taskId: 'task-1', body: 'Review complete.' },
    select: { id: true, body: true },
  },
}, 'AddComment');
```

Every supplied argument becomes a GraphQL variable with its original GraphQL type. Values never become source text. Object fields use `{ select: ... }`; scalar fields without required arguments can use `true`. Fields with required arguments require `args` at compile time and at runtime.

The generated `types.ts` includes input objects, enums, scalar mappings, output shapes, selection types, and operation result types. Custom scalars are `unknown` unless mapped explicitly. A mapping describes JSON received from the server; it does not serialize or parse a JavaScript `Date` for you.

## Fragments and dependencies

Supply named GraphQL fragments with `--fragments`. They are grouped into modules by their type condition. `$fragments` selects a fragment by name, and the loader imports its module and transitive dependencies only when required.

```graphql
fragment UserIdentity on User { id username displayName }
fragment UserSummary on User {
  ...UserIdentity
  joinedAt
  manager { ...UserIdentity }
}
```

Missing dependencies, cyclic spreads, invalid type conditions, and invalid fields are rejected during generation. Generated static module references also let TypeScript detect a removed fragment file. Omitting `--fragments` generates a small scalar-field fragment for each entity type.

The runtime includes each used fragment definition once. It rejects unknown fragments, circular dependencies, invalid selections, unknown arguments, and missing required arguments with contextual errors.

`npm run benchmark` uses esbuild's ESM splitting and actual generated fragment modules. It writes both entry-closure byte counts and total emitted bytes to `benchmark-output/metrics.json`. The baseline eagerly includes the same fragment definitions; the lazy client delays them. Savings are initial JavaScript bytes, not a claim about total transfer volume or all application bundles.

## Programmatic API and plugins

```ts
import { generate } from 'graphql-lazy-kit';

await generate({
  schema: schemaSDL,
  outDir: './generated',
  fragments: fragmentSDL,
  scalars: { DateTime: 'string', JSON: 'Record<string, unknown>' },
  plugins: [{
    onFile(file) {
      return { ...file, content: '// generated; edit the schema instead\n' + file.content };
    },
  }],
});
```

Plugins may expose `transformSchema(schema)` and `onFile({ path, content })`. Hooks may be asynchronous and run in their declared order. A CLI plugin is a local ESM module exporting the plugin as `default`, loaded with `--plugin ./plugin.mjs`. Plugin modules are trusted code; generated files remain under the chosen output directory.

## Errors and migration

The CLI prints an actionable error and exits nonzero for malformed schemas, malformed fragments, missing dependencies, and invalid options. HTTP failures and GraphQL errors throw `GraphQLRequestError`, retaining the HTTP status, GraphQL errors, and any partial data in `partialData`.

See [MIGRATION.md](MIGRATION.md) for an untyped-client migration and the project's supported scope. Integration tests execute generated operations with `graphql`, compile generated clients with strict TypeScript checks, and check the CLI and transport failure paths.

## Scope

The tool produces query/mutation documents and a request-response fetch client. It does not supply a normalized cache, authentication policy, subscription transport, aliases, incremental `@defer` transport, or custom scalar codecs. Generate only into a directory dedicated to generated code and regenerate when the schema changes.

MIT licensed. No hosted service or account is required to use the generator.
