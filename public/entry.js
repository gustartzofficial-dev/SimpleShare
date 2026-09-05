// Production entrypoint: load browser/UI compatibility hooks before the
// existing SimpleShare application without modifying its transport code.
import './compat.js';
import './app.js';
