// Documentation site (VitePress). Built into dist/docs/ next to the web app, so the docs and the app share one
// origin on GitHub Pages: the Browser API playground drives the real analyzer in an iframe.
//   DOCS_BASE  the docs' path on the host: '/Exoplanet-Science-Lab/docs/' on github.io, '/docs/' on a custom domain
//   SITE_URL   the web app's address, for the "Open the app" links
import { defineConfig } from 'vitepress';

const base = process.env.DOCS_BASE || '/docs/';
const site = process.env.SITE_URL || base.replace(/docs\/$/, '');
const repo = 'https://github.com/pearsonkyle/Exoplanet-Science-Lab';

export default defineConfig({
  title: 'Exoplanet Science Lab',
  description: 'Plan, observe, reduce and fit exoplanet observations in the browser, from Python, or through MCP.',
  base,
  cleanUrls: false,
  lastUpdated: true,
  srcExclude: ['**/references.bib', 'ROADMAP.md'],
  ignoreDeadLinks: [/^https?:\/\/localhost/, /^\.\.\//, /^\/(plan|observe|analyze|search|methods)\//],
  head: [['link', { rel: 'icon', href: base + 'favicon.svg' }], ['meta', { name: 'theme-color', content: '#0b0f18' }]],
  appearance: 'dark',
  markdown: { math: true, lineNumbers: false },
  vite: { define: { __SITE_URL__: JSON.stringify(site) } },
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'ESL Docs',
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Reference', items: [
        { text: 'Browser API (try it)', link: '/reference/browser-api' },
        { text: 'MCP tools (try it)', link: '/reference/mcp-tools' },
        { text: 'Python package', link: '/reference/python' },
        { text: 'JavaScript core', link: '/reference/core/' },
        { text: 'Session format', link: '/FORMAT' },
      ] },
      { text: 'Methods', link: '/METHODS' },
      { text: 'Open the app ↗', link: site },
    ],
    sidebar: {
      '/': [
        { text: 'Start here', items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'A tour of the site', link: '/guide/site' },
          { text: 'Worked examples', link: '/guide/examples' },
        ] },
        { text: 'Run it yourself', items: [
          { text: 'Python package', link: '/guide/python' },
          { text: 'MCP server', link: '/guide/mcp' },
          { text: 'Assistant and your own LLM', link: '/guide/assistant' },
          { text: 'Hosting and custom domain', link: '/guide/hosting' },
          { text: 'Development and tests', link: '/guide/development' },
        ] },
        { text: 'Reference', items: [
          { text: 'Browser API', link: '/reference/browser-api' },
          { text: 'MCP and assistant tools', link: '/reference/mcp-tools' },
          { text: 'Python package', link: '/reference/python' },
          { text: 'JavaScript core', link: '/reference/core/' },
          { text: 'Session format', link: '/FORMAT' },
          { text: 'Architecture', link: '/ARCHITECTURE' },
        ] },
        { text: 'Science', items: [
          { text: 'Methods', link: '/METHODS' },
          { text: 'Validation notes', link: '/guide/validation' },
        ] },
      ],
    },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: { pattern: repo + '/edit/main/docs/:path', text: 'Edit this page on GitHub' },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: { message: 'MIT licensed · Kyle A. Pearson', copyright: 'Everything runs in your browser: nothing you load is uploaded.' },
  },
});
