import 'dotenv/config';
import {createServer} from 'node:http';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {watch} from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {WebSocketServer, WebSocket} from 'ws';
import type {AITask, AITaskKind} from './ai.js';
import {AITaskQueue, GeminiProvider, OpenAIProvider} from './ai.js';
import {resolveRepository} from './repository-root.js';
import {Repository} from '@aiverse/core';
import {activities, database, initializeDatabase, pullRequests, repositories, reviews, users} from './database.js';
import {createAccount, createSession, currentUser, destroySession, login, requireCsrf} from './auth.js';

const autoInit = process.argv.includes('--auto-init') || process.env.MINIGIT_AUTO_INIT === 'true';
const {repo, initialized} = await resolveRepository({cwd: process.cwd(), initCwd: process.env.INIT_CWD, explicitRoot: process.env.MINIGIT_REPO, autoInit});
const port = Number(process.env.PORT ?? 4179);
const host = process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const app = express();
const server = createServer(app);
function isAllowedWebOrigin(origin: string): boolean {
  const configuredOrigins = (process.env.WEB_ORIGIN ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return new Set(['http://localhost:5173', 'http://127.0.0.1:5173', ...configuredOrigins]).has(origin);
}
const wss = new WebSocketServer({server, path: '/api/events', verifyClient: ({origin}, callback) => {
  callback(!origin || isAllowedWebOrigin(origin), origin && !isAllowedWebOrigin(origin) ? 403 : 0, 'Origin not allowed');
}});

function broadcast(event: unknown): void {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
}

const aiProvider = process.env.AI_PROVIDER ?? 'gemini';
const externalAIEnabled = process.env.AI_ALLOW_NETWORK === 'true' && Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
const provider = externalAIEnabled && aiProvider === 'gemini' && process.env.GEMINI_API_KEY
  ? new GeminiProvider(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL ?? 'gemini-2.5-flash')
  : externalAIEnabled && process.env.OPENAI_API_KEY
    ? new OpenAIProvider(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL ?? 'gpt-4o-mini')
    : {async run() { throw new Error('Configura GEMINI_API_KEY y AI_ALLOW_NETWORK=true para habilitar la revisión con IA.'); }};
const aiTasks = new AITaskQueue(provider, Number(process.env.AI_CONCURRENCY ?? 2), Number(process.env.AI_MAX_RETRIES ?? 2),
  (task: AITask) => broadcast({type: 'ai-task', task}));

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({crossOriginResourcePolicy: {policy: 'same-site'}}));
app.post('/api/billing/webhook', express.raw({type: 'application/json'}), async (request, response, next) => {
  try {
    const secret = process.env.MP_WEBHOOK_SECRET;
    const signature = request.get('x-signature') ?? '';
    const requestId = request.get('x-request-id') ?? '';
    const dataId = String(request.query['data.id'] ?? request.query.id ?? '').toLowerCase();
    if (!secret || !users) { response.sendStatus(503); return; }
    const parts = Object.fromEntries(signature.split(',').map(part => part.trim().split('=')));
    const timestamp = parts.ts ?? '';
    const manifest = `${dataId ? `id:${dataId};` : ''}${requestId ? `request-id:${requestId};` : ''}${timestamp ? `ts:${timestamp};` : ''}`;
    const expected = createHmac('sha256', secret).update(manifest).digest('hex');
    const received = parts.v1 ?? '';
    if (!dataId || !timestamp || !requestId || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000 || received.length !== expected.length || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) { response.sendStatus(401); return; }
    const notification = Buffer.isBuffer(request.body) ? JSON.parse(request.body.toString('utf8')) as {type?:string;action?:string} : request.body as {type?:string;action?:string};
    if (notification.type === 'subscription_preapproval' || notification.action?.startsWith('subscription_preapproval')) {
      const accessToken = process.env.MP_ACCESS_TOKEN;
      if (!accessToken) { response.sendStatus(503); return; }
      const result = await fetch(`https://api.mercadopago.com/preapproval/${encodeURIComponent(dataId)}`, {headers: {Authorization: `Bearer ${accessToken}`}});
      if (!result.ok) { response.sendStatus(502); return; }
      const subscription = await result.json() as {id:string; status:string; external_reference?:string; payer_email?:string};
      const [userId, plan] = (subscription.external_reference ?? '').split(':');
      if (userId && ['starter','plus','pro'].includes(plan ?? '')) {
        await users.updateOne({id:userId}, {$set: {plan: subscription.status === 'authorized' ? plan : 'free', mpSubscriptionId: subscription.id, mpSubscriptionStatus: subscription.status, planUpdatedAt: new Date()}});
      } else if (subscription.status === 'cancelled') {
        await users.updateOne({mpSubscriptionId: subscription.id}, {$set: {plan:'free', mpSubscriptionStatus:'cancelled', planUpdatedAt:new Date()}});
      }
    }
    response.sendStatus(200);
  } catch (error) { next(error); }
});
app.use(express.json({limit: '2mb'}));
app.use(cookieParser());
app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && isAllowedWebOrigin(origin)) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Access-Control-Allow-Credentials', 'true'); response.setHeader('Vary', 'Origin'); }
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next();
});
app.options('*', (_request, response) => response.sendStatus(204));

