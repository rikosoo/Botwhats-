'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../src/app');

function testConfig(overrides = {}) {
  return {
    channel: 'mock',
    port: 0,
    timezone: 'America/Sao_Paulo',
    businessName: 'Clinica Teste',
    schedulerIntervalMs: 60000,
    chromiumPath: null,
    dataFile: path.join(os.tmpdir(), `botwhats-test-${crypto.randomUUID()}.json`),
    followUpOffsets: [1, 7, 15],
    bookingOffsets: [15, 7, 1],
    ...overrides,
  };
}

/** App de teste com um canal que apenas guarda o que seria enviado. */
function makeApp(overrides) {
  const sent = [];
  const channel = {
    name: 'test',
    status: 'conectado',
    onMessage: null,
    async start() {},
    async stop() {},
    async sendText(phone, text) { sent.push({ phone, text }); },
  };
  const app = createApp(testConfig(overrides), { channel });
  app.sent = sent;
  return app;
}

module.exports = { makeApp, testConfig };
