// Bundles the function with the app's shared business logic (../src/utils,
// ../src/constants) into lib/index.js, so the backend runs exactly the
// production-date, de-duplication and metric code the app runs. npm
// packages stay external and are installed from functions/package.json.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'lib/index.js',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
