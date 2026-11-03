/**
 * SPDX-FileCopyrightText: 2025-2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// External dependencies - not bundled
const externalDeps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})];

// Match package names and their deep imports
const external = (id) => {
  if (id.startsWith('node:')) return true;
  return externalDeps.some((dep) => id === dep || id.startsWith(dep + '/'));
};

export default [
  // Stdio server (default)
  {
    input: 'src/docs-server.ts',
    output: {
      file: 'dist/docs-server.esm.js',
      format: 'esm',
      sourcemap: true,
      banner: '#!/usr/bin/env node',
    },
    external,
    plugins: [
      resolve({
        preferBuiltins: true,
      }),
      typescript({
        tsconfig: './tsconfig.build.json',
        // tsconfig.build.json targets `module: node20`. @rollup/plugin-typescript
        // (<= 12.3.0) only recognizes Node16/NodeNext and silently forces anything
        // else to ESNext, which then trips TS5110 against `moduleResolution: node16`.
        // Pin the plugin to the frozen `node16` kind it understands — identical
        // emit for this pure-ESM code — and drop the override once the plugin
        // learns about node20.
        module: 'node16',
        declaration: false,
        declarationMap: false,
        declarationDir: undefined,
      }),
    ],
  },
  // HTTP server
  {
    input: 'src/docs-server-http.ts',
    output: {
      file: 'dist/docs-server-http.esm.js',
      format: 'esm',
      sourcemap: true,
      banner: '#!/usr/bin/env node',
    },
    external,
    plugins: [
      resolve({
        preferBuiltins: true,
      }),
      typescript({
        tsconfig: './tsconfig.build.json',
        // tsconfig.build.json targets `module: node20`. @rollup/plugin-typescript
        // (<= 12.3.0) only recognizes Node16/NodeNext and silently forces anything
        // else to ESNext, which then trips TS5110 against `moduleResolution: node16`.
        // Pin the plugin to the frozen `node16` kind it understands — identical
        // emit for this pure-ESM code — and drop the override once the plugin
        // learns about node20.
        module: 'node16',
        declaration: false,
        declarationMap: false,
        declarationDir: undefined,
      }),
    ],
  },
];
