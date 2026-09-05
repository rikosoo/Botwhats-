'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { createServer } = require('./server');

async function main() {
  const app = createApp(config);
  const { server } = createServer(app);

  app.reminders.start();

  server.listen(config.port, () => {
    const clinica = app.store.clinic;
    console.log(`\n  ${clinica.name} — painel da recepção em http://localhost:${config.port}`);
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
