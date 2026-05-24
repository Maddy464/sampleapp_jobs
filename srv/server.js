const cds = require('@sap/cds');

cds.on('bootstrap', (app) => {
  require('./jobs-handler')(app);
});

module.exports = cds.server;
