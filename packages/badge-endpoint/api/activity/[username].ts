import { createWidgetHandler } from '../../lib/endpoint-handler.js';
import { renderActivityGraph } from '../../lib/svg-activity.js';

export default createWidgetHandler({
  prefix: 'activity',
  errorWidth: 495,
  errorHeight: 140,
  errorTextY: 75,
  render: renderActivityGraph,
});
