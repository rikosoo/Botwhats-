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
    schedulerIntervalMs: 60000,
    typingDelayMs: 0,
    chromiumPath: null,
    dataFile: path.join(os.tmpdir(), `botwhats-test-${crypto.randomUUID()}.json`),
    admin: { username: 'Henrique', password: 'Henrique123' },
    sessionDays: 7,
    maxLoginAttempts: 8,
    followUpOffsets: [1, 7, 15],
    bookingOffsets: [7, 3, 1],
    waitTouchMinDays: 10,
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
  app.textoEnviado = () => sent.map((s) => s.text).join('\n---\n');
  app.ultima = () => (sent.length ? sent[sent.length - 1].text : '');

  /** Conversa: manda várias mensagens em sequência pelo mesmo número. */
  app.conversa = async (phone, mensagens, name = null) => {
    for (const body of mensagens) await app.handleIncoming({ phone, name, body });
    return app.store.findContactByPhone(phone);
  };
  /** Espera o disparo em andamento terminar. */
  app.emAndamentoDoDisparo = () => app.broadcast.emAndamento || Promise.resolve();
  return app;
}

module.exports = { makeApp, testConfig };
