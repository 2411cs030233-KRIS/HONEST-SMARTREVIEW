// src/utils/logger.js
const isDev = process.env.NODE_ENV !== 'production';

const fmt = (level, msg, ...args) => {
  const ts = new Date().toISOString();
  const extra = args.length ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') : '';
  return `[${ts}] [${level}] ${msg}${extra}`;
};

const logger = {
  info:  (msg, ...a) => console.log(fmt('INFO ', msg, ...a)),
  warn:  (msg, ...a) => console.warn(fmt('WARN ', msg, ...a)),
  error: (msg, ...a) => console.error(fmt('ERROR', msg, ...a)),
  debug: (msg, ...a) => { if (isDev) console.log(fmt('DEBUG', msg, ...a)); },
};

module.exports = logger;
