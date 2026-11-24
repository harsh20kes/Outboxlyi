import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import express from 'express';
import { db, initDatabase } from './src/db/index.ts';
import { users } from './src/db/schema.ts';
import { env } from './src/server/config/env.ts';
import {
  getBullBoardRouter,
  initEmailScheduler,
} from './src/server/queue/emailQueue.ts';
import { apiRouter } from './src/server/routes/api.ts';
import { authRouter } from './src/server/routes/auth.ts';
import { initElasticsearch } from './src/server/services/elasticsearch.ts';
import { initRedisConnection } from './src/server/services/redis.ts';
import {
  exchangeSlackCode,
  verifySlackOAuthState,
} from './src/server/services/slack.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function startServer() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '10mb' }));

  // Initialize database & external infrastructure safely
  await initDatabase();
  await initRedisConnection();
  await initEmailScheduler();
  await initElasticsearch();

  // Slack OAuth v2 callback (popup redirects here from Slack)
  app.get(
    ['/api/slack/callback', '/api/slack/callback/'],
    async (req, res) => {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const oauthError =
        typeof req.query.error === 'string' ? req.query.error : '';

      if (oauthError) {
        res.status(400).send(`
          <html><body style="font-family:sans-serif;padding:24px;color:#0f172a;">
            <h3>Slack authorization cancelled</h3>
            <p>${escapeHtml(oauthError)}</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'SLACK_OAUTH_ERROR', error: ${JSON.stringify(oauthError)} }, '*');
                setTimeout(() => window.close(), 1200);
              }
            </script>
          </body></html>
        `);
        return;
      }

      const statePayload = verifySlackOAuthState(state);
      if (!code || !statePayload) {
        res.status(400).send(`
          <html><body style="font-family:sans-serif;padding:24px;color:#b91c1c;">
            <h3>Invalid or expired Slack OAuth state</h3>
            <p>Please close this window and try connecting Slack again.</p>
          </body></html>
        `);
        return;
      }

      try {
        const slackAuth = await exchangeSlackCode(code);
        await db
          .update(users)
          .set({
            slackTeamId: slackAuth.teamId,
            slackTeamName: slackAuth.teamName,
            slackChannelName: slackAuth.channelName,
            slackChannelId: slackAuth.channelId,
            slackWebhookUrl: slackAuth.webhookUrl,
            slackAccessToken: slackAuth.accessToken,
            slackConnectedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, statePayload.userId));

        res.send(`
          <html><body style="font-family:sans-serif;padding:24px;color:#0f172a;">
            <h3>Slack connected</h3>
            <p>Connected to ${escapeHtml(slackAuth.teamName || 'Workspace')}${slackAuth.channelName ? ` (#${escapeHtml(slackAuth.channelName)})` : ''}. This window will close automatically.</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({
                  type: 'SLACK_OAUTH_SUCCESS',
                  teamName: ${JSON.stringify(slackAuth.teamName)},
                  channelName: ${JSON.stringify(slackAuth.channelName)}
                }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
          </body></html>
        `);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'OAuth exchange failed';
        res.status(500).send(`
          <html><body style="font-family:sans-serif;padding:24px;color:#b91c1c;">
            <h3>Slack connection failed</h3>
            <p>${escapeHtml(msg)}</p>
          </body></html>
        `);
      }
    }
  );

  // Public email/password auth routes
  app.use('/api/auth', authRouter);

  // Authenticated API routes
  app.use('/api', apiRouter);

  // Live BullMQ Bull-Board dashboard
  const bullBoardRouter = getBullBoardRouter();
  if (bullBoardRouter) {
    app.use('/admin/queues', bullBoardRouter);
  } else {
    app.get('/admin/queues', (_req, res) => {
      res.status(503).send(`
        <html><body style="font-family:sans-serif;padding:32px;max-width:560px;margin:auto;color:#0f172a;">
          <h2>BullMQ Dashboard Unavailable</h2>
          <p>Redis is not currently connected. Configure <code>REDIS_URL</code> in your environment secrets or start Redis via <code>docker-compose up -d</code>, then restart the server.</p>
          <p><a href="/" style="color:#1d4ed8;">Return to Dashboard</a></p>
        </body></html>
      `);
    });
  }

  // Vite dev middleware or production static assets
  if (env.nodeEnv !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(env.port, '0.0.0.0', () => {
    console.log(`Outboxly server listening on http://0.0.0.0:${env.port}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
