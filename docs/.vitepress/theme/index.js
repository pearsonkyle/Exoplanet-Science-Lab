// The default VitePress theme in the site's dark palette, with the interactive pieces of the reference pages.
import DefaultTheme from 'vitepress/theme';
import './custom.css';
import McpConnect from './components/McpConnect.vue';
import McpTry from './components/McpTry.vue';
import ApiPlayground from './components/ApiPlayground.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('McpConnect', McpConnect);
    app.component('McpTry', McpTry);
    app.component('ApiPlayground', ApiPlayground);
  },
};
