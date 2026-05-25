#!/usr/bin/env node

import { Command } from 'commander';
import { serveCommand } from './commands/serve.js';
import { scheduleCommand } from './commands/schedule.js';
import { listCommand } from './commands/list.js';
import { viewCommand } from './commands/view.js';
import { configCommand } from './commands/config.js';
import { runCommand } from './commands/run.js';
import { resumeCommand } from './commands/resume.js';
import { connectCommand } from './commands/connect.js';
import { browserSetupCommand } from './commands/browser-setup.js';
import { setupCommand } from './commands/setup.js';

const program = new Command();

program
  .name('agent-meetings')
  .alias('am')
  .description('Framework for structured technical meetings between AI agents and LLMs')
  .version('0.1.0');

program.addCommand(runCommand());
program.addCommand(resumeCommand());
program.addCommand(connectCommand());
program.addCommand(browserSetupCommand());
program.addCommand(serveCommand());
program.addCommand(scheduleCommand());
program.addCommand(listCommand());
program.addCommand(viewCommand());
program.addCommand(configCommand());
program.addCommand(setupCommand());

program.parse(process.argv);
