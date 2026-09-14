import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist-desktop', { recursive: true });
await mkdir('dist-server', { recursive: true });
await build({
  entryPoints: ['desktop/main.ts', 'desktop/preload.ts'],
  outdir: 'dist-desktop',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
});
