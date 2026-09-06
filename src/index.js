'use strict';

const fs = require('fs');
const https = require('https');

const config = require('./config');
const { createApp } = require('./app');
const { createServer } = require('./server');

/** Sobe em HTTPS quando há certificado; senão, HTTP mesmo. */
function ouvinteHttps() {
  if (!fs.existsSync(config.sslCert) || !fs.existsSync(config.sslKey)) return null;
  try {
    return {
      cert: fs.readFileSync(config.sslCert),
      key: fs.readFileSync(config.sslKey),
    };
  } catch (err) {
    console.error('[https] certificado ilegível, subindo em HTTP:', err.message);
    return null;
  }
}

async function main() {
  const certificado = ouvinteHttps();
  // Cookie de sessão só volta marcado como seguro quando há HTTPS de verdade.
  if (certificado) config.cookieSecure = true;

  const app = createApp(config);
  const { server } = createServer(app);
  const ouvinte = certificado ? https.createServer(certificado, server) : server;

  app.reminders.start();
  app.waitlist.start();
  app.retencao.start();

  ouvinte.listen(config.port, config.host, () => {
    const clinica = app.store.clinic;
    const esquema = certificado ? 'https' : 'http';
    console.log(`\n  ${clinica.name} — painel da recepção em ${esquema}://localhost:${config.port}`);
    if (certificado) console.log('  Conexão criptografada (HTTPS).');
    if (config.host === '127.0.0.1') console.log('  Escutando só em 127.0.0.1 (use um túnel SSH para acessar).');
    console.log(`  Canal: ${config.channel} | Fuso: ${config.timezone} | Assistente: ${clinica.assistantName}`);
    console.log(`  Lembretes: follow-up ${config.followUpOffsets.join('/')} dias · `
      + `${config.bookingOffsets.join('/')} dias antes da consulta\n`);
  });

  try {
    await app.channel.start();
  } catch (err) {
    console.error('[canal] nao foi possivel iniciar:', err.message);
    console.error('[canal] o painel continua funcionando no modo simulador.');
  }

  const shutdown = async () => {
    app.reminders.stop();
    app.waitlist.stop();
    app.retencao.stop();
    app.store.saveNow();
    try { await app.channel.stop(); } catch { /* ignora */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
