# Migrating an untyped GraphQL client

Start from a manually maintained request:

```ts
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'query($id: ID!) { user(id: $id) { id username } }',
    variables: { id },
  }),
});
const result: any = await response.json();
console.log(result.data.user.username);
```

1. Save your server's SDL or introspection JSON in the project. Generate into a dedicated directory, using explicit mappings for custom scalars.
2. Replace the hand-written document and variables with a selection passed to `buildQuery` or `buildMutation`.
3. Replace direct response-envelope handling with `createClient(...).execute(operation)`. Catch `GraphQLRequestError` where partial-data behavior is a product decision.
4. Extract repeated selections into named `.graphql` fragments. The generated loader resolves their dependency graph and delays their code until an operation uses them.
5. Regenerate and compile in CI whenever the schema or fragments change. Commit generated source when consumers do not run the generator themselves.

```ts
import { buildQuery, createClient, GraphQLRequestError } from './generated/index.js';

const client = createClient({ url: endpoint });
try {
  const operation = await buildQuery({
    user: { args: { id }, select: { id: true, username: true } },
  });
  const result = await client.execute(operation);
  console.log(result.user?.username);
} catch (error) {
  if (error instanceof GraphQLRequestError) {
    console.error(error.errors, error.partialData);
  }
  throw error;
}
```

`user` is nullable because the schema permits it. Fields not selected are not promised in the result type. Avoid casting generated data to the complete schema output shape.

Argument values must be JSON-compatible. A `DateTime=string` scalar mapping requires a string such as an ISO timestamp. The generator does not turn a `Date` into JSON, supply custom server codecs, or reinterpret time zones.

This client does not preserve cache, retry, alias, directive, or subscription features from another GraphQL client automatically. Keep those concerns in your existing transport or adapter until you intentionally replace them.
