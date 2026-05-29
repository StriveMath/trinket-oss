// Trinket sandbox adapter.
//
// Trinket's browser code speaks a Socket.IO event protocol to a per-language
// runtime at /python3, /java, /r (etc.). The original trinket.io runs
// proprietary sandboxes; this shim translates that protocol into one-shot
// REST calls against Piston (https://github.com/engineer-man/piston), which
// gives us battle-tested isolation for free.
//
// Limits of the translation:
//   - 'run' works: spawn -> collect stdout/stderr -> emit at end as one chunk
//   - 'console' (REPL) and 'write' (stdin mid-run) are NOT supported because
//     Piston is one-shot. We emit 'shell connect error' so the UI shows a
//     useful message instead of hanging.
//   - 'file added' (matplotlib graphs, etc.) is NOT supported here. Add later
//     by scanning Piston's per-run temp dir if needed.

const http = require('http');
const { Server } = require('socket.io');
const { request } = require('undici');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PISTON_URL = process.env.PISTON_URL || 'http://piston:2000';
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS || '10000', 10);
const COMPILE_TIMEOUT_MS = parseInt(process.env.COMPILE_TIMEOUT_MS || '10000', 10);
const MEMORY_LIMIT_BYTES = parseInt(process.env.MEMORY_LIMIT_BYTES || String(256 * 1024 * 1024), 10);

// Path prefix (as trinket sees it) -> Piston language + filename it expects.
// Versions are filled in on startup by querying Piston's /runtimes endpoint
// so we always use whatever's actually installed.
const LANGUAGES = {
  python3: { language: 'python',  versionPrefix: '3', filename: 'main.py'  },
  java:    { language: 'java',    versionPrefix: '',  filename: 'Main.java' },
  r:       { language: 'rscript', versionPrefix: '',  filename: 'main.r'   },
};

