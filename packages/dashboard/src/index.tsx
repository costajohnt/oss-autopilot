import { render } from 'preact';
import { App } from './app';
import './styles.css';

// Synchronous theme application (backup FOUC prevention for SPA navigation)
try {
  const stored = localStorage.getItem('oss-autopilot-theme');
  let theme: string;
  if (stored === 'light' || stored === 'dark') {
    theme = stored;
  } else {
    theme = matchMedia('(prefers-color-scheme:light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
} catch {
  document.documentElement.setAttribute('data-theme', 'dark');
}

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
} else {
  console.error('Dashboard mount point #app not found. Check that index.html contains <div id="app"></div>.');
  document.body.textContent = 'Dashboard failed to load: mount point not found.';
}
