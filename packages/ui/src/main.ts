import { createApp } from 'vue';
import App from './App.vue';
import './lib/theme';
import { registerServiceWorker } from './lib/service-worker';
import { router } from './router';
import './styles.css';

createApp(App).use(router).mount('#app');
registerServiceWorker();
