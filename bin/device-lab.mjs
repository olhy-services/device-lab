#!/usr/bin/env node
// Permite `pnpm link --global` / `npx device-lab` rodando o TypeScript direto via tsx.
import { register } from 'tsx/esm/api';

register();
await import('../src/server/cli.ts');
