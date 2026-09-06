'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { createServer } = require('../src/server');

async function painel(channel) {
  const app = makeApp();
  if (channel) Object.assign(app.channel, channel);
  const { server } = createServer(app);
  const http = await new Promise((r) => { const s = server.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  let cookie = null;
  const chamar = async (caminho, options = {}) => {
    const res = await fetch(base + caminho, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const enviado = res.headers.get('set-cookie');
    if (enviado) cookie = enviado.split(';')[0];
    return { status: res.status, corpo: await res.json().catch(() => ({})) };
  };
  await chamar('/api/login', { method: 'POST', body: { username: 'Henrique', password: 'Henrique123' } });
  return { app, chamar, fechar: () => new Promise((r) => http.close(r)) };
}

test('o QR Code chega ao painel já desenhado', async () => {
  const p = await painel({ name: 'whatsapp', status: 'aguardando leitura do QR Code', qr: '2@abc123,def456,ghi==' });
  try {
    const { status, corpo } = await p.chamar('/api/whatsapp');
    assert.strictEqual(status, 200);
    assert.strictEqual(corpo.conectado, false);
    assert.match(corpo.qrSvg, /^<svg/, 'vem como SVG pronto para exibir');
    assert.ok(corpo.qrSvg.length > 200);
  } finally {
    await p.fechar();
  }
});

test('conectado não expõe QR nenhum', async () => {
  const p = await painel({ name: 'whatsapp', status: 'conectado', qr: null });
  try {
    const { corpo } = await p.chamar('/api/whatsapp');
    assert.strictEqual(corpo.conectado, true);
    assert.strictEqual(corpo.qrSvg, null);
    assert.strictEqual(corpo.qrTexto, null);
  } finally {
    await p.fechar();
  }
});

test('o estado da conexão exige login', async () => {
  const app = makeApp();
  const { server } = createServer(app);
  const http = await new Promise((r) => { const s = server.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${http.address().port}/api/whatsapp`);
    assert.strictEqual(res.status, 401, 'o QR daria acesso ao WhatsApp do consultório');
  } finally {
    await new Promise((r) => http.close(r));
  }
});

test('com o atendimento automático desligado, o bot não responde', async () => {
  const { makeApp: criar } = require('./helpers');
  const app = criar();
  const phone = '5511900080001';

  await app.conversa(phone, ['oi']);
  assert.ok(app.sent.length > 0, 'ligado, ele responde');

  app.store.clinic.botEnabled = false;
  app.sent.length = 0;
  await app.handleIncoming({ phone, body: 'quero marcar uma consulta' });

  assert.strictEqual(app.sent.length, 0, 'desligado, silêncio');
  const paciente = app.store.findContactByPhone(phone);
  assert.strictEqual(paciente.stage, 'atendimento humano', 'mas entra na fila da recepção');
  assert.strictEqual(
    app.store.messagesOf(paciente.id).slice(-1)[0].body,
    'quero marcar uma consulta',
    'e a mensagem fica registrada',
  );

  // Religando, ele volta a atender o mesmo paciente.
  app.store.clinic.botEnabled = true;
  await app.handleIncoming({ phone, body: 'oi de novo' });
  assert.ok(app.sent.length > 0);
});

test('o interruptor do bot é uma rota protegida', async () => {
  const p = await painel();
  try {
    const desligar = await p.chamar('/api/bot', { method: 'POST', body: { enabled: false } });
    assert.strictEqual(desligar.status, 200);
    assert.strictEqual(p.app.store.clinic.botEnabled, false);

    const estado = await p.chamar('/api/whatsapp');
    assert.strictEqual(estado.corpo.botAtivo, false);

    await p.chamar('/api/bot', { method: 'POST', body: { enabled: true } });
    assert.strictEqual(p.app.store.clinic.botEnabled, true);
  } finally {
    await p.fechar();
  }
});

test('falha ao iniciar o canal aparece no painel, não só no log', async () => {
  const p = await painel({ name: 'whatsapp', status: 'erro ao iniciar: Failed to launch the browser process', qr: null });
  try {
    const { corpo } = await p.chamar('/api/whatsapp');
    assert.strictEqual(corpo.conectado, false);
    assert.match(corpo.status, /^erro ao iniciar/);
    assert.strictEqual(corpo.qrSvg, null, 'sem QR falso enquanto o canal está quebrado');
  } finally {
    await p.fechar();
  }
});

test('mensagem não entregue fica no histórico com o motivo', async () => {
  const { makeApp: criar } = require('./helpers');
  const app = criar();
  // Canal que recusa o envio, como o WhatsApp antes de conectar.
  app.channel.sendText = async () => {
    throw new Error('WhatsApp ainda nao conectado — leia o QR Code em Ajustes > Conexao do WhatsApp');
  };

  const phone = '5511900090001';
  await assert.rejects(
    () => app.handleIncoming({ phone, body: 'oi' }),
    /ainda nao conectado/,
    'o erro chega a quem chamou, em português',
  );

  const paciente = app.store.findContactByPhone(phone);
  const saidas = app.store.messagesOf(paciente.id).filter((m) => m.direction === 'out');
  assert.ok(saidas.length > 0, 'a resposta foi registrada mesmo sem entregar');
  assert.match(saidas[0].meta.erro, /ainda nao conectado/);
  assert.ok(app.store.state.events.some((e) => e.type === 'erro' && /Não entregue/.test(e.text)));
});

test('o simulador responde 409 com texto útil quando a entrega falha', async () => {
  const p = await painel();
  try {
    p.app.channel.sendText = async () => { throw new Error('WhatsApp ainda nao conectado'); };
    const { status, corpo } = await p.chamar('/api/simulate', {
      method: 'POST', body: { phone: '5511900090002', body: 'oi' },
    });
    assert.strictEqual(status, 409);
    assert.match(corpo.error, /ainda nao conectado/);
    assert.strictEqual(corpo.entregue, false);
  } finally {
    await p.fechar();
  }
});
