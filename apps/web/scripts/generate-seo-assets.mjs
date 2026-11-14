import {mkdir, writeFile} from 'node:fs/promises';

const configuredSiteUrl = process.env.VITE_SITE_URL || 'https://aiverse.vercel.app';
const parsedSiteUrl = new URL(configuredSiteUrl);
if (parsedSiteUrl.protocol !== 'https:') throw new Error('VITE_SITE_URL debe usar HTTPS.');
const siteUrl = parsedSiteUrl.origin;
const publicDirectory = new URL('../public/', import.meta.url);
const publicRoutes = ['/', '/explore', '/docs', '/pull-requests', '/pricing', '/terms', '/privacy', '/aviso-legal', '/cookies'];
const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${publicRoutes.map(route => `  <url><loc>${xmlEscape(new URL(route, siteUrl).href)}</loc></url>`).join('\n')}\n</urlset>\n`;
const robots = `User-agent: *\nDisallow: /api/\nDisallow: /workspace\nDisallow: /account\nDisallow: /settings\nDisallow: /login\nDisallow: /signup\nSitemap: ${siteUrl}/sitemap.xml\n`;

await mkdir(publicDirectory, {recursive: true});
await Promise.all([
  writeFile(new URL('sitemap.xml', publicDirectory), sitemap),
  writeFile(new URL('robots.txt', publicDirectory), robots),
]);
