'use strict';

const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'telebox',
      cwd: __dirname,
      script: path.join(__dirname, 'scripts', 'run-tsx.cjs'),
      args: ['./src/index.ts'],
      interpreter: process.execPath,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '768M',
    },
  ],
};
