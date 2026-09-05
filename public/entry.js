// Production entrypoint: load browser/UI compatibility hooks before the
// existing SimpleShare application without modifying its transport code.
import './compat.js';
import './theme-layout-fix.js';
import './app.js';
