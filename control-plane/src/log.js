const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[process.env.LOG_LEVEL ?? 'info'] ?? levels.info;

function emit(level, msg, fields) {
  if (levels[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};
