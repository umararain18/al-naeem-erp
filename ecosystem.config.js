// ANC ERP — PM2 process configuration for production.
//
// Runs the already-built Next.js production server (`next start`,
// NOT `next dev`) — this config does not build the app itself; run
// `npm run build` first (see docs/PRODUCTION_DEPLOYMENT.md / scripts/deploy.sh).
//
// Not started automatically by anything in this repo. To use it on
// the VPS: `pm2 start ecosystem.config.js --env production`.

module.exports = {
  apps: [
    {
      name: "anc-erp",
      // `next start` reads PORT from the environment itself (see
      // env.PORT below) and serves the build already produced by
      // `next build` — no watch/dev mode involved.
      script: "node_modules/.bin/next",
      args: "start",
      cwd: __dirname,

      // One instance is sufficient for this app's current scale
      // (single PostgreSQL connection pool per process via Prisma);
      // raise `instances` + set exec_mode: "cluster" later only if
      // actual load requires it.
      instances: 1,
      exec_mode: "fork",

      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },

      // Crash recovery — restart on crash/exit, but never spin
      // forever on a fast crash loop (e.g. a missing JWT_SECRET,
      // which the app throws on at startup).
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 3000,

      // Guards against a slow memory leak taking the VPS down;
      // raise this only if a real workload needs more.
      max_memory_restart: "512M",

      // `next start` is a long-running server, never a build/watch
      // step — no PM2 "watch" mode (that would restart the whole
      // app on every file in .next/ changing, which happens
      // constantly during normal operation).
      watch: false,

      // PM2's own log files — rotate/manage via `pm2 install
      // pm2-logrotate` on the VPS if volume becomes a concern; not
      // configured here to avoid assuming a log path that doesn't
      // exist yet.
      merge_logs: true,
      time: true,
    },
  ],
};
