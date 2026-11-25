// Bundles the demo into a single self-contained page.
//   node build.mjs          -> dist/index.html (open in a browser) and dist/artifact.html (fragment)
//   node build.mjs --test   -> also runs the generator across many seeds in Node
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

mkdirSync('dist', { recursive: true });

if (process.argv.includes('--test')) {
  for (const t of ['test-logic', 'test-world', 'test-determinism']) {
    await build({ entryPoints: [`src/${t}.ts`], bundle: true, platform: 'node', outfile: `dist/${t}.cjs`, logLevel: 'warning' });
  }
  execFileSync('node', ['dist/test-logic.cjs', '300'], { stdio: 'inherit' });
  execFileSync('node', ['dist/test-world.cjs', '300'], { stdio: 'inherit' });
  execFileSync('node', ['dist/test-determinism.cjs'], { stdio: 'inherit' });
}

const js = await build({
  entryPoints: ['src/main.ts'], bundle: true, format: 'iife', minify: true, target: 'es2020', write: false, logLevel: 'warning',
});
const script = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = ['src/shell.css', 'src/ui/panels.css'].filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n');
const body = readFileSync('src/page.html', 'utf8');
const fonts = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap';

const fragment = `<title>Poosheen Worldgen</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="${fonts}">
<style>
${css}
</style>
${body}
<script>
${script}
</script>
`;
writeFileSync('dist/artifact.html', fragment);
writeFileSync(
  'dist/index.html',
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<style>html,body{margin:0}</style>\n</head>\n<body>\n${fragment}</body>\n</html>\n`,
);
console.log(`built dist/index.html (${(fragment.length / 1024).toFixed(0)} kB)`);
