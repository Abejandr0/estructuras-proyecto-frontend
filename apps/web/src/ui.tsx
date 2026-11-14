import {useCallback, useEffect, useMemo, useState} from 'react';
import type {FormEvent} from 'react';

type Commit = {hash: string; commit: {message: string; date: string; parents: string[]}};
type Entry = {path: string; hash: string};
type Status = {branch: string; staged: Entry[]; untracked: string[]; modified: string[]};
type Change = {path: string; status: 'modified' | 'deleted' | 'untracked'; oldText: string; newText: string; lines: string[]};
type AITask = {id: string; kind: string; state: 'pending' | 'processing' | 'ready' | 'error'; result?: string; error?: string; attempts: number};
type Health = {ok: boolean; root?: string; provider: string; sharedRepositoryApiEnabled: boolean};

const api = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:4179' : '')).replace(/\/$/, '');
const eventsUrl = new URL('/api/events', api || window.location.origin);
eventsUrl.protocol = eventsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = eventsUrl.toString();

type Page = 'home'|'feed'|'docs'|'workspace'|'login'|'register'|'account'|'settings'|'prs'|'pricing'|'terms'|'privacy'|'legal'|'cookies'|'notFound';
type Theme = 'system'|'light'|'dark';
type RoutePage = Exclude<Page, 'notFound'>;
const pageRoutes: Record<RoutePage, string> = {home: '/', feed: '/explore', docs: '/docs', workspace: '/workspace', login: '/login', register: '/signup', account: '/account', settings: '/settings', prs: '/pull-requests', pricing: '/pricing', terms: '/terms', privacy: '/privacy', legal: '/aviso-legal', cookies: '/cookies'};
function pageFromLocation(): Page {
  const legacyRoute = window.location.pathname === '/' && window.location.hash.startsWith('#/')
    ? window.location.hash.slice(1).split('?')[0]
    : '';
  if (legacyRoute) window.history.replaceState(window.history.state, '', legacyRoute + window.location.search);
  const route = legacyRoute || window.location.pathname.replace(/\/$/, '') || '/';
  return (Object.entries(pageRoutes).find(([, value]) => value === route)?.[0] as RoutePage | undefined) ?? 'notFound';
}

function missingApiError(): Error | null {
  // Production may intentionally use a same-origin /api proxy, so an empty
  // VITE_API_URL is valid there. Local development still needs an API target.
  return api || import.meta.env.PROD ? null : new Error('Falta VITE_API_URL. Configura la URL del backend o un proxy /api en el mismo dominio.');
}

async function getJSON<T>(route: string): Promise<T> {
  const configError = missingApiError();
  if (configError) throw configError;
  let response: Response;
  try { response = await fetch(api + route, {credentials: 'include'}); }
  catch { throw new Error('No se pudo conectar con el backend. Comprueba que esté activo y que VITE_API_URL o el proxy /api apunten al servidor correcto.'); }
  if (!response.ok) throw new Error((await response.json() as {error?: string}).error ?? response.statusText);
  return response.json() as Promise<T>;
}

async function postJSON<T>(route: string, body: unknown): Promise<T> {
  const configError = missingApiError();
  if (configError) throw configError;
  let csrfResponse: Response;
  try { csrfResponse = await fetch(api + '/api/auth/csrf', {credentials: 'include'}); }
  catch { throw new Error('No se pudo conectar con el backend. Comprueba que esté activo y que VITE_API_URL o el proxy /api apunten al servidor correcto.'); }
  if (!csrfResponse.ok) throw new Error('El backend no pudo preparar la sesión segura. Revisa su configuración.');
  const {csrfToken} = await csrfResponse.json() as {csrfToken: string};
  let response: Response;
  try { response = await fetch(api + route, {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken}, body: JSON.stringify(body)}); }
  catch { throw new Error('No se pudo conectar con el backend. Comprueba que esté activo y que VITE_API_URL o el proxy /api apunten al servidor correcto.'); }
  const result = await response.json() as T & {error?: string};
  if (!response.ok) throw new Error(result.error ?? response.statusText);
  return result;
}

