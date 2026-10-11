'use strict';

function createLogger({ silent = false } = {}) {
  const write = (level, message, meta) => {
    if (silent) return;
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`;
    (level === 'error' ? console.error : console.log)(line);
  };
  return {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}

module.exports = { createLogger };
