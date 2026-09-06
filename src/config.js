'use strict';

const path = require('path');

function loadDotEnv() {
  const fs = require('fs');
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const config = {
  channel: process.env.CHANNEL || 'mock',
  port: Number(process.env.PORT || 3000),
  // Endereco de escuta. Em servidor exposto, use 127.0.0.1: o painel fica
  // alcancavel so pela propria maquina (e por um tunel SSH).
  host: process.env.HOST || '0.0.0.0',
  timezone: process.env.TZ || 'America/Sao_Paulo',
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 30000),
  chromiumPath: process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null,
  dataFile: process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),

  // Pausa entre mensagens seguidas, para a conversa nao chegar em bloco
  // (0 desliga; no simulador e nos testes fica desligado).
  typingDelayMs: Number(process.env.TYPING_DELAY_MS || 1200),

  // Acesso ao painel. O usuario padrao e criado na primeira execucao e ja
  // vem marcado para trocar a senha.
  admin: {
    username: process.env.ADMIN_USER || 'Henrique',
    password: process.env.ADMIN_PASSWORD || 'Henrique123',
  },
  sessionDays: Number(process.env.SESSION_DAYS || 7),
  maxLoginAttempts: Number(process.env.MAX_LOGIN_ATTEMPTS || 8),
  // Marque como true quando o painel estiver atras de HTTPS.
  cookieSecure: process.env.COOKIE_SECURE === 'true',

  // Certificado do painel. Com os dois preenchidos, o servidor sobe em HTTPS.
  sslCert: process.env.SSL_CERT || path.join(__dirname, '..', 'certs', 'painel.crt'),
  sslKey: process.env.SSL_KEY || path.join(__dirname, '..', 'certs', 'painel.key'),

  // Ocupacao (%) a partir da qual o bot pode dizer que a agenda esta enchendo.
  scarcityThreshold: Number(process.env.SCARCITY_THRESHOLD || 80),

  // Retencao das conversas (LGPD). 0 desliga a limpeza automatica.
  messageRetentionDays: Number(process.env.MESSAGE_RETENTION_DAYS || 365),

  // Prazo (min) que a pessoa tem para responder a uma vaga oferecida.
  waitlistOfferMinutes: Number(process.env.WAITLIST_OFFER_MINUTES || 120),

  // Disparo em massa: intervalo entre mensagens e teto por disparo.
  broadcastDelayMs: Number(process.env.BROADCAST_DELAY_MS || 2500),
  broadcastMaxRecipients: Number(process.env.BROADCAST_MAX || 200),

  // Lembretes de follow-up: dias apos o contato de quem ainda nao marcou.
  followUpOffsets: [1, 7, 15],
  // Lembretes da consulta: 7 e 3 dias antes (uteis, sem contagem regressiva)
  // e a vespera, que e a mensagem de confirmacao.
  bookingOffsets: [7, 3, 1],
  // Silencio maximo (dias) entre marcar e o primeiro lembrete antes de valer
  // um toque no meio da espera.
  waitTouchMinDays: Number(process.env.WAIT_TOUCH_MIN_DAYS || 10),
};

module.exports = config;
