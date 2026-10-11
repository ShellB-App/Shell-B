// Copies browser builds of libraries that HTML artifacts may use into public/vendor,
// so artifacts work with no internet access.
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
const out = 'public/vendor';
mkdirSync(out, { recursive: true });
const files = {
  'tailwind.js': 'node_modules/@tailwindcss/browser/dist/index.global.js',
  'chart.js': 'node_modules/chart.js/dist/chart.umd.min.js',
  'mermaid.js': 'node_modules/mermaid/dist/mermaid.min.js',
  'marked.js': 'node_modules/marked/lib/marked.umd.js',
};
for (const [name, src] of Object.entries(files)) copyFileSync(src, `${out}/${name}`);
// three.js is ESM-only: pages map "three" and "three/addons/" to these with an importmap
mkdirSync(`${out}/three`, { recursive: true });
for (const f of ['three.module.js', 'three.core.js']) copyFileSync(`node_modules/three/build/${f}`, `${out}/three/${f}`);
cpSync('node_modules/three/examples/jsm', `${out}/three/addons`, { recursive: true });
// the Draco decoder the Worlds app's model viewer loads at runtime (NASA's GLBs are Draco-compressed)
cpSync('node_modules/three/examples/jsm/libs/draco/gltf', `${out}/draco`, { recursive: true });
console.log('vendored', [...Object.keys(files), 'three', 'draco'].join(', '));
