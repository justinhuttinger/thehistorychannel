// Minimal structured logger. Keeps output greppable in Render logs.

function emit(level, msg, meta) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta } : {}),
  };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};
