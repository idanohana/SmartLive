/**
 * Entry point for managed Node hosting.
 *
 * cPanel / Passenger panels look for an "application startup file" in the
 * project root, so this is it. Everything lives in server/index.js.
 */
module.exports = require('./server/index.js');
