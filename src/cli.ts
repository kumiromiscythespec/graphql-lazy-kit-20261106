#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate, type GeneratorPlugin } from './generator.js';
import { errorMessage } from './schema.js';

const help = `graphql-lazy-kit --schema schema.graphql --out generated [options]

Generate typed TypeScript clients and lazy fragment modules from SDL or introspection JSON.

Options:
  --schema FILE       GraphQL SDL or introspection JSON file (required)
  --out DIRECTORY     Output directory (required)
  --fragments FILE    Validated fragment definitions; otherwise scalar-field defaults
  --scalar NAME=TYPE  Scalar TypeScript mapping; repeat for multiple scalars
  --plugin MODULE     Local ESM plugin file or installed module; may be repeated
  --help, -h          Show this help

Example:
  graphql-lazy-kit --schema schema.graphql --out generated --scalar DateTime=string
`;

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(help); return; }
  let schema: string | undefined;
  let outDir: string | undefined;
  let fragments: string | undefined;
  const scalars: Record<string, string> = {};
  const pluginPaths: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!['--schema', '--out', '--fragments', '--scalar', '--plugin'].includes(flag)) throw new Error(`Unknown option ${flag}. Run --help for usage.`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value. Run --help for usage.`);
    if (flag === '--schema') schema = value;
    else if (flag === '--out') outDir = value;
    else if (flag === '--fragments') fragments = value;
    else if (flag === '--plugin') pluginPaths.push(value);
    else {
      const separator = value.indexOf('=');
      const name = value.slice(0, separator);
      const type = value.slice(separator + 1);
      if (separator < 1 || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(name) || !type.trim()) throw new Error(`Invalid --scalar "${value}". Expected ScalarName=TypeScriptType.`);
      scalars[name] = type;
    }
  }
  if (!schema || !outDir) throw new Error('Both --schema FILE and --out DIRECTORY are required. Run --help for usage.');
  // CLI schema/fragments arguments always mean files, unlike the programmatic API's inline inputs.
  await requireFile(schema, '--schema');
  if (fragments) await requireFile(fragments, '--fragments');
  const plugins: GeneratorPlugin[] = [];
  for (const specifier of pluginPaths) {
    let target = specifier;
    try { await access(resolve(specifier)); target = pathToFileURL(resolve(specifier)).href; } catch { /* bare installed module */ }
    const module = await import(target) as Record<string, unknown>;
    const plugin = (module.default ?? module) as GeneratorPlugin;
    if (!plugin || (typeof plugin.onFile !== 'function' && typeof plugin.transformSchema !== 'function')) throw new Error(`Plugin "${specifier}" must export onFile and/or transformSchema hooks (directly or as default).`);
    plugins.push(plugin);
  }
  const result = await generate({ schema, outDir, ...(fragments ? { fragments } : {}), scalars, plugins });
  process.stdout.write(`Generated ${result.files.length} files in ${resolve(outDir)}\n`);
}

async function requireFile(path: string, flag: string): Promise<void> {
  try { await access(path); } catch { throw new Error(`${flag} file does not exist or cannot be read: ${path}`); }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`graphql-lazy-kit: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
