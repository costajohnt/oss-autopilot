import { createWidgetHandler } from '../../lib/endpoint-handler.js';
import { renderRecentCard } from '../../lib/svg-recent.js';

export default createWidgetHandler({
  prefix: 'recent',
  errorWidth: 495,
  errorHeight: 80,
  errorTextY: 45,
  render: renderRecentCard,
});