export default function App() {
  const [page, setCurrentPage] = useState<Page>(pageFromLocation);
  const [feed, setFeed] = useState<Array<{id:string;name:string;description:string;stars_count:number;username:string;created_at?:string}>>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState('');
  const [postsLoading, setPostsLoading] = useState(true);
  const [postsError, setPostsError] = useState('');
  const [user, setUser] = useState<{username:string;display_name:string;email:string}|null>(null);
  const [formError, setFormError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [passwordValue, setPasswordValue] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [log, setLog] = useState<Commit[]>([]);
  const [files, setFiles] = useState<Entry[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [status, setStatus] = useState<Status>({branch: 'main', staged: [], untracked: [], modified: []});
  const [health, setHealth] = useState<Health | null>(null);
  const [selected, setSelected] = useState('');
  const [content, setContent] = useState('');
  const [terminal, setTerminal] = useState('');
  const [output, setOutput] = useState<string[]>([]);
  const [aiTask, setAiTask] = useState<AITask | null>(null);
  const [aiQuestion, setAiQuestion] = useState('');
  const [showMobileAI, setShowMobileAI] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('aiverse-theme');
    return stored === 'dark' || stored === 'light' ? stored : 'system';
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [feedSearch, setFeedSearch] = useState('');
  const [feedSort, setFeedSort] = useState<'popular'|'recent'>('popular');
  const [communityPosts, setCommunityPosts] = useState<Array<{id:string;text:string;created_at:string;username:string;display_name:string}>>([]);
  const [postText, setPostText] = useState('');
  const [postError, setPostError] = useState('');
  const [postSubmitting, setPostSubmitting] = useState(false);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [buckets, setBuckets] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const setPage = (nextPage: RoutePage) => {
    const destination = nextPage === 'settings' && !user ? 'login' : nextPage;
    window.history.pushState({page: destination}, '', pageRoutes[destination]);
    setCurrentPage(destination);
    window.scrollTo({top: 0, behavior: 'auto'});
  };

  useEffect(() => {
    const updatePage = () => setCurrentPage(pageFromLocation());
    window.addEventListener('popstate', updatePage);
    return () => window.removeEventListener('popstate', updatePage);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const updateTheme = (nextTheme: Theme) => {
    setTheme(nextTheme);
    localStorage.setItem('aiverse-theme', nextTheme);
  };
  const cycleTheme = () => updateTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');

  const refresh = useCallback(async () => {
    try {
      const nextHealth = await getJSON<Health>('/api/health');
      setHealth(nextHealth);
      if (!nextHealth.sharedRepositoryApiEnabled) {
        setError('El acceso al repositorio compartido está desactivado en esta instancia pública.');
        return;
      }
      const [nextLog, nextFiles, nextStatus, nextBranches, nextChanges, structures] = await Promise.all([
        getJSON<Commit[]>('/api/repo/log'), getJSON<Entry[]>('/api/repo/tree'), getJSON<Status>('/api/repo/status'),
        getJSON<string[]>('/api/repo/branches'), getJSON<Change[]>('/api/repo/diff'),
        getJSON<{objectBuckets: number[]}>('/api/structures'),
      ]);
      setLog(nextLog); setFiles(nextFiles); setStatus(nextStatus); setBranches(nextBranches);
      setChanges(nextChanges); setBuckets(structures.objectBuckets); setError('');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally { setLoading(false); }
  }, []);

  const loadFeed = useCallback(async () => {
    setFeedLoading(true);
    setFeedError('');
    try { const result = await getJSON<{repositories: typeof feed}>('/api/feed'); setFeed(result.repositories); }
    catch (cause) { setFeedError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setFeedLoading(false); }
  }, []);

  const loadPosts = useCallback(async () => {
    setPostsLoading(true);
    setPostsError('');
    try { const result = await getJSON<{posts: typeof communityPosts}>('/api/feed/posts'); setCommunityPosts(result.posts); }
    catch (cause) { setPostsError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPostsLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    void getJSON('/api/auth/csrf').catch(()=>undefined);
    void getJSON<{user: typeof user}>('/api/auth/me').then(result=>setUser(result.user)).catch(()=>setUser(null)).finally(()=>setAuthChecked(true));
    void loadFeed();
    void loadPosts();
    void getJSON<{enabled:boolean}>('/api/billing/status').then(result=>setBillingEnabled(result.enabled)).catch(()=>setBillingEnabled(false));
  }, [refresh, loadFeed, loadPosts]);

  useEffect(() => {
    if (!api || (!user && !import.meta.env.DEV)) return;
    let socket: WebSocket | undefined;
    let cancelled = false;
    void getJSON<Health>('/api/health').then(result => {
      if (!result.sharedRepositoryApiEnabled || cancelled) return;
      socket = new WebSocket(wsUrl);
      socket.onmessage = event => {
        const message = JSON.parse(event.data as string) as {type?: string; task?: AITask};
        if (message.type === 'ai-task' && message.task) setAiTask(current => current?.id === message.task?.id ? message.task ?? current : current);
        if (message.type === 'filesystem') void refresh();
      };
    }).catch(()=>undefined);
    return () => { cancelled = true; socket?.close(); };
  }, [user, refresh]);

  useEffect(() => {
    if (authChecked && (page === 'settings' || page === 'account') && !user) setPage('login');
  }, [authChecked, page, user]);

  useEffect(() => {
    const metadata: Record<Page, {title: string; description: string}> = {
      home: {title: 'AIVerse — Tu código avanza. Tu equipo entiende por qué.', description: 'Versionamiento claro, colaboración de equipo y asistencia de IA bajo tu control.'},
      feed: {title: 'Explora proyectos | AIVerse', description: 'Descubre repositorios públicos, conoce a sus creadores y encuentra ideas para tu próximo proyecto.'},
      docs: {title: 'Guías de AIVerse | Documentación', description: 'Aprende a crear repositorios, trabajar con commits y revisar cambios con AIVerse.'},
      workspace: {title: 'Espacio de trabajo | AIVerse', description: 'Consulta el historial y los cambios de tu proyecto en AIVerse.'},
      login: {title: 'Iniciar sesión | AIVerse', description: 'Continúa trabajando en tus proyectos con AIVerse.'},
      register: {title: 'Crear cuenta | AIVerse', description: 'Crea tu espacio de desarrollo y empieza a colaborar con AIVerse.'},
      account: {title: 'Mi cuenta | AIVerse', description: 'Consulta la información de tu cuenta de AIVerse.'},
      settings: {title: 'Configuración | AIVerse', description: 'Personaliza tus preferencias de idioma y tema en AIVerse.'},
      prs: {title: 'Pull requests | AIVerse', description: 'Revisa cambios de código y conversa con contexto en AIVerse.'},
      pricing: {title: 'Planes y precios | AIVerse', description: 'Compara los planes de AIVerse y elige el espacio de trabajo que necesitas.'},
      terms: {title: 'Términos de servicio | AIVerse', description: 'Consulta las condiciones de uso del servicio AIVerse.'},
      privacy: {title: 'Política de privacidad | AIVerse', description: 'Conoce qué datos procesa AIVerse y cómo se usan.'},
      legal: {title: 'Aviso legal | AIVerse', description: 'Información sobre el servicio AIVerse y su operador.'},
      cookies: {title: 'Aviso de cookies | AIVerse', description: 'Información sobre las cookies necesarias que utiliza AIVerse.'},
      notFound: {title: 'Página no encontrada | AIVerse', description: 'La página que buscas no está disponible.'},
    };
    const content = metadata[page];
    document.title = content.title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = content.description;
    for (const [selector, value] of [
      ['meta[property="og:title"]', content.title],
      ['meta[property="og:description"]', content.description],
      ['meta[name="twitter:title"]', content.title],
      ['meta[name="twitter:description"]', content.description],
    ] as const) {
      const tag = document.querySelector<HTMLMetaElement>(selector);
      if (tag) tag.content = value;
    }
    const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (robots) robots.content = ['workspace', 'login', 'register', 'account', 'settings', 'notFound'].includes(page) ? 'noindex, nofollow' : 'index, follow';
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    canonical.href = `${window.location.origin}${page === 'notFound' ? '/' : pageRoutes[page]}`;
  }, [page]);

  const selectedChange = useMemo(() => changes.find(change => change.path === selected), [changes, selected]);
  const allPaths = useMemo(() => [...new Set([...files.map(file => file.path), ...changes.map(change => change.path)])].sort(), [files, changes]);
  const filteredFeed = useMemo(() => feed
    .filter(item => `${item.name} ${item.username} ${item.description}`.toLowerCase().includes(feedSearch.trim().toLowerCase()))
    .sort((a,b) => feedSort === 'popular' ? b.stars_count-a.stars_count : new Date(b.created_at ?? 0).getTime()-new Date(a.created_at ?? 0).getTime()), [feed, feedSearch, feedSort]);

  const publishPost = async (event: FormEvent) => {
    event.preventDefault(); setPostError(''); setPostSubmitting(true);
    try {
      const result = await postJSON<{post: typeof communityPosts[number]}>('/api/feed/posts', {text: postText});
      setCommunityPosts(posts => [result.post, ...posts]); setPostText('');
    } catch (cause) { setPostError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPostSubmitting(false); }
  };

  const startCheckout = async (plan: 'starter'|'plus'|'pro') => {
    try { const result = await postJSON<{url:string}>('/api/billing/checkout', {plan}); window.location.assign(result.url); }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
  };

  useEffect(() => {
    if (!selected || selectedChange) { setContent(''); return; }
    void getJSON<{content: string}>('/api/repo/file?path=' + encodeURIComponent(selected))
      .then(result => setContent(result.content)).catch(fetchError => setContent(String(fetchError)));
  }, [selected, selectedChange]);

  useEffect(() => {
    if (!aiTask || aiTask.state === 'ready' || aiTask.state === 'error') return;
    const timer = window.setTimeout(() => {
      void getJSON<AITask>('/api/ai/tasks/' + aiTask.id).then(setAiTask).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [aiTask]);

  const run = async () => {
    const [command, ...args] = terminal.trim().split(/\s+/);
    if (!command) return;
    try {
      let result: unknown;
      if (command === 'status') result = await getJSON('/api/repo/status');
      else if (command === 'log') result = await getJSON('/api/repo/log');
      else if (command === 'add') result = await postJSON('/api/repo/add', {paths: args.length ? args : ['.']});
      else if (command === 'commit') result = await postJSON('/api/repo/commit', {message: args[0] === '-m' ? args.slice(1).join(' ') : args.join(' ')});
      else if (command === 'branch') result = await postJSON('/api/repo/branch', {name: args[0]});
      else if (command === 'checkout') result = await postJSON('/api/repo/checkout', {name: args[0]});
      else if (command === 'merge') result = await postJSON('/api/repo/merge', {name: args[0]});
      else if (command === 'stash') result = await postJSON('/api/repo/stash', {action: args[0] ?? 'push'});
      else throw new Error('Comandos: status, log, add, commit, branch, checkout, merge, stash');
      setOutput(history => [JSON.stringify(result), ...history]);
      await refresh();
    } catch (runError) { setOutput(history => [runError instanceof Error ? runError.message : String(runError), ...history]); }
    setTerminal('');
  };

  const requestAI = async (kind: 'review' | 'commit-msg' | 'ask') => {
    try {
      const diff = changes.map(change => `diff -- ${change.path}\n${change.lines.join('\n')}`).join('\n');
      const context = selected ? `${selected}\n${content}` : diff;
      setAiTask(await postJSON<AITask>('/api/ai/' + kind, {text: kind === 'ask' ? `Pregunta: ${aiQuestion}\n\nContexto de código:\n${context}` : context, diff: context}));
      if (kind === 'ask') setAiQuestion('');
    } catch (aiError) { setError(aiError instanceof Error ? aiError.message : String(aiError)); }
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (authSubmitting) return;
    setFormError('');
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');
    const email = String(data.get('email') ?? '').trim();
    if (page === 'register') {
      const policyOk = password.length >= 12 && password.length <= 128 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9\s]/.test(password);
      if (!policyOk) { setFormError('Completa todos los requisitos de contraseña antes de continuar.'); return; }
      if (data.get('confirmPassword') !== password) { setFormError('Las contraseñas no coinciden.'); return; }
    }
    if (!email) { setFormError('Escribe tu correo electrónico.'); return; }
    setAuthSubmitting(true);
    try {
      const route = page === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body = page === 'register' ? {username:data.get('username'),displayName:data.get('displayName'),email,password,confirmPassword:data.get('confirmPassword')} : {email,password};
      const result = await postJSON<{user: typeof user}>(route,body);
      setUser(result.user);
      setAuthChecked(true);
      setPage('account');
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAuthSubmitting(false); }
  };

  const passwordChecks = [
    {label:'12 caracteres como mínimo', valid:passwordValue.length >= 12},
    {label:'Una letra mayúscula', valid:/[A-Z]/.test(passwordValue)},
    {label:'Una letra minúscula', valid:/[a-z]/.test(passwordValue)},
    {label:'Un número', valid:/[0-9]/.test(passwordValue)},
    {label:'Un símbolo (por ejemplo !, # o ?)', valid:/[^A-Za-z0-9\s]/.test(passwordValue)},
    {label:'Evita palabras fáciles de adivinar', valid:passwordValue.length>0&&!/(password|contraseña)/i.test(passwordValue)},
  ];
  const passwordValid = passwordChecks.every(check => check.valid) && !/password|contraseña/i.test(passwordValue);

  if (page === 'notFound') return <main className={dark?'app marketing-app dark':'app marketing-app'}><SiteHeader page={page} user={user} navigate={setPage}/><section className="not-found-page"><p className="eyebrow">ERROR 404 · RUTA NO DISPONIBLE</p><span className="not-found-code" aria-hidden="true">404</span><h1>No encontramos esta página.</h1><p>Puede que el enlace haya cambiado o que la dirección esté escrita de forma incorrecta.</p><button className="action" onClick={()=>setPage('home')}>Volver al inicio <span>→</span></button></section><SiteFooter navigate={setPage}/></main>;

  if (page === 'feed') return <main className={dark?'app marketing-app dark':'app marketing-app'}>
    <SiteHeader page={page} user={user} navigate={setPage}/>
    <section className="explore-hero"><p className="eyebrow">COMUNIDAD AIVERSE</p><h1>Explora proyectos<br/><span>hechos por desarrolladores.</span></h1><p>Busca repositorios públicos, conoce quién los crea y encuentra ideas para tu próximo proyecto.</p><div className="explore-search"><span>⌕</span><input value={feedSearch} onChange={event=>setFeedSearch(event.target.value)} placeholder="Buscar proyectos, personas o tecnologías" aria-label="Buscar repositorios"/><button onClick={()=>setFeedSearch('')} disabled={!feedSearch}>Limpiar</button></div><div className="explore-metrics" aria-live="polite"><span><b>{feedLoading?'…':feed.length}</b> repositorios públicos</span><span><b>{feedLoading?'…':new Set(feed.map(item=>item.username)).size}</b> desarrolladores</span><span>Actualizado desde la comunidad</span></div></section>
    <section className="explore-content"><div className="community-layout"><div><div className="community-composer"><p className="eyebrow">COMPARTE CON LA COMUNIDAD</p><h2>¿En qué estás trabajando?</h2>{user?<form onSubmit={event=>void publishPost(event)}><textarea maxLength={1200} value={postText} onChange={event=>setPostText(event.target.value)} placeholder="Comparte un avance, una pregunta o algo que aprendiste…"/><div><small>{postText.length}/1200</small><button className="action" disabled={postSubmitting||!postText.trim()}>{postSubmitting?'Publicando…':'Publicar'}</button></div>{postError&&<p className="form-error" role="alert">{postError}</p>}</form>:<><p>Inicia sesión para compartir avances, pedir ayuda y conversar sobre código.</p><button className="action" onClick={()=>setPage('login')}>Iniciar sesión para publicar</button></>}</div><div className="community-posts"><p className="eyebrow">CONVERSACIÓN RECIENTE</p>{postsLoading?<div className="feed-skeleton" role="status" aria-label="Cargando conversaciones"><i/><i/><i/></div>:postsError?<div className="feed-error" role="alert"><p>No se pudieron cargar las conversaciones: {postsError}</p><button onClick={()=>void loadPosts()}>Reintentar</button></div>:communityPosts.length?communityPosts.map(post=><article className="community-post" key={post.id}><div className="post-avatar">{post.display_name?.[0]?.toUpperCase()||'A'}</div><div><strong>{post.display_name||post.username}</strong><small>@{post.username} · {new Date(post.created_at).toLocaleString('es-CO')}</small><p>{post.text}</p></div></article>):<div className="explore-empty"><h3>Inicia la conversación</h3><p>Comparte tu primer avance o una pregunta técnica para activar la comunidad.</p></div>}</div></div><div><div className="explore-heading"><div><p className="eyebrow">DIRECTORIO</p><h2>Proyectos para explorar</h2><p>Repositorios públicos de la comunidad.</p></div><label className="sort-select">Orden<select value={feedSort} onChange={event=>setFeedSort(event.target.value as 'popular'|'recent')}><option value="popular">Populares</option><option value="recent">Recientes</option></select></label></div>
      <div className="explore-tags"><span>Prueba una búsqueda:</span>{['api','web','ia','typescript','open source'].map(term=><button key={term} onClick={()=>setFeedSearch(term)}>{term}</button>)}</div>
      {feedLoading?<div className="explore-loading" role="status"><span className="loading-spinner" aria-hidden="true"/><p>Cargando proyectos de la comunidad…</p><div className="feed-skeleton"><i/><i/><i/></div></div>:feedError?<div className="feed-error" role="alert"><p>No se pudieron cargar los proyectos: {feedError}</p><button onClick={()=>void loadFeed()}>Reintentar</button></div>:filteredFeed.length>0?<div className="repo-grid explore-repos">{filteredFeed.map(item=><article className="repo-card explore-repo" key={item.id}><div className="explore-repo-title"><span className="repo-mark">◈</span><div><small>{item.username}</small><b>{item.username}/{item.name}</b></div><span className="repo-public">Público</span></div><p>{item.description||'Repositorio compartido con la comunidad AIVerse.'}</p><div className="repo-meta"><span>☆ {item.stars_count} estrellas</span><span>{item.created_at?new Date(item.created_at).toLocaleDateString('es-CO'):'Proyecto AIVerse'}</span></div></article>)}</div>
      :<div className="explore-empty"><span>⌕</span><h3>{feed.length?'No hay resultados para esta búsqueda':'La comunidad está comenzando'}</h3><p>{feed.length?'Prueba con otro nombre o tecnología.':'Cuando los desarrolladores publiquen repositorios, aparecerán aquí para que puedas explorarlos.'}</p>{feedSearch?<button className="secondary action" onClick={()=>setFeedSearch('')}>Borrar búsqueda</button>:<button className="action" onClick={()=>setPage(user?'workspace':'register')}>Crear el primer proyecto</button>}</div>}
    </div></div></section><section className="explore-invite"><div><p className="eyebrow">¿TRABAJAS EN ALGO INTERESANTE?</p><h2>Comparte tu proyecto con la comunidad.</h2><p>Publica tu repositorio y ayuda a otros a descubrirlo, aprender y colaborar.</p></div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>Empieza a construir <span>→</span></button></section>
    <SiteFooter navigate={setPage}/>
  </main>;

  if (page === 'login' || page === 'register') return <main className={dark?'auth-page dark':'auth-page'}>
    <div className="auth-aside"><button className="wordmark" onClick={()=>setPage('home')}><AIVerseMark/><span>A<span className="wordmark-i">I</span>Verse</span></button><div><p className="eyebrow">EL CÓDIGO SE ENTIENDE EN EQUIPO</p><h2>Tu código avanza. Tu equipo entiende por qué.</h2><p>Versionamiento colaborativo con IA bajo tu control.</p></div><span>Entiende cada cambio · Decide qué integrar</span></div>
    <section className="auth-card"><button className="auth-back" onClick={()=>setPage('home')}>← Volver al inicio</button><p className="eyebrow">{page==='login'?'QUÉ BUENO VERTE':'EMPIEZA GRATIS'}</p><h1>{page==='login'?'Bienvenido de vuelta':'Crea tu cuenta'}</h1><p className="auth-intro">{page==='login'?'Continúa donde dejaste tu trabajo.':'Tu próximo proyecto empieza con un buen historial.'}</p>
      <form onSubmit={event=>void submitAuth(event)} noValidate={false}>
        {page==='register'&&<><label>Nombre de usuario<input name="username" placeholder="tu-usuario" required minLength={1} maxLength={39} autoComplete="username" pattern="[A-Za-z0-9][A-Za-z0-9-]{0,37}[A-Za-z0-9]?"/><small>Usa letras, números y guiones.</small></label><label>Nombre visible<input name="displayName" placeholder="¿Cómo te llamas?" required maxLength={80} autoComplete="name"/></label></>}
        <label>Correo electrónico<input name="email" type="email" inputMode="email" placeholder="nombre@ejemplo.com" required maxLength={254} autoComplete="email"/></label>
        <label>Contraseña<div className="password-field"><input name="password" type={showPassword?'text':'password'} placeholder={page==='register'?'Crea una contraseña segura':'Tu contraseña'} required minLength={page==='register'?12:1} maxLength={page==='register'?128:256} autoComplete={page==='register'?'new-password':'current-password'} value={page==='register'?passwordValue:undefined} onChange={event=>{if(page==='register')setPasswordValue(event.target.value)}}/><button type="button" className="password-toggle" onClick={()=>setShowPassword(!showPassword)} aria-label={showPassword?'Ocultar contraseña':'Mostrar contraseña'}>{showPassword?'Ocultar':'Mostrar'}</button></div></label>
        {page==='register'&&<><ul className="password-checks" aria-label="Requisitos de contraseña">{passwordChecks.map(check=><li key={check.label} className={check.valid?'passed':''}><span aria-hidden="true">{check.valid?'✓':'○'}</span>{check.label}</li>)}</ul><label>Confirma tu contraseña<input name="confirmPassword" type={showPassword?'text':'password'} placeholder="Escríbela otra vez" required minLength={12} maxLength={128} autoComplete="new-password"/></label><p className="password-match" aria-live="polite">{passwordValue&&passwordValid?'Contraseña segura. Confírmala para continuar.':'Usaremos esta contraseña para proteger tu cuenta.'}</p></>}
        {formError&&<p className="form-error" role="alert">{formError}</p>}
        <button className="action auth-submit" disabled={authSubmitting || (page==='register'&&!passwordValid)}>{authSubmitting?'Conectando…':page==='login'?'Iniciar sesión':'Crear cuenta gratis'}{!authSubmitting&&<span>→</span>}</button>
      </form>
      <p className="auth-switch">{page==='login'?'¿Primera vez en AIVerse?':'¿Ya tienes una cuenta?'} <button className="inline-button" onClick={()=>{setFormError('');setPasswordValue('');setPage(page==='login'?'register':'login')}}>{page==='login'?'Crea tu cuenta':'Inicia sesión'}</button></p><p className="auth-legal">Al continuar, aceptas nuestros <button onClick={()=>setPage('terms')}>términos de servicio</button> y <button onClick={()=>setPage('privacy')}>política de privacidad</button>.</p>
    </section></main>;

  if (page === 'home' || page === 'account' || page === 'settings' || page === 'prs' || page === 'docs' || page === 'pricing' || page === 'terms' || page === 'privacy' || page === 'legal' || page === 'cookies') return <main className={dark?'app marketing-app dark':'app marketing-app'}><SiteHeader page={page} user={user} navigate={setPage}/>
    {page==='settings'?<section className="product-page settings-page"><p className="eyebrow">TU ESPACIO</p><h1>Configuración</h1><p>Personaliza AIVerse para que se adapte a ti.</p><div className="settings-card"><label>Idioma de la interfaz<select onChange={event=>localStorage.setItem('aiverse-language',event.target.value)} defaultValue={localStorage.getItem('aiverse-language')??'es'}>{[['es','Español'],['en','English'],['fr','Français'],['de','Deutsch'],['pt','Português'],['ja','日本語']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Tema<select value={theme} onChange={event=>updateTheme(event.target.value as Theme)}><option value="system">Automático · seguir el sistema</option><option value="light">Claro</option><option value="dark">Oscuro</option></select></label><p className="system-theme-note">Tu sistema está en modo <b>{systemDark?'oscuro':'claro'}</b>. {theme==='system'?'AIVerse seguirá ese ajuste automáticamente.':'El tema elegido se mantiene aunque cambie el sistema.'}</p></div><button className="secondary action" onClick={()=>setPage('account')}>Volver a mi cuenta</button></section>
    :page==='account'?<section className="product-page account-panel"><p className="eyebrow">PERFIL DE DESARROLLADOR</p><div className="account-heading"><span className="avatar">{user?.display_name?.[0]?.toUpperCase()??'A'}</span><div><h1>{user?.display_name??'Tu cuenta'}</h1><p>@{user?.username} · {user?.email}</p></div></div><div className="account-plan"><div><b>Plan Free</b><p>Hasta 3 repositorios · revisión con IA con tu propia clave</p></div><button className="action" onClick={()=>setPage('pricing')}>Ver planes</button></div><button className="secondary action" onClick={()=>setPage('settings')}>Editar preferencias</button></section>
    :page==='docs'?<DocumentationPage navigate={setPage}/>
    :page==='prs'?<section className="product-page"><p className="eyebrow">COLABORACIÓN</p><h1>Pull requests</h1><p>Reúne el contexto, revisa cada cambio y conversa antes de integrarlo.</p><div className="feature-row"><article><b>Revisión con contexto</b><p>Compara ramas y conversa sobre líneas específicas.</p></article><article><b>Decisiones claras</b><p>Aprueba, comenta o solicita cambios con tu equipo.</p></article><article><b>Ayuda de IA</b><p>Usa Gemini para señalar riesgos y oportunidades en el diff.</p></article></div><button className="action" onClick={()=>setPage(user?'workspace':'register')}>Empieza a colaborar</button></section>
    :page==='terms'||page==='privacy'||page==='legal'||page==='cookies'?<><LegalPage kind={page}/><SiteFooter navigate={setPage}/></>
    :page==='pricing'?<PricingPage user={user} billingEnabled={billingEnabled} navigate={setPage} startCheckout={startCheckout}/>
    :<>{feedError&&<div className="feed-error home-feed-error" role="alert"><p>No se pudieron cargar los proyectos de la comunidad: {feedError}</p><button onClick={()=>void loadFeed()}>Reintentar</button></div>}<Homepage feed={feed} feedLoading={feedLoading} feedError={feedError} user={user} navigate={setPage}/><SiteFooter navigate={setPage}/></>}</main>;

  return <main className={dark ? 'app dark' : 'app'}>
    <header>
      <div className="brand"><span className="logo"><AIVerseMark/></span><div><b>AIVerse</b><small>Tu espacio de desarrollo</small></div></div>
      <div className="header-right"><span className={error ? 'connection offline' : 'connection'}>● {error ? 'Sin conexión' : 'Backend conectado'}</span><span className="branch">⌘ {status.branch}</span>{user&&<button className="workspace-nav" onClick={()=>setPage('settings')}>Configuración</button>}<button className="theme-cycle" onClick={cycleTheme} aria-label={`Tema ${theme==='system'?'automático':theme}; cambiar tema`}>{theme==='system'?'◐':dark?'☀':'☾'}<small>{theme==='system'?'Sistema':dark?'Oscuro':'Claro'}</small></button>{user&&<button className="workspace-account" onClick={()=>setPage('account')}>@{user.username}</button>}</div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{health?.sharedRepositoryApiEnabled === false ? error : `No se pudo conectar con AIVerse: ${error}`}</span><button onClick={()=>{setLoading(true);void refresh()}}>Reintentar</button></div>}
    {loading && <div className="workspace-loading" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true"/><span>Conectando con tu espacio de trabajo…</span><div className="loading-track"><i/></div></div>}
    <section className="workspace">
      <aside className="sidebar">
        <div className="workspace-side-nav" aria-label="Navegación del espacio">
          <button className="selected" onClick={()=>setPage('workspace')}><span>⌂</span> Resumen</button>
          <button onClick={()=>setPage('feed')}><span>◉</span> Comunidad</button>
          <button onClick={()=>setPage('docs')}><span>▤</span> Guías y recursos</button>
          <button onClick={()=>setPage('prs')}><span>⑂</span> Pull requests</button>
        </div>
        <div className="workspace-sidebar-rule"/>
        <div className="side-title">EXPLORADOR <span>{allPaths.length}</span></div>
        {allPaths.map(file => { const change = changes.find(item => item.path === file); return <button className={selected === file ? 'file active' : 'file'} key={file} onClick={() => setSelected(file)}><span className={`dot ${change?.status ?? 'clean'}`}/>{file}</button>; })}
        {!allPaths.length && <p className="muted">{loading ? 'Cargando…' : 'Añade archivos para comenzar'}</p>}
        <div className="side-title branch-heading">RAMAS <span>{branches.length}</span></div>
        {branches.map(branch => <div className={branch === status.branch ? 'file current' : 'file'} key={branch}>◉ {branch}</div>)}
      </aside>
      <section className="center">
        <div className="workspace-overview">
          <div className="workspace-greeting">
            <div><p className="workspace-kicker">TU ESPACIO DE TRABAJO</p><h1>Tu proyecto</h1><p>Todo lo que necesitas para entender y hacer avanzar tu código.</p></div>
            <div className="workspace-quick-actions"><button className="mobile-ai-toggle" onClick={()=>setShowMobileAI(true)}>Abrir copiloto <span>✦</span></button><button onClick={()=>setPage('feed')}>Explorar comunidad <span>↗</span></button><button className="quick-primary" onClick={()=>setPage('docs')}>Abrir guías <span>→</span></button></div>
          </div>
          <div className="workspace-metrics">
            <article><span className="metric-icon violet">⌘</span><div><b>{log.length}</b><small>Commits</small></div></article>
            <article><span className="metric-icon amber">✎</span><div><b>{changes.length}</b><small>Cambios pendientes</small></div></article>
            <article><span className="metric-icon green">▤</span><div><b>{files.length}</b><small>Archivos versionados</small></div></article>
            <article className="workspace-branch-card"><span>RAMA ACTUAL</span><b>⑂ {status.branch}</b><small>{error ? 'Sincronización pausada' : 'Repositorio conectado'}</small></article>
          </div>
          <div className="workspace-section-label"><div><span className="section-spark">✦</span><b>Actividad del proyecto</b><small> Sigue el contexto de cada cambio</small></div><span className="activity-count">{log.length} en el historial</span></div>
        </div>
        <div className="graph">
          <div className="panel-head"><span>Historial de commits</span><small>Rama {status.branch}</small></div>
          {log.length ? <div className="commit-timeline">{log.slice(0, 5).map((item,index)=><article className={index===0?'commit-item latest':'commit-item'} key={item.hash}><span className="commit-node"/><div><div className="commit-item-title"><b>{item.commit.message}</b>{index===0&&<span>Más reciente</span>}</div><p><code>{item.hash.slice(0,8)}</code><i/>{new Date(item.commit.date).toLocaleString('es-CO')}</p></div></article>)}</div> : loading ? <div className="timeline-loading" aria-hidden="true"><i/><i/><i/></div> : <div className="timeline-empty"><span>✦</span><div><b>Tu historia empieza aquí</b><p>Guarda el primer cambio desde la terminal para crear un historial que tu equipo pueda entender.</p></div></div>}
        </div>
        <div className="editor">
          <div className="panel-head"><span>{selected || 'Cambios del árbol de trabajo'}</span><small>{selectedChange ? selectedChange.status : 'contenido confirmado'}</small></div>
          {selectedChange ? <div className="diff-grid"><DiffColumn title="ANTES" text={selectedChange.oldText}/><DiffColumn title="DESPUÉS" text={selectedChange.newText}/></div> : <pre>{selected ? content : 'Selecciona un archivo para inspeccionarlo.'}</pre>}
        </div>
      </section>
      <aside className={showMobileAI ? 'right mobile-ai-open' : 'right'}>
        <button className="mobile-ai-close" onClick={()=>setShowMobileAI(false)}>Cerrar copiloto <span>×</span></button>
        <div className="ai-panel-heading"><span className="ai-spark">✦</span><div><b>Tu copiloto</b><small>IA conectada a este proyecto</small></div><span className="online">●</span></div>
        <div className="ai-welcome"><span>✧</span><b>¿Qué quieres descubrir?</b><p>Pregunta sobre tus cambios o pide una revisión. La IA utiliza el contexto real del repositorio.</p></div>
        <div className="ai-action-label">ACCIONES RÁPIDAS</div>
        <button className="action" onClick={() => void requestAI('review')} disabled={!changes.length}>Revisar {changes.length} cambio{changes.length === 1 ? '' : 's'}</button>
        <button className="action secondary" onClick={() => void requestAI('commit-msg')} disabled={!changes.length}>✦　Sugerir mensaje de commit</button>
        <div className="ai-suggestions" aria-label="Preguntas sugeridas">
          <button onClick={()=>setAiQuestion('Explícame qué hace este proyecto y cómo se conectan sus partes.')}>Entender el proyecto</button>
          <button onClick={()=>setAiQuestion('¿Qué casos límite o riesgos debería revisar en estos cambios?')}>Buscar riesgos</button>
          <button onClick={()=>setAiQuestion('¿Cuál sería un buen siguiente paso para mejorar este código?')}>Elegir siguiente paso</button>
        </div>
        <label className="ai-ask-label">PREGÚNTALE A AIVERSE<textarea value={aiQuestion} onChange={event=>setAiQuestion(event.target.value)} onKeyDown={event=>event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&void requestAI('ask')} maxLength={1000} placeholder="Explícame este cambio, busca casos límite…"/><small className="ai-input-hint">⌘/Ctrl + Enter para enviar · {aiQuestion.length}/1000</small></label>
        <button className="action ai-submit" onClick={() => void requestAI('ask')} disabled={!aiQuestion.trim()}>Enviar pregunta <span>↑</span></button>
        <div className={`task-state ${aiTask?.state ?? ''}`}>{aiTask ? `${aiTask.state} · intento ${aiTask.attempts}` : 'Las respuestas aparecerán aquí'}</div>
        {aiTask&&<pre className="ai-result">{aiTask.result ?? aiTask.error ?? 'Preparando respuesta…'}</pre>}
        <div className="ai-provider-note"><span>✧</span> Modelo: {health?.provider ?? 'AIVerse'}</div>
        <div className="inspector"><div className="panel-head">Inspector de estructuras de datos</div><small>Tabla hash · índice del repositorio</small><div className="buckets">{buckets.slice(0, 32).map((count, index) => <div key={index} title={`Espacio ${index}: ${count}`} style={{height: Math.max(4, count * 12)}}/>)}</div><small>{buckets.length} espacios · {files.length} archivos versionados</small></div>
        <div className="panel-head state-heading">Estado</div><div className="stats"><span>{status.staged.length}<small>preparados</small></span><span>{status.modified.length}<small>modificados</small></span><span>{status.untracked.length}<small>nuevos</small></span></div>
      </aside>
    </section>
    <section className="terminal"><div className="terminal-head"><span><i/> TERMINAL</span><small>Tu flujo, desde la terminal</small><button onClick={()=>setPage('docs')}>Ver comandos disponibles ↗</button></div><div className="terminal-body"><div className="terminal-history">{output.slice(0, 5).map((line, index) => <div key={index}>{line}</div>)}</div><div className="prompt"><b>aiverse ❯</b><input value={terminal} onChange={event => setTerminal(event.target.value)} onKeyDown={event => event.key === 'Enter' && void run()} placeholder="status, add ., commit -m mensaje"/><button onClick={() => void run()}>↵</button></div></div></section>
    <footer className="workspace-footer"><span><AIVerseMark/> AIVerse <i/> {changes.length} cambios · rama {status.branch}</span><div><button onClick={()=>setPage('home')}>Inicio</button><button onClick={()=>setPage('feed')}>Comunidad</button><button onClick={()=>setPage('docs')}>Guías</button><button onClick={()=>setPage('terms')}>Términos</button><button onClick={()=>setPage('privacy')}>Privacidad</button></div><span>● {error ? 'Sin conexión' : 'Todo actualizado'}</span></footer>
  </main>;
}

function Homepage({feed,feedLoading,feedError,user,navigate}: {feed: Array<{id:string;name:string;description:string;stars_count:number;username:string}>;feedLoading:boolean;feedError:string;user:{username:string}|null;navigate:(page:RoutePage)=>void}) {
  return <>
    <section className="home-hero"><div className="home-hero-inner">
      <div className="home-hero-copy"><p className="eyebrow">AIVERSE · VERSIONAMIENTO CON CONTEXTO</p><h1>Cada cambio,<br/><span>explicado.</span></h1><p className="home-hero-lead">Revisa el código con tu equipo, entiende las sugerencias de IA y decide qué integrar. El criterio sigue siendo tuyo.</p><div className="home-hero-actions"><button className="action hero-primary" onClick={()=>navigate(user?'workspace':'register')}>Crear mi espacio <span>→</span></button><button className="home-text-link" onClick={()=>navigate('feed')}>Explorar proyectos <span>→</span></button></div><div className="home-proof"><span>✓ Gratis para comenzar</span><i/><span>✓ Sin tarjeta</span><i/><span>✓ IA bajo tu control</span></div></div>
      <div className="home-demo" aria-label="Ejemplo de revisión de código"><div className="home-demo-top"><div><span className="demo-dot"/><b>Revisión de cambio</b></div><span className="demo-status">DECISIÓN PENDIENTE</span></div><div className="home-demo-branch"><span>⑂</span> feature/session-refresh <small>· hace 8 min</small></div><div className="home-diff"><div className="demo-file"><span>src/auth/session.ts</span><span>+2 −1</span></div><div className="diff-line removed"><code>−</code><span>return refresh(token);</span></div><div className="diff-line added"><code>+</code><span>if (isExpired(token)) {'{'} return null; {'}'}</span></div><div className="diff-line added"><code>+</code><span>return refresh(token);</span></div></div><div className="home-ai-note"><span className="note-icon">✦</span><div><b>Explicación de AIVerse</b><p>La comprobación evita renovar una sesión que ya expiró. Revisa cómo se maneja ese caso en las pruebas.</p></div></div><div className="home-demo-decision"><span><i/> Tú decides el siguiente paso</span><button onClick={()=>navigate(user?'workspace':'register')}>Revisar cambios →</button></div></div>
    </div></section>
    <section className="home-process"><div className="home-section-intro"><p className="eyebrow">ASÍ TRABAJAS EN AIVERSE</p><h2>Del diff a una decisión<br/>que puedes explicar.</h2><p>Menos vueltas para entender un cambio. Más contexto para hablar de lo que realmente importa.</p></div><div className="home-process-grid"><article><span>01 / OBSERVA</span><h3>Todo cambio tiene historia.</h3><p>Ramas, commits y diferencias reunidos en una vista. Encuentra qué cambió y sigue el hilo hasta el motivo.</p><b>Historial claro <i>→</i></b></article><article><span>02 / COMPRENDE</span><h3>La IA explica. No decide.</h3><p>Pide una revisión, busca casos límite o pregunta por el código. Cada sugerencia llega con contexto.</p><b>Revisión con contexto <i>→</i></b></article><article><span>03 / COLABORA</span><h3>El equipo conserva el control.</h3><p>Comparte el proyecto, conversa sobre los cambios y elige qué integrar. La decisión siempre es tuya.</p><b>Colaboración transparente <i>→</i></b></article></div></section>
    {feedLoading||feed.length>=3?<section className="home-community"><div className="home-community-copy"><p className="eyebrow">PROYECTOS DE LA COMUNIDAD</p><h2>Ideas reales.<br/>Código para explorar.</h2><p>Descubre qué están construyendo otros desarrolladores, aprende de sus decisiones y comparte tu propio trabajo.</p><button className="home-text-link" onClick={()=>navigate('feed')}>Explorar la comunidad <span>→</span></button></div><div className="home-project-rail" aria-busy={feedLoading} id="home-project-rail">{feedLoading?<div className="home-feed-skeleton" role="status" aria-label="Cargando proyectos"><i/><i/><i/></div>:feed.slice(0,5).map((item,index)=><article className="home-project-card" key={item.id}><div className="project-card-top"><span>0{index+1}</span><small>PROYECTO COMUNITARIO</small></div><b>{item.username}/{item.name}</b><p>{item.description||'Explora el código y conoce cómo se construyó este proyecto.'}</p><div className="project-card-foot"><span>☆ {item.stars_count}</span><button onClick={()=>navigate('feed')}>Ver proyecto →</button></div></article>)}</div>{feed.length>2&&<div className="rail-controls"><span>Explora más proyectos</span><button aria-label="Proyectos anteriores" onClick={()=>document.getElementById('home-project-rail')?.scrollBy({left:-280,behavior:'smooth'})}>←</button><button aria-label="Más proyectos" onClick={()=>document.getElementById('home-project-rail')?.scrollBy({left:280,behavior:'smooth'})}>→</button></div>}</section>:feedError?null:<section className="home-community-empty"><div><p className="eyebrow">COMUNIDAD AIVERSE</p><h2>Tu proyecto también<br/>merece un lugar.</h2><p>Comparte lo que estás construyendo y ayuda a que más desarrolladores descubran proyectos de la comunidad.</p></div><button className="action" onClick={()=>navigate(user?'workspace':'register')}>Crear mi espacio <span>→</span></button></section>}
    <section className="home-learning"><div><p className="eyebrow">APRENDE MIENTRAS CONSTRUYES</p><h2>Una guía clara para cada paso.</h2><p>Desde tu primer commit hasta una revisión colaborativa: consulta ejemplos, comandos y respuestas cuando los necesites.</p></div><button onClick={()=>navigate('docs')}>Ir a la documentación <span>→</span></button></section>
    <section className="home-plans"><div><p className="eyebrow">EMPIEZA A TU RITMO</p><h2>Prueba el flujo.<br/><span>Crece cuando te sirva.</span></h2><p>Explora gratis y pasa a un plan con más espacio cuando tus proyectos lo pidan.</p></div><div className="home-plan-preview"><span>PARA PROBAR AIVERSE</span><strong>Starter <small>· mensual</small></strong><b>COP 3.300</b><p>Más repositorios, privacidad y revisiones con IA.</p><button onClick={()=>navigate('pricing')}>Comparar planes →</button></div></section>
    <section className="home-final-cta"><p className="eyebrow">TU PRÓXIMO CAMBIO PUEDE EMPEZAR AQUÍ</p><h2>Construye con claridad.<br/><span>Decide en equipo.</span></h2><button className="action" onClick={()=>navigate(user?'workspace':'register')}>Crear mi espacio <span>→</span></button><small>Gratis para comenzar · Tus decisiones siguen siendo tuyas</small></section>
  </>;
}

function DiffColumn({title, text}: {title: string; text: string}) {
  return <section className="diff-column"><div>{title}</div><pre>{text || '∅'}</pre></section>;
}

function PricingPage({user,billingEnabled,navigate,startCheckout}: {user:{username:string}|null;billingEnabled:boolean;navigate:(page:RoutePage)=>void;startCheckout:(plan:'starter'|'plus'|'pro')=>Promise<void>}) {
  const choosePlan = (plan:'starter'|'plus'|'pro') => user ? void startCheckout(plan) : navigate('login');
  return <>
    <section className="pricing-hero"><p className="eyebrow">PRECIOS CLAROS, EN PESOS COLOMBIANOS</p><h1>Elige cómo quieres<br/><span>hacer crecer tus proyectos.</span></h1><p>Compara el espacio que necesitas. Empieza gratis y cambia de plan cuando te convenga.</p><div className="billing-note">{billingEnabled?'Pagos mensuales procesados de forma segura con Mercado Pago.':'El plan Free está disponible. Los pagos de planes superiores estarán disponibles próximamente.'}</div></section>
    <section className="pricing-section"><div className="pricing-grid">
      <PlanCard name="Free" price="COP 0" cadence="Por cuenta · para siempre" description="Para conocer AIVerse y publicar tus primeros proyectos." features={['Hasta 3 repositorios','Repositorios públicos','Historial, ramas y diffs','Feed y perfil de desarrollador']} action="Crear cuenta gratis" onClick={()=>navigate(user?'account':'register')}/>
      <PlanCard name="Starter" price="COP 3.300" cadence="Por cuenta · al mes" description="Más espacio y repositorios privados para tu trabajo diario." features={['Hasta 10 repositorios','Repositorios públicos y privados','Todo lo incluido en Free']} action="Elegir Starter" highlighted disabled={!billingEnabled} onClick={()=>choosePlan('starter')}/>
      <PlanCard name="Plus" price="COP 26.500" cadence="Por cuenta · al mes" description="Más capacidad para mantener varios proyectos activos." features={['Hasta 20 repositorios','Repositorios públicos y privados','Todo lo incluido en Starter']} action="Elegir Plus" disabled={!billingEnabled} onClick={()=>choosePlan('plus')}/>
      <PlanCard name="Pro" price="COP 59.600" cadence="Por cuenta · al mes" description="Para quienes mantienen muchos proyectos en AIVerse." features={['Repositorios ilimitados','Repositorios públicos y privados','Todo lo incluido en Plus']} action="Elegir Pro" disabled={!billingEnabled} onClick={()=>choosePlan('pro')}/>
    </div><p className="pricing-footnote">Los límites se refieren al número de repositorios por cuenta. Las funciones de IA dependen de que el servicio esté habilitado.</p></section>
    <section className="pricing-faq"><p className="eyebrow">ANTES DE ELEGIR</p><h2>Preguntas frecuentes</h2><div><article><h3>¿Cómo se procesan los pagos?</h3><p>Los planes de pago se cobran en COP mediante Mercado Pago. El checkout se abrirá cuando esté habilitado.</p></article><article><h3>¿Necesito una cuenta?</h3><p>Sí. Puedes elegir un plan y luego iniciar sesión o crear tu cuenta para continuar.</p></article><article><h3>¿La IA está incluida?</h3><p>La disponibilidad depende de la configuración del servicio. Puedes usar las funciones de IA cuando estén habilitadas en AIVerse.</p></article></div></section>
  </>;
}

function PlanCard({name, price, cadence, description, features, action, highlighted = false, disabled = false, onClick}: {
  name: string; price: string; cadence: string; description: string; features: string[]; action: string; highlighted?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <article className={highlighted ? 'plan-card featured-plan' : 'plan-card'}>{highlighted&&<span className="plan-badge">RECOMENDADO</span>}<p className="plan-name">{name}</p><div className="plan-price">{price}</div><p className="plan-cadence">{cadence}</p><p className="plan-description">{description}</p><button className={highlighted?'action':'secondary action'} onClick={onClick} disabled={disabled}>{disabled&&name!=='Free'?'Próximamente':action}{!disabled&&<span>→</span>}</button><div className="plan-divider"/><p className="included-label">INCLUYE</p><ul>{features.map(feature=><li key={feature}><span>✓</span>{feature}</li>)}</ul></article>;
}

function AIVerseMark() {
  return <svg className="aiverse-mark" viewBox="0 0 40 40" aria-hidden="true"><path d="M7 32 20 19 33 32M20 19V7"/><circle cx="7" cy="32" r="2.5"/><circle cx="33" cy="32" r="2.5"/><circle className="mark-core" cx="20" cy="19" r="3"/><circle cx="20" cy="7" r="2.5"/></svg>;
}

function SiteHeader({page, user, navigate}: {page: Page; user: {username:string}|null; navigate: (page: RoutePage)=>void}) {
  return <header className="site-header"><button className="wordmark" onClick={()=>navigate('home')}><AIVerseMark/><span>A<span className="wordmark-i">I</span>Verse</span></button><nav aria-label="Navegación principal"><button className={page==='home'?'active':''} onClick={()=>navigate('home')}>Inicio</button><button className={page==='feed'?'active':''} onClick={()=>navigate('feed')}>Comunidad</button><button className={page==='docs'?'active':''} onClick={()=>navigate('docs')}>Guías</button><button className={page==='pricing'?'active':''} onClick={()=>navigate('pricing')}>Planes</button></nav><div className="site-header-actions">{user?<button className="account-link" onClick={()=>navigate('account')}>@{user.username}</button>:<button className="site-login" onClick={()=>navigate('login')}>Iniciar sesión</button>}<button className="action site-cta" onClick={()=>navigate(user?'workspace':'register')}>{user?'Abrir espacio':'Crear mi espacio'} <span>→</span></button></div></header>;
}

function SiteFooter({navigate}: {navigate: (page: RoutePage)=>void}) {
  return <footer className="site-footer"><div className="footer-main"><div className="footer-brand"><button className="wordmark" onClick={()=>navigate('home')}><AIVerseMark/><span>A<span className="wordmark-i">I</span>Verse</span></button><p>Versionamiento colaborativo con IA bajo tu control.</p></div><div className="footer-links"><div><b>Comunidad</b><button onClick={()=>navigate('feed')}>Feed</button><button onClick={()=>navigate('docs')}>Documentación</button></div><div><b>Cuenta</b><button onClick={()=>navigate('login')}>Iniciar sesión</button><button onClick={()=>navigate('register')}>Crear mi espacio</button><button onClick={()=>navigate('pricing')}>Planes</button></div><div><b>Información</b><button onClick={()=>navigate('legal')}>Aviso legal</button><button onClick={()=>navigate('terms')}>Términos de servicio</button><button onClick={()=>navigate('privacy')}>Política de privacidad</button><button onClick={()=>navigate('cookies')}>Aviso de cookies</button></div></div></div><div className="footer-bottom"><span>© 2026 AIVerse · Beta</span><span>Entiende cada cambio. Construye con confianza.</span></div></footer>;
}

function DocumentationPage({navigate}: {navigate: (page: RoutePage)=>void}) {
  return <article className="docs-page"><aside className="docs-index"><p className="eyebrow">CENTRO DE APRENDIZAJE</p><a href="#quickstart">Primeros pasos</a><a href="#repositories">Repositorios</a><a href="#terminal-guide">Terminal</a><a href="#ai-guide">Asistente IA</a><a href="#reviews">Revisión colaborativa</a><a href="#privacy-guide">Privacidad y seguridad</a><a href="#troubleshooting">Solución de problemas</a></aside><div className="docs-content"><p className="eyebrow">DOCUMENTACIÓN AIVERSE</p><h1>Aprende construyendo.</h1><p className="docs-lead">Guías prácticas para llevar una idea desde el primer repositorio hasta una revisión lista para integrar. Puedes usar la interfaz web, la terminal o combinar ambas.</p><div className="docs-callout"><b>Empieza aquí</b><p>Crea tu cuenta, abre tu espacio de trabajo y crea un repositorio. En pocos minutos podrás guardar cambios y pedirle a la IA que te explique el diff.</p><button className="action" onClick={()=>navigate('workspace')}>Abrir mi espacio →</button></div>
    <section id="quickstart"><h2>1. Primeros pasos</h2><p>AIVerse organiza tu trabajo como repositorios. Cada repositorio contiene archivos, ramas y un historial de commits. El panel lateral muestra el estado actual y el historial conserva los cambios confirmados.</p><ol><li>Crea una cuenta y elige un nombre de usuario.</li><li>Abre el espacio de trabajo y crea un repositorio con un nombre breve.</li><li>Añade o edita archivos en tu entorno local y revisa el estado.</li><li>Prepara los cambios, escribe un mensaje claro y crea un commit.</li><li>Usa el asistente para explicar el cambio, detectar riesgos o proponer un mensaje.</li></ol><pre><code>aiverse status<br/>aiverse add .<br/>aiverse commit -m "Agrega página de inicio"</code></pre></section>
    <section id="repositories"><h2>2. Repositorios y visibilidad</h2><p>Un repositorio es el espacio de trabajo de un proyecto. Usa nombres descriptivos, una descripción que indique qué hace y una visibilidad acorde con el contenido.</p><ul><li><b>Público:</b> puede aparecer en Explorar y otras personas pueden descubrirlo.</li><li><b>Privado:</b> destinado a trabajo que no quieres mostrar públicamente; revisa siempre quién tiene acceso.</li><li><b>Descripción:</b> resume el propósito, el estado y la forma de ejecutar el proyecto.</li><li><b>Commits:</b> agrupa cambios relacionados y explica la intención, no solo el archivo modificado.</li></ul><p>Antes de publicar, busca claves de API, contraseñas, archivos `.env`, tokens y datos personales. Si un secreto ya llegó a un commit, revócalo; borrarlo de la última versión no elimina copias anteriores del historial.</p></section>
    <section id="terminal-guide"><h2>3. Trabajar desde la terminal</h2><p>El CLI permite inicializar repositorios, preparar archivos, guardar commits, consultar historial y sincronizar con un servidor AIVerse.</p><pre><code>aiverse init<br/>aiverse status<br/>aiverse add src/<br/>aiverse commit -m "Explica el cambio"<br/>aiverse log<br/>aiverse push https://tu-servidor</code></pre><p>Para clonar un proyecto disponible en el servidor:</p><pre><code>aiverse clone https://tu-servidor ./mi-proyecto<br/>cd mi-proyecto<br/>aiverse status</code></pre><p>Usa `add` para seleccionar los archivos que formarán el siguiente commit. Revisa el estado antes de confirmar. Mantén los mensajes breves, en modo imperativo y enfocados en el resultado.</p></section>
    <section id="ai-guide"><h2>4. Usar el asistente de IA</h2><p>La IA es una herramienta de aprendizaje y revisión. Pídele tareas concretas y conserva el control sobre qué sugerencias adoptar.</p><ul><li><b>Revisar cambios:</b> comparte el diff y solicita riesgos, casos límite y pruebas que conviene añadir.</li><li><b>Explicar código:</b> pregunta por el propósito de una función, sus entradas, efectos y dependencias.</li><li><b>Aprender conceptos:</b> pide ejemplos pequeños y una explicación ligada a los archivos abiertos.</li><li><b>Mejorar commits:</b> solicita un título que describa intención y alcance.</li><li><b>Resolver conflictos:</b> pide que compare ambos cambios, explique las consecuencias y proponga opciones.</li></ul><p>Una buena pregunta incluye el objetivo, el contexto relevante y el formato de respuesta deseado. Por ejemplo: “Revisa este diff buscando fallos de autorización. Señala archivo, escenario de explotación y corrección mínima. No reescribas todo el módulo”.</p><div className="docs-callout"><b>Protege tu código</b><p>Las solicitudes a proveedores externos pueden transmitir el texto del diff al proveedor configurado por el operador. Nunca incluyas credenciales, secretos ni datos personales.</p></div></section>
    <section id="reviews"><h2>5. Revisión colaborativa</h2><p>Una revisión efectiva comparte contexto y facilita una decisión. Abre un pull request con objetivo, alcance, decisiones de diseño y pasos para verificarlo.</p><ol><li>Describe el problema que resuelve.</li><li>Enumera los cambios principales y las áreas sensibles.</li><li>Explica cómo probarlo y qué resultado esperar.</li><li>Solicita comentarios específicos y responde a cada hilo.</li><li>Antes de integrar, verifica pruebas, seguridad, accesibilidad y documentación.</li></ol><p>La IA puede ayudar a priorizar, pero la persona responsable de la revisión decide si el cambio está listo.</p></section>
    <section id="privacy-guide"><h2>6. Privacidad y seguridad</h2><ul><li>Usa una contraseña única y activa un gestor de contraseñas.</li><li>No publiques datos de clientes, credenciales ni información que no tengas permiso para compartir.</li><li>Concede el acceso mínimo necesario y revócalo cuando deje de ser útil.</li><li>Revisa la visibilidad del repositorio antes de crear publicaciones o pedir ayuda pública.</li><li>Si expones una clave, revócala de inmediato y revisa los registros de uso del proveedor.</li><li>Confirma que entiendes qué contenido se envía a la IA antes de solicitar una revisión.</li></ul></section>
    <section id="troubleshooting"><h2>7. Solución de problemas</h2><h3>No conecta con el backend</h3><p>Comprueba que el servicio esté activo, que la URL HTTPS de la API esté configurada en `VITE_API_URL` y que el dominio web esté permitido por `WEB_ORIGIN`.</p><h3>La sesión no se mantiene</h3><p>Verifica HTTPS, cookies seguras, CORS con credenciales y que el origen configurado coincida exactamente con el dominio de la web.</p><h3>La IA no responde</h3><p>El operador debe configurar una clave del proveedor y habilitar solicitudes de red. Si no está configurada, las funciones que dependen del modelo externo no estarán disponibles.</p><h3>No puedo publicar</h3><p>Inicia sesión, comprueba tu conexión y confirma que el contenido esté dentro del límite de caracteres. La publicación requiere que la base de datos esté conectada.</p><p className="docs-updated">Esta guía describe las funciones disponibles en la beta actual y se actualizará junto con el producto.</p></section></div></article>;
}

function LegalPage({kind}: {kind: 'terms'|'privacy'|'legal'|'cookies'}) {
  if (kind === 'legal') return <article className="legal-page"><p className="eyebrow">AIVERSE · INFORMACIÓN LEGAL</p><h1>Aviso legal</h1><p className="legal-updated">Información del servicio · Beta</p><p>AIVerse es una plataforma web de versionamiento de código, colaboración y asistencia de inteligencia artificial. Este sitio describe una beta y puede cambiar mientras se desarrolla.</p><h2>Operador del servicio</h2><div className="legal-beta-note"><b>Información pendiente:</b> el repositorio no identifica al titular legal de AIVerse ni publica una dirección o canal de contacto. El operador debe completar esos datos antes de ofrecer el servicio al público.</div><ul><li>Titular o razón social: no indicado.</li><li>País y domicilio de contacto: no indicados.</li><li>Correo de soporte y privacidad: no indicado.</li></ul><h2>Propiedad intelectual y contenido</h2><p>Los nombres, marcas e interfaz de AIVerse identifican este servicio. Quien usa la plataforma conserva los derechos sobre el código que aporta y debe contar con autorización para compartirlo. Consulta los <a href="/terms">términos de servicio</a> y la <a href="/privacy">política de privacidad</a>.</p><h2>Disponibilidad y enlaces</h2><p>La plataforma está en beta y se ofrece tal como está disponible. Puede contener fallos, interrumpirse o cambiar. Los enlaces y servicios de terceros se rigen por las condiciones de sus respectivos proveedores.</p><p className="docs-updated">Este aviso es un borrador informativo, no sustituye la identificación legal del operador ni la revisión jurídica aplicable.</p></article>;
  if (kind === 'cookies') return <article className="legal-page"><p className="eyebrow">AIVERSE · INFORMACIÓN LEGAL</p><h1>Aviso de cookies</h1><p className="legal-updated">Última actualización: 14 de noviembre de 2026 · Servicio en beta</p><p>AIVerse utiliza almacenamiento técnico necesario para mantener la sesión y proteger las acciones de la cuenta. En esta aplicación no se han configurado cookies publicitarias ni herramientas de analítica.</p><h2>Cookies necesarias</h2><ul><li><b>aiverse_session:</b> mantiene la sesión iniciada. Es una cookie HttpOnly para impedir que JavaScript lea el identificador de sesión; en producción se marca Secure.</li><li><b>aiverse_csrf:</b> permite validar que las acciones enviadas desde la interfaz sean legítimas. No contiene la sesión; en producción se transmite bajo HTTPS.</li></ul><h2>Preferencias del navegador</h2><p>El tema y el idioma se guardan en el almacenamiento local del navegador, no en cookies. Puedes borrarlos desde la configuración de privacidad del navegador; al hacerlo, AIVerse volverá a los valores predeterminados.</p><h2>Control</h2><p>Si bloqueas las cookies necesarias, puede que no puedas iniciar sesión o realizar acciones protegidas. La interfaz no carga cookies opcionales de publicidad o medición en esta versión.</p><div className="legal-beta-note"><b>Nota de beta:</b> este aviso refleja el código de la aplicación revisado. El operador debe actualizarlo si incorpora analítica, publicidad, vídeos incrustados u otros servicios que almacenen información en el navegador.</div></article>;
  const privacy = kind === 'privacy';
  return <article className="legal-page"><p className="eyebrow">AIVERSE · INFORMACIÓN LEGAL</p><h1>{privacy?'Política de privacidad':'Términos de servicio'}</h1><p className="legal-updated">Última actualización: 14 de noviembre de 2026 · Servicio en beta</p>{privacy?<>
    <p>Esta política explica qué datos procesa AIVerse y cómo se usan. El operador legal y el canal para ejercer solicitudes de privacidad todavía deben publicarse; consulta el <a href="/aviso-legal">aviso legal</a>.</p>
    <h2>Datos que procesamos</h2><ul><li>Datos de cuenta: nombre de usuario, nombre visible, correo electrónico y contraseña almacenada como hash seguro.</li><li>Datos de uso: sesiones, preferencias guardadas en el navegador, metadatos de repositorios, actividad y pull requests.</li><li>Código: el contenido versionado se guarda en almacenamiento persistente del backend; los metadatos se guardan en MongoDB.</li><li>Datos técnicos básicos, como dirección IP, registros de error y uso de seguridad, pueden procesarse en la infraestructura de Render, Vercel y MongoDB Atlas.</li></ul>
    <h2>Revisiones con IA</h2><p>Si solicitas una revisión con IA, el diff o texto que envíes se transmite desde el backend al proveedor configurado por el operador (Google Gemini en la configuración actual). No envíes contraseñas, tokens, claves privadas ni datos personales en el código. El tratamiento por el proveedor está sujeto a sus propias condiciones y políticas.</p>
    <h2>Cookies y preferencias</h2><p>Usamos cookies necesarias para mantener la sesión y proteger las acciones contra solicitudes no autorizadas. El tema y el idioma seleccionados se guardan localmente en tu navegador. No se han configurado cookies publicitarias ni herramientas de analítica; consulta el <a href="/cookies">aviso de cookies</a>.</p>
    <h2>Visibilidad y conservación</h2><p>Los repositorios públicos pueden mostrarse en Explorar. Mantén privado cualquier contenido que no quieras compartir. Conservamos los datos mientras la cuenta o el repositorio sigan activos; el borrado de cuenta aún no está disponible desde la interfaz durante esta beta.</p>
    <h2>Tus solicitudes</h2><p>Puedes solicitar consulta, corrección o eliminación de información. El canal de contacto aún no está configurado en esta entrega y debe publicarse antes de ofrecer el servicio al público. No compartas datos privados en issues públicos.</p>
    <h2>Servicios de terceros</h2><p>La aplicación puede depender de Render para el backend y almacenamiento persistente, Vercel para servir la interfaz, MongoDB Atlas para la base de datos y Google Gemini para la IA cuando está habilitada. Cada proveedor puede procesar datos técnicos necesarios para prestar su servicio.</p>
  </>:<>
    <p>Estos términos cubren el uso de AIVerse, una plataforma de versionamiento y colaboración que actualmente se ofrece en beta. Al crear una cuenta o usar el servicio, aceptas seguir estas reglas.</p>
    <h2>Tu cuenta</h2><p>Proporciona un correo válido, protege tus credenciales y avísanos si sospechas que alguien accedió a tu cuenta. Eres responsable de la actividad realizada desde tu sesión.</p>
    <h2>Tu código y tus repositorios</h2><p>Conservas los derechos sobre el código que subes. Nos autorizas a almacenarlo, procesarlo y mostrarlo para operar AIVerse según la visibilidad que elijas. Los repositorios públicos pueden aparecer en Explorar; no subas información que no tengas derecho a compartir.</p>
    <h2>Uso aceptable</h2><p>No uses AIVerse para distribuir malware, vulnerar sistemas, abusar de otros usuarios, infringir derechos de terceros o interrumpir el servicio. Podemos limitar o suspender cuentas que representen un riesgo para la plataforma o la comunidad.</p>
    <h2>Planes y facturación</h2><p>Los planes y precios vigentes se muestran en <a href="/pricing">Planes</a>. Si el operador habilita el checkout, las suscripciones se procesan mensualmente en COP mediante Mercado Pago. Antes de suscribirte, revisa el precio mostrado y las condiciones que presente el proveedor de pago.</p>
    <h2>Beta y disponibilidad</h2><p>La plataforma cambia con frecuencia y algunas funciones pueden fallar, cambiar o dejar de estar disponibles. No prometemos disponibilidad continua ni que el servicio esté libre de errores. Mantén copias independientes de tu trabajo importante.</p>
    <h2>Terminación</h2><p>Puedes dejar de usar el servicio en cualquier momento. La interfaz aún no permite eliminar la cuenta ni cancelar una suscripción. El operador debe publicar un canal de soporte para estas solicitudes.</p>
    <h2>Cambios y contacto</h2><p>Estos términos pueden actualizarse a medida que el producto evolucione. La fecha de actualización aparecerá al comienzo de esta página. Los datos del operador y el canal de contacto siguen pendientes de publicación.</p>
  </>}<div className="legal-beta-note"><b>Nota de beta:</b> estos textos describen las funciones actuales y requieren revisión legal y los datos de contacto del operador antes de un lanzamiento público.</div></article>;
}