app.get('/api/health', (_request, response) => response.json({ok: true, root: repo.root, provider: externalAIEnabled ? aiProvider : 'unconfigured'}));
app.get('/api/auth/csrf', (_request, response) => {
  const token = randomUUID() + randomUUID();
  const secure = process.env.NODE_ENV === 'production';
  response.cookie('aiverse_csrf', token, {httpOnly: false, secure, sameSite: secure ? 'none' : 'lax', path: '/'});
  response.json({csrfToken: token});
});
app.get('/api/health/ready', async (_request, response) => {
  if (!database) { response.status(503).json({ok: false, database: 'MONGODB_URI is not configured'}); return; }
  try { await database.command({ping: 1}); response.json({ok: true, database: 'connected'}); }
  catch { response.status(503).json({ok: false, database: 'unavailable'}); }
});
app.get('/api/repo/status', async (_request, response, next) => { try { response.json(await repo.status()); } catch (error) { next(error); } });
app.get('/api/repo/log', async (_request, response, next) => { try { response.json(await repo.log()); } catch (error) { next(error); } });
app.get('/api/repo/branches', async (_request, response, next) => { try { response.json(await repo.branches()); } catch (error) { next(error); } });
app.get('/api/repo/tree', async (request, response, next) => { try { response.json(await repo.tree(typeof request.query.ref === 'string' ? request.query.ref : undefined)); } catch (error) { next(error); } });
app.get('/api/repo/diff', async (_request, response, next) => { try { response.json(await repo.workingTreeDiff()); } catch (error) { next(error); } });
app.get('/api/repo/file', async (request, response, next) => {
  try {
    const filePath = typeof request.query.path === 'string' ? request.query.path : '';
    const entry = (await repo.tree()).find(item => item.path === filePath);
    if (!entry) { response.status(404).json({error: 'File not found'}); return; }
    const object = await repo.readObject(entry.hash);
    response.json({path: filePath, content: object.body.toString('utf8'), hash: entry.hash});
  } catch (error) { next(error); }
});
app.get('/api/structures', (_request, response) => response.json(repo.getStructureSnapshot()));

const authLimiter = rateLimit({windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false});
app.post('/api/auth/register', authLimiter, async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    const user = await createAccount(request.body ?? {});
    await createSession(String(user.id), response);
    response.status(201).json({user});
  } catch (error) { next(error); }
});
app.post('/api/auth/login', authLimiter, async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    const user = await login(request.body ?? {});
    await createSession(String(user.id), response);
    response.json({user});
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', async (request, response, next) => {
  try { if (!requireCsrf(request, response)) return; await destroySession(request, response); response.sendStatus(204); }
  catch (error) { next(error); }
});
app.get('/api/auth/me', async (request, response, next) => {
  try { response.json({user: await currentUser(request)}); }
  catch (error) { next(error); }
});

