import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parse } from 'graphql';
import { generate } from '../dist/generator.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'benchmark-output');
const generated = path.join(output, 'generated');
await fs.mkdir(output, { recursive: true });
const schema = await fs.readFile(path.join(root, 'examples/schema.graphql'), 'utf8');
const fragments = await fs.readFile(path.join(root, 'examples/fragments.graphql'), 'utf8');
await generate({ schema, fragments, outDir: generated, scalars: { DateTime: 'string', JSON: 'Record<string, unknown>' } });

async function walk(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(file));
    else found.push(file);
  }
  return found;
}

// Both entries export the same real query builder. The eager baseline also
// statically exposes every generated fragment, as a preloaded fragment catalog.
// No padded strings or synthetic fragment payloads are added to either build.
const fragmentFiles = (await walk(generated)).filter(file => path.relative(generated, file).replaceAll('\\', '/').startsWith('fragments/') && file.endsWith('.ts') && !file.endsWith('.d.ts')).sort();
assert.ok(fragmentFiles.length > 0, 'generation must create real fragment modules');
const lazyEntry = path.join(output, 'lazy-entry.ts');
const eagerEntry = path.join(output, 'eager-entry.ts');
await fs.writeFile(lazyEntry, "export { buildQuery } from './generated/index.js';\n");
const eagerImports = fragmentFiles.map((file, index) => `import * as fragment${index} from ${JSON.stringify('./' + path.relative(output, file).replaceAll('\\', '/'))};`);
await fs.writeFile(eagerEntry, [...eagerImports, "export { buildQuery } from './generated/index.js';", `export const preloadedFragments = [${fragmentFiles.map((_, index) => `fragment${index}`).join(', ')}];`, ''].join('\n'));

async function measure(name, entry) {
  const outdir = path.join(output, name);
  const result = await build({ absWorkingDir: root, entryPoints: [entry], outdir, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, metafile: true, sourcemap: false, write: true, logLevel: 'silent' });
  await fs.writeFile(path.join(output, `${name}-metafile.json`), JSON.stringify(result.metafile, null, 2) + '\n');
  const outputs = result.metafile.outputs;
  const entryOutput = Object.keys(outputs).find(file => outputs[file].entryPoint && path.resolve(root, outputs[file].entryPoint) === path.resolve(entry));
  assert.ok(entryOutput, 'esbuild must identify the bundle entry');
  const visited = new Set();
  function initial(file) {
    if (visited.has(file)) return 0;
    visited.add(file);
    const metadata = outputs[file];
    assert.ok(metadata, `missing output metadata for ${file}`);
    let bytes = metadata.bytes;
    for (const dependency of metadata.imports) {
      if (dependency.external || dependency.kind !== 'import-statement') continue;
      const target = Object.hasOwn(outputs, dependency.path) ? dependency.path : path.relative(root, path.resolve(root, path.dirname(file), dependency.path)).replaceAll('\\', '/');
      bytes += initial(target);
    }
    return bytes;
  }
  const initialBytes = initial(entryOutput);
  const totalBytes = Object.values(outputs).reduce((sum, value) => sum + value.bytes, 0);
  return { initialBytes, totalBytes, chunks: Object.keys(outputs).length, entryBytes: outputs[entryOutput].bytes, initialFiles: [...visited], dynamicFragmentChunkBytes: totalBytes - initialBytes };
}

const lazy = await measure('lazy', lazyEntry);
const eager = await measure('eager', eagerEntry);
const metrics = {
  measuredAt: new Date().toISOString(),
  fixture: 'examples/schema.graphql + examples/fragments.graphql',
  fragmentModuleCount: fragmentFiles.length,
  fragmentDefinitionCount: parse(fragments).definitions.length,
  configuration: { format: 'esm', splitting: true, minify: true, platform: 'browser', target: 'es2022', byteMeasure: 'raw UTF-8 output; not gzip or network transfer time' },
  comparison: 'lazy exports only buildQuery; eager exports the same builder and a statically preloaded catalog of the real generated fragments',
  lazy,
  eager,
  initialBytesSaved: eager.initialBytes - lazy.initialBytes,
  initialReductionPercent: Number(((1 - lazy.initialBytes / eager.initialBytes) * 100).toFixed(2)),
  totalBytesDifference: lazy.totalBytes - eager.totalBytes,
  limitations: 'Measures this fixture only. Lazy loading adds async boundaries and chunk requests; total bytes may be greater. No latency, compression, or large-production-schema claim is made.',
};
await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
console.log(JSON.stringify(metrics, null, 2));
assert.ok(lazy.initialBytes < eager.initialBytes, 'the real fixture should defer fragment bytes from the initial lazy bundle');
