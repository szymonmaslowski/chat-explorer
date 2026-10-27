import { createApp } from 'vue';
import App from './App.vue';
import './lib/theme';
import { router } from './router';
import './styles.css';

createApp(App).use(router).mount('#app');