app.get('/api/billing/status', (_request, response) => response.json({enabled: Boolean(process.env.MP_ACCESS_TOKEN && process.env.MP_WEBHOOK_SECRET && process.env.MP_PRICE_STARTER_COP && process.env.MP_PRICE_PLUS_COP && process.env.MP_PRICE_PRO_COP)}));
app.post('/api/billing/checkout', async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    const user = await currentUser(request);
    if (!user) { response.status(401).json({error: 'Inicia sesión para elegir un plan.'}); return; }
    const plan = request.body?.plan;
    if (plan !== 'starter' && plan !== 'plus' && plan !== 'pro') { response.status(400).json({error: 'Plan no válido.'}); return; }
    const accessToken = process.env.MP_ACCESS_TOKEN;
    const amount = Number(process.env[plan === 'starter' ? 'MP_PRICE_STARTER_COP' : plan === 'plus' ? 'MP_PRICE_PLUS_COP' : 'MP_PRICE_PRO_COP']);
    if (!accessToken || !Number.isFinite(amount) || amount < 100) { response.status(503).json({error: 'Mercado Pago no está configurado todavía.'}); return; }
    const origin = (process.env.WEB_ORIGIN ?? '').split(',').map(value => value.trim()).filter(Boolean)[0];
    if (!origin) { response.status(503).json({error: 'Falta configurar WEB_ORIGIN para iniciar el pago.'}); return; }
    const checkout = await fetch('https://api.mercadopago.com/preapproval', {method:'POST', headers:{Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json'},
      body:JSON.stringify({reason:`AIVerse ${plan[0]!.toUpperCase()}${plan.slice(1)} mensual`, external_reference:`${user.id}:${plan}`, payer_email:user.email,
        auto_recurring:{frequency:1,frequency_type:'months',transaction_amount:amount,currency_id:'COP'}, back_url:`${origin}/#/account?billing=return`})});
    const result = await checkout.json() as {init_point?:string; sandbox_init_point?:string; message?:string; error?:string};
    const checkoutUrl = accessToken.startsWith('TEST-') ? result.sandbox_init_point ?? result.init_point : result.init_point;
    if (!checkout.ok || !checkoutUrl) { response.status(502).json({error:result.message??result.error??'Mercado Pago no pudo iniciar la suscripción.'}); return; }
    response.json({url:checkoutUrl});
  } catch (error) { next(error); }
});

