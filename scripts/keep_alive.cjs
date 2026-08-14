const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const serverPath = path.join(__dirname, '../dist/index.js');
const logFile = path.join(__dirname, '../server.log');

function log(msg) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

function startServer() {
  log('Starting RSS Aggregator Server...');
  const child = spawn(process.execPath, [serverPath], {
    stdio: 'ignore',
    cwd: path.join(__dirname, '..'),
    windowsHide: true
  });

  child.on('error', (err) => {
    log(`Failed to start server: ${err.message}`);
    setTimeout(startServer, 5000);
  });

  child.on('close', (code) => {
    log(`Server exited with code ${code}. Restarting in 5s...`);
    setTimeout(startServer, 5000);
  });
}

startServer();
