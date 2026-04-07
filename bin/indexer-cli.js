#!/usr/bin/env node
import { program } from 'commander';
import { registerInitCommand } from '../src/cli/commands/init.js';
import { registerIndexCommand } from '../src/cli/commands/index.js';
import { registerSearchCommand } from '../src/cli/commands/search.js';
import { registerStructureCommand } from '../src/cli/commands/structure.js';
import { registerArchitectureCommand } from '../src/cli/commands/architecture.js';
import { registerUninstallCommand } from '../src/cli/commands/uninstall.js';

program
  .name('indexer')
  .description('Lightweight project indexer with semantic search')
  .version('0.1.0');
registerInitCommand(program);
registerIndexCommand(program);
registerSearchCommand(program);
registerStructureCommand(program);
registerArchitectureCommand(program);
registerUninstallCommand(program);
program.parse();