app.get('/api/feed', async (_request, response, next) => {
  try {
    if (!repositories || !users) { response.status(503).json({error: 'Configura MONGODB_URI para habilitar el feed.'}); return; }
    const items = await repositories.find({isPublic: true}).sort({starsCount: -1, createdAt: -1}).limit(50).toArray();
    const owners = await users.find({id: {$in: items.map(item => item.ownerId)}}).project({id: 1, username: 1, display_name: 1}).toArray();
    const ownerById = new Map(owners.map(owner => [owner.id, owner]));
    response.json({repositories: items.map(item => ({id: item.id, name: item.name, description: item.description, stars_count: item.starsCount, created_at: item.createdAt,
      username: ownerById.get(item.ownerId)?.username ?? 'unknown', display_name: ownerById.get(item.ownerId)?.display_name ?? ''}))});
  } catch (error) { next(error); }
});
app.get('/api/feed/posts', async (_request, response, next) => {
  try {
    if (!activities || !users) { response.status(503).json({error: 'Configura MONGODB_URI para habilitar la comunidad.'}); return; }
    const posts = await activities.find({kind: 'community_post'}).sort({createdAt: -1}).limit(60).toArray();
    const authors = await users.find({id: {$in: posts.map(post => post.actorId)}}).project({id: 1, username: 1, display_name: 1}).toArray();
    const byId = new Map(authors.map(author => [author.id, author]));
    response.json({posts: posts.map(post => ({id: post.id, text: post.payload?.text, created_at: post.createdAt,
      username: byId.get(post.actorId)?.username ?? 'unknown', display_name: byId.get(post.actorId)?.display_name ?? ''}))});
  } catch (error) { next(error); }
});
app.post('/api/feed/posts', async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    if (!activities) { response.status(503).json({error: 'Configura MONGODB_URI para publicar.'}); return; }
    const user = await currentUser(request);
    if (!user) { response.status(401).json({error: 'Inicia sesión para publicar.'}); return; }
    const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
    if (!text || text.length > 1200) { response.status(400).json({error: 'La publicación debe tener entre 1 y 1200 caracteres.'}); return; }
    const post = {id: randomUUID(), actorId: user.id, kind: 'community_post', payload: {text}, createdAt: new Date()};
    await activities.insertOne(post);
    response.status(201).json({post: {...post, username: user.username, display_name: user.display_name}});
  } catch (error) { next(error); }
});
app.post('/api/repositories', async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    if (!repositories || !users) { response.status(503).json({error: 'Configura MONGODB_URI para crear repositorios.'}); return; }
    const user = await currentUser(request);
    if (!user) { response.status(401).json({error: 'Inicia sesión para continuar.'}); return; }
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    const description = typeof request.body?.description === 'string' ? request.body.description.trim() : '';
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || description.length > 350) { response.status(400).json({error: 'Nombre o descripción no válidos.'}); return; }
    const plan = String(user.plan ?? 'free');
    const repositoryLimit = plan === 'pro' ? Infinity : plan === 'plus' ? 20 : plan === 'starter' ? 10 : 3;
    const quotaFilter = repositoryLimit === Infinity ? {id: user.id} : {id: user.id, $expr: {$lt: [{$ifNull: ['$repositoryCount', 0]}, repositoryLimit]}};
    const quotaReservation = await users.updateOne(quotaFilter, {$inc: {repositoryCount: 1}});
    if (!quotaReservation.modifiedCount) { response.status(403).json({error: `Tu plan ${plan} permite hasta ${repositoryLimit} repositorios. Actualiza tu plan para crear más.`}); return; }
    const repository = {id: randomUUID(), ownerId: user.id, name, description, isPublic: request.body?.isPublic !== false,
      diskKey: randomUUID(), starsCount: 0, createdAt: new Date()};
    try {
      await repositories.insertOne(repository);
      const repositoryRoot = path.join(repo.root, 'aiverse-repositories', String(repository.diskKey));
      await mkdir(path.dirname(repositoryRoot), {recursive: true});
      await Repository.init(repositoryRoot);
    } catch (error) {
      await repositories.deleteOne({id: repository.id});
      await users.updateOne({id: user.id}, {$inc: {repositoryCount: -1}});
      if ((error as {code?: number}).code === 11000) { response.status(409).json({error: 'Ya tienes un repositorio con ese nombre.'}); return; }
      throw error;
    }
    response.status(201).json({repository: {...repository, disk_key: repository.diskKey, is_public: repository.isPublic}});
  } catch (error) { next(error); }
});
app.get('/api/pull-requests', async (request, response, next) => {
  try {
    if (!pullRequests || !repositories || !users) { response.status(503).json({error: 'Configura MONGODB_URI para habilitar los PRs.'}); return; }
    const repositoryId = typeof request.query.repositoryId === 'string' ? request.query.repositoryId : '';
    const user = await currentUser(request);
    const repoFilter = repositoryId ? {id: repositoryId} : {};
    const visibleRepos = await repositories.find({...repoFilter, $or: [{isPublic: true}, {ownerId: user?.id ?? null}]}).project({id: 1}).toArray();
    const items = await pullRequests.find({repositoryId: {$in: visibleRepos.map(item => item.id)}}).sort({createdAt: -1}).limit(100).toArray();
    const authors = await users.find({id: {$in: items.map(item => item.authorId)}}).project({id: 1, username: 1}).toArray();
    const authorById = new Map(authors.map(author => [author.id, author.username]));
    response.json({pullRequests: items.map(item => ({...item, username: authorById.get(item.authorId) ?? 'unknown'}))});
  } catch (error) { next(error); }
});
app.post('/api/pull-requests', async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    if (!pullRequests || !repositories || !activities) { response.status(503).json({error: 'Configura MONGODB_URI para habilitar los PRs.'}); return; }
    const user = await currentUser(request);
    if (!user) { response.status(401).json({error: 'Inicia sesión para continuar.'}); return; }
    const {repositoryId, title, body, sourceBranch, targetBranch} = request.body ?? {};
    if (![repositoryId,title,sourceBranch,targetBranch].every(value => typeof value === 'string' && value.trim().length > 0) || title.length > 180 || String(body ?? '').length > 20_000) {
      response.status(400).json({error: 'Datos del pull request no válidos.'}); return;
    }
    const repository = await repositories.findOne({id: repositoryId, ownerId: user.id});
    if (!repository) { response.status(404).json({error: 'Repositorio no encontrado o sin permisos.'}); return; }
    const pullRequest = {id: randomUUID(), repositoryId, authorId: user.id, title: title.trim(), body: String(body ?? ''),
      sourceBranch: sourceBranch.trim(), targetBranch: targetBranch.trim(), status: 'open', createdAt: new Date(), updatedAt: new Date()};
    await pullRequests.insertOne(pullRequest);
    await activities.insertOne({id: randomUUID(), actorId: user.id, repositoryId, kind: 'pull_request_opened', payload: {pullRequestId: pullRequest.id, title}, createdAt: new Date()});
    response.status(201).json({pullRequest});
  } catch (error) { next(error); }
});
app.post('/api/pull-requests/:id/reviews', async (request, response, next) => {
  try {
    if (!requireCsrf(request, response)) return;
    if (!pullRequests || !repositories || !reviews) { response.status(503).json({error: 'Configura MONGODB_URI para habilitar las revisiones.'}); return; }
    const user = await currentUser(request);
    if (!user) { response.status(401).json({error: 'Inicia sesión para continuar.'}); return; }
    const {body, state} = request.body ?? {};
    if (typeof body !== 'string' || body.length > 20_000 || !['commented','approved','changes_requested'].includes(state)) { response.status(400).json({error: 'Revisión no válida.'}); return; }
    const pullRequest = await pullRequests.findOne({id: request.params.id});
    const repository = pullRequest ? await repositories.findOne({id: pullRequest.repositoryId}) : null;
    if (!pullRequest || (pullRequest.authorId !== user.id && repository?.ownerId !== user.id)) { response.status(404).json({error: 'PR no encontrado o sin permisos.'}); return; }
    const review = {id: randomUUID(), pullRequestId: request.params.id, reviewerId: user.id, body, state, createdAt: new Date()};
    await reviews.insertOne(review);
    response.status(201).json({review});
  } catch (error) { next(error); }
});

