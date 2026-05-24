const cds = require('@sap/cds');
const { createSecurityContext, XsuaaService } = require('@sap/xssec');

// xssec v4 API: createSecurityContext(serviceInstance, { jwt: token })
// Use the jobscheduler binding's UAA — its tokens use sap-jobscheduler!bN xsappname.
let _service;
function getService() {
  if (_service === undefined) {
    try {
      const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
      const js = (vcap.jobscheduler || [])[0];
      _service = js ? new XsuaaService(js.credentials.uaa) : null;
    } catch {
      _service = null; // local dev — no VCAP_SERVICES
    }
  }
  return _service;
}

// Validate the Job Scheduler's Bearer JWT. Skipped in local dev.
async function jwtAuth(req, res, next) {
  const service = getService();
  if (!service) return next(); // local dev: no binding, allow through

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Bearer token' });
  }
  try {
    await createSecurityContext(service, { jwt: auth.slice(7) });
    next();
  } catch (err) {
    cds.log('jobs').warn('Job JWT validation failed:', err.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = (app) => {
  const express = require('express');
  app.use(express.json());

  let x=10;
  let y=20;
  

  // Read all Books — lets you verify DB state using the same job scheduler token
  app.get('/jobs/books', jwtAuth, async (req, res) => {
    try {
      const db = await cds.connect.to('db');
      const { Books } = db.entities('sampleapp');
      const books = await db.run(SELECT.from(Books));
      res.status(200).json({ total: books.length, books });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/jobs/syncBooks', jwtAuth, async (req, res) => {
    const runId   = req.headers['x-sap-job-run-id'];
    const schedId = req.headers['x-sap-scheduler-jobid'];
    cds.log('jobs').info(`syncBooks triggered — schedulerId=${schedId} runId=${runId}`);

    try {
      const db = await cds.connect.to('db');
      const { Books } = db.entities('sampleapp');

      const before = await db.run(SELECT.from(Books));
      cds.log('jobs').info(`syncBooks: fetched ${before.length} records`);

      const now = new Date().toISOString();
      // HANA doesn't support function expressions in UPDATE — update each row individually
      await Promise.all(
        before.map(b => db.run(UPDATE(Books).where({ ID: b.ID }).set({ title: `${b.title} [synced ${now}]` })))
      );

      const after = await db.run(SELECT.from(Books));
      cds.log('jobs').info(`syncBooks: updated ${after.length} records`);

      res.status(200).json({
        status: 'success',
        processed: after.length,
        syncedAt: now,
        books: after.map(b => ({ ID: b.ID, title: b.title }))
      });
    } catch (err) {
      cds.log('jobs').error('syncBooks job failed:', err.message);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });
};