async function pistonRequest(method, path, body) {
  const res = await request(`${PISTON_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }
  return { status: res.statusCode, body: json };
}

async function listPistonRuntimes() {
  const { status, body } = await pistonRequest('GET', '/api/v2/runtimes');
  if (status !== 200) throw new Error(`Piston /runtimes returned ${status}`);
  return body;
}

async function ensurePistonPackage(language, versionPrefix) {
  const runtimes = await listPistonRuntimes();
  const installed = runtimes.find(
    (r) => r.language === language && (!versionPrefix || r.version.startsWith(versionPrefix))
  );
  if (installed) return installed.version;

  // Ask Piston what's available, install the highest matching version.
  const { status, body } = await pistonRequest('GET', '/api/v2/packages');
  if (status !== 200) throw new Error(`Piston /packages returned ${status}`);
  const candidates = body
    .filter((p) => p.language === language && (!versionPrefix || p.language_version.startsWith(versionPrefix)))
    .sort((a, b) => (a.language_version < b.language_version ? 1 : -1));
  if (!candidates.length) {
    throw new Error(`Piston has no package for ${language} ${versionPrefix || '*'}`);
  }
  const pick = candidates[0];
  console.log(`[sandbox] installing ${pick.language} ${pick.language_version}...`);
  const install = await pistonRequest('POST', '/api/v2/packages', {
    language: pick.language,
    version: pick.language_version,
  });
  if (install.status !== 200) {
    throw new Error(`install ${pick.language} ${pick.language_version} failed: ${install.status} ${JSON.stringify(install.body)}`);
  }
  console.log(`[sandbox] installed ${pick.language} ${pick.language_version}`);
  return pick.language_version;
}

async function waitForPiston() {
  const deadline = Date.now() + 60_000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      await listPistonRuntimes();
      console.log('[sandbox] piston is reachable');
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`piston never came up: ${lastErr && lastErr.message}`);
}

async function executeOnPiston(spec, code) {
  const body = {
    language: spec.language,
    version: spec.version,
    files: [{ name: spec.filename, content: code }],
    compile_timeout: COMPILE_TIMEOUT_MS,
    run_timeout: RUN_TIMEOUT_MS,
    compile_memory_limit: MEMORY_LIMIT_BYTES,
    run_memory_limit: MEMORY_LIMIT_BYTES,
  };
  const { status, body: resp } = await pistonRequest('POST', '/api/v2/execute', body);
  if (status !== 200) {
    return { error: `piston returned ${status}: ${JSON.stringify(resp)}` };
  }
  return resp;
}

function attachLanguage(httpServer, mountPath, spec) {
  // One Socket.IO instance per language, each on its own URL path so
  // trinket's `path: '/python3/socket.io/'` style routing works.
  const io = new Server(httpServer, {
    path: `${mountPath}/socket.io/`,
    cors: { origin: '*' },
    serveClient: false,
  });

  io.on('connection', (socket) => {
    console.log(`[sandbox] ${spec.language}: client connected ${socket.id}`);

    socket.on('run', async (payload) => {
      const code = (payload && payload.code) || '';
      try {
        const result = await executeOnPiston(spec, code);

        if (result.error) {
          socket.emit('script error', { error: result.error });
          socket.emit('done', { error: result.error });
          return;
        }

        // Piston returns separate compile and run phases. Surface compile
        // errors first so the UI labels them correctly.
        if (result.compile && result.compile.code !== 0 && result.compile.stderr) {
          socket.emit('compile error', { error: result.compile.stderr });
          socket.emit('done', { error: result.compile.stderr });
          return;
        }

        socket.emit('child ready');

        const run = result.run || {};
        const stdout = run.stdout || '';
        const stderr = run.stderr || '';

        // The browser handlers do `jqconsole.Write(out)` directly, so the
        // 'stdout' event payload must be a plain string, not an object.
        if (stdout) socket.emit('stdout', stdout);
        if (stderr) socket.emit('stdout', stderr);

        if (run.signal) {
          // 'SIGKILL' is what Piston uses when wall-clock timeout fires.
          const msg = run.signal === 'SIGKILL'
            ? `Execution timed out after ${RUN_TIMEOUT_MS / 1000}s`
            : `Killed by signal ${run.signal}`;
          socket.emit('script error', { error: msg });
          socket.emit('done', { error: msg });
        } else if (run.code !== 0 && stderr) {
          socket.emit('done', { error: stderr });
        } else {
          socket.emit('done', {});
        }
        socket.emit('exit', { code: run.code });
      } catch (err) {
        console.error(`[sandbox] ${spec.language} run error:`, err);
        socket.emit('script error', { error: err.message });
        socket.emit('done', { error: err.message });
      }
    });

    // REPL and stdin aren't supported in this one-shot adapter. Tell the UI.
    socket.on('console', () => {
      socket.emit('shell connect error');
      socket.emit('done', { error: 'Interactive console not supported in local sandbox.' });
    });
    socket.on('write', () => { /* no-op: no live stdin */ });
    socket.on('stop',  () => { /* no-op: piston run is short and unkillable from here */ });

    socket.on('disconnect', () => {
      console.log(`[sandbox] ${spec.language}: client disconnected ${socket.id}`);
    });
  });
}

async function main() {
  await waitForPiston();

  for (const [mount, cfg] of Object.entries(LANGUAGES)) {
    try {
      const version = await ensurePistonPackage(cfg.language, cfg.versionPrefix);
      cfg.version = version;
      console.log(`[sandbox] ready: /${mount} -> ${cfg.language} ${version}`);
    } catch (e) {
      console.error(`[sandbox] FAILED to prepare ${mount}:`, e.message);
      cfg.version = null;
    }
  }

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, languages: Object.fromEntries(
        Object.entries(LANGUAGES).map(([k, v]) => [k, v.version || 'unavailable'])
      )}));
      return;
    }
    res.writeHead(404); res.end();
  });

  for (const [mount, cfg] of Object.entries(LANGUAGES)) {
    if (!cfg.version) continue;
    attachLanguage(httpServer, `/${mount}`, cfg);
  }

  httpServer.listen(PORT, () => {
    console.log(`[sandbox] listening on :${PORT}`);
  });
}

main().catch((e) => {
  console.error('[sandbox] fatal:', e);
  process.exit(1);
});
