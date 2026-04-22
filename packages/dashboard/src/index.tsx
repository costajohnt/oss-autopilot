import { render } from 'preact';
import { App } from './app';
import { ErrorBoundary } from './error-boundary';
import './styles.css';

const root = document.getElementById('app');
if (root) {
  render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
    root,
  );
} else {
  console.error('Dashboard mount point #app not found. Check that index.html contains <div id="app"></div>.');
  document.body.textContent = 'Dashboard failed to load: mount point not found.';
}
