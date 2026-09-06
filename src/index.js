'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');

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

/**
 * Com certificado, a mesma porta atende HTTPS e também HTTP — neste caso
 * redirecionando. Sem isso, quem digita "http://" recebe uma tela de erro seca
 * (ERR_EMPTY_RESPONSE), porque o servidor esperava TLS e fecha a conexão.
 *
 * A primeira letra do que o cliente envia entrega o protocolo: 0x16 é o começo
 * de um handshake TLS; qualquer outra coisa é HTTP em texto.
 */
function montarOuvinte(app, certificado) {
  if (!certificado) return http.createServer(app);

  const seguro = https.createServer(certificado, app);

  // Quem chega em http recebe uma página com o link certo — e não um
  // redirecionamento. Redirect automático vira laço quando o navegador guarda
  // o 301 e a tentativa em https falha, e aí a tela não explica nada.
  const avisoHttp = http.createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0] || 'localhost';
    const destino = `https://${host}:${config.port}${req.url}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8">
<title>Use HTTPS</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#17222d}
a{display:inline-block;margin-top:1rem;background:#0e7c8a;color:#fff;padding:.7rem 1.2rem;border-radius:9px;text-decoration:none}
code{background:#eef2f6;padding:.15rem .4rem;border-radius:5px}</style>
<h1>Este painel usa conexão segura</h1>
<p>Você abriu por <code>http://</code>. O endereço certo é:</p>
<p><a href="${destino}">${destino}</a></p>
<p>O navegador vai avisar que o certificado é do próprio servidor — é esperado.
Clique em <b>Avançado</b> e depois em <b>Aceitar o risco e continuar</b>.</p>`);
  });

  return net.createServer((socket) => {
    socket.once('error', () => socket.destroy());
    socket.once('data', (primeiro) => {
      // Pausar antes de devolver os bytes é o que faz o TLS enxergar o
      // handshake inteiro; sem isso o HTTPS fecha a conexão sem responder.
      socket.pause();
      socket.unshift(primeiro);
      const destino = primeiro[0] === 0x16 ? seguro : avisoHttp;
      destino.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
}

async function main() {
  const certificado = ouvinteHttps();
  // Cookie de sessão só volta marcado como seguro quando há HTTPS de verdade.
  if (certificado) config.cookieSecure = true;

  const app = createApp(config);
  const { server } = createServer(app);
  const ouvinte = montarOuvinte(server, certificado);

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
    if (!String(app.channel.status || '').startsWith('erro')) {
      app.channel.status = `erro ao iniciar: ${err.message}`;
    }
    console.error('[canal] nao foi possivel iniciar:', err.message);
    console.error('[canal] o painel mostra o erro em Ajustes > Conexao do WhatsApp.');
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
