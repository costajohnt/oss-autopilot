import { createWidgetHandler } from '../../lib/endpoint-handler.js';
import { renderStatsCard } from '../../lib/svg-card.js';

export default createWidgetHandler({
  prefix: 'card',
  errorWidth: 495,
  errorHeight: 195,
  errorTextY: 100,
  render: renderStatsCard,
});
