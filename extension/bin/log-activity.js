import * as path from 'path';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';
import { logActivity } from '../services/activity-logger.js';
import { safeErrorMessage } from '../services/pickle-utils.js';
if (process.argv[1] && path.basename(process.argv[1]) === 'log-activity.js') {
    const [eventType, rawTitle] = process.argv.slice(2);
    if (!eventType || eventType.startsWith('--')) {
        console.error(`Usage: log-activity <event_type> "<title>"\nValid types: ${VALID_ACTIVITY_EVENTS.join(', ')}`);
        process.exit(1);
    }
    if (!VALID_ACTIVITY_EVENTS.includes(eventType)) {
        console.error(`Unknown event type "${eventType}". Valid types: ${VALID_ACTIVITY_EVENTS.join(', ')}`);
        process.exit(1);
    }
    if (!rawTitle || rawTitle.startsWith('--')) {
        console.error('Title is required and must not start with "--".');
        process.exit(1);
    }
    // Strip all control characters (C0/C1) and ANSI escape sequences
    const title = rawTitle.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200);
    if (title.trim().length === 0) {
        console.error('Title must not be empty after sanitization.');
        process.exit(1);
    }
    try {
        logActivity({ event: eventType, title, source: 'persona' });
    }
    catch (err) {
        console.error(`Failed to log activity: ${safeErrorMessage(err)}`);
        process.exit(1);
    }
}