app.post('/api/repo/add', async (request, response, next) => { try { response.json({staged: await repo.add(request.body.paths ?? [])}); } catch (error) { next(error); } });
app.post('/api/repo/commit', async (request, response, next) => { try { response.json({hash: await repo.commit(request.body.message)}); } catch (error) { next(error); } });
app.post('/api/repo/branch', async (request, response, next) => { try { await repo.branch(request.body.name); response.json({branches: await repo.branches()}); } catch (error) { next(error); } });
app.post('/api/repo/checkout', async (request, response, next) => { try { await repo.checkout(request.body.name); response.json({branch: request.body.name}); } catch (error) { next(error); } });
app.post('/api/repo/merge', async (request, response, next) => { try { response.json(await repo.merge(request.body.name)); } catch (error) { next(error); } });
app.post('/api/repo/stash', async (request, response, next) => { try { response.json({stashes: await repo.stash(request.body.action ?? 'push')}); } catch (error) { next(error); } });
app.post('/api/repo/reset', async (request, response, next) => { try { response.json({hash: await repo.reset(request.body.target ?? 'HEAD', request.body.hard ?? false)}); } catch (error) { next(error); } });
app.post('/api/repo/revert', async (request, response, next) => { try { response.json({hash: await repo.revert(request.body.target)}); } catch (error) { next(error); } });

app.get('/api/ai/tasks', (_request, response) => response.json(aiTasks.list()));
app.get('/api/ai/tasks/:id', (request, response) => {
  const task = aiTasks.get(request.params.id);
  if (!task) { response.status(404).json({error: 'Task not found'}); return; }
  response.json(task);
});
app.post('/api/ai/:kind', (request, response) => {
  const kind = request.params.kind as AITaskKind;
  if (!['review', 'commit-msg', 'resolve', 'ask'].includes(kind)) { response.status(404).json({error: 'Unknown AI task'}); return; }
  response.status(202).json(aiTasks.enqueue(kind, request.body.diff ?? request.body.text ?? ''));
});

app.get('/api/remote/refs', async (_request, response, next) => { try { response.json({refs: (await repo.remoteSnapshot()).refs}); } catch (error) { next(error); } });
app.get('/api/remote/hashes', async (_request, response, next) => { try { response.json({hashes: await repo.objectHashes()}); } catch (error) { next(error); } });
app.post('/api/remote/pack', async (request, response, next) => { try { response.json(await repo.remoteSnapshot(request.body.have ?? [], request.body.bloom)); } catch (error) { next(error); } });
app.post('/api/remote/push', async (request, response, next) => {
  try {
    if (!request.body.snapshot) { response.status(400).json({error: 'snapshot required'}); return; }
    await repo.importRemote(request.body.snapshot);
    response.json({ok: true, refs: (await repo.remoteSnapshot()).refs});
  } catch (error) { next(error); }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(400).json({error: error instanceof Error ? error.message : String(error)});
});

try {
  watch(repo.root, {recursive: true}, (eventType, filename) => {
    if (filename && !String(filename).includes('.minigit')) broadcast({type: 'filesystem', eventType, path: filename});
  });
} catch { /* Explicit API refresh remains available on filesystems without recursive watch. */ }

if (process.env.MONGODB_URI) await initializeDatabase();
server.listen(port, host, () => {
  if (initialized) console.log(`Initialized MiniGit repository at ${repo.root}`);
  console.log(`MiniGit server listening on http://${host}:${port} (repo ${repo.root})`);
});
