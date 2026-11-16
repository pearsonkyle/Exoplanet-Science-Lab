// The default VitePress theme in the site's dark palette, with the interactive pieces of the reference pages.
import DefaultTheme from 'vitepress/theme';
import './custom.css';
import ApiPlayground from './components/ApiPlayground.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ApiPlayground', ApiPlayground);
  },
};
