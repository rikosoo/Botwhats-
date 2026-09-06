'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { createServer } = require('../src/server');
const { subtrairFaixa } = require('../src/core/agenda');

async function painel(overrides) {
  const app = makeApp(overrides);
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

// ---------- não lidas ----------

test('conta só o que o paciente mandou e ainda não foi lido', async () => {
  const app = makeApp();
  const phone = '5511900110001';
  await app.conversa(phone, ['oi']);
  const paciente = app.store.findContactByPhone(phone);

  assert.strictEqual(app.store.naoLidas(paciente.id), 1, 'a resposta do bot não conta como não lida');

  app.store.marcarLida(paciente.id);
  assert.strictEqual(app.store.naoLidas(paciente.id), 0);

  await app.handleIncoming({ phone, body: 'ainda estou aí?' });
  assert.strictEqual(app.store.naoLidas(paciente.id), 1, 'mensagem nova volta a contar');
});

test('o painel devolve o total e o número por paciente', async () => {
  const p = await painel();
  try {
    await p.chamar('/api/simulate', { method: 'POST', body: { phone: '5511900110002', body: 'oi' } });
    await p.chamar('/api/simulate', { method: 'POST', body: { phone: '5511900110003', body: 'bom dia' } });
    await p.chamar('/api/simulate', { method: 'POST', body: { phone: '5511900110003', body: 'quero marcar' } });

    const { corpo } = await p.chamar('/api/state');
    assert.strictEqual(corpo.naoLidasTotal, 3);

    const segundo = corpo.contacts.find((c) => c.phone === '5511900110003');
    assert.strictEqual(segundo.naoLidas, 2);

    await p.chamar(`/api/contacts/${segundo.id}/read`, { method: 'POST' });
    const depois = await p.chamar('/api/state');
    assert.strictEqual(depois.corpo.naoLidasTotal, 1, 'abrir a conversa zera aquela conversa');
  } finally {
    await p.fechar();
  }
});

// ---------- bloqueio parcial ----------

test('subtrair um intervalo das faixas do dia', () => {
  const dia = [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '18:00' }];

  assert.deepStrictEqual(subtrairFaixa(dia, { start: '14:00', end: '16:00' }), [
    { start: '08:00', end: '12:00' },
    { start: '13:00', end: '14:00' },
    { start: '16:00', end: '18:00' },
  ]);
  assert.deepStrictEqual(subtrairFaixa(dia, { start: '08:00', end: '12:00' }), [{ start: '13:00', end: '18:00' }]);
  assert.deepStrictEqual(subtrairFaixa(dia, { start: '11:00', end: '14:00' }), [
    { start: '08:00', end: '11:00' },
    { start: '14:00', end: '18:00' },
  ]);
  assert.deepStrictEqual(subtrairFaixa(dia, { start: '19:00', end: '20:00' }), dia, 'fora do expediente não muda nada');
});

test('bloquear só a tarde deixa a manhã aberta', async () => {
  const p = await painel();
  try {
    const dia = p.app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'retorno' })[0].date;

    const bloqueio = await p.chamar('/api/professionals/dr-exemplo/bloqueio', {
      method: 'POST', body: { date: dia, start: '14:00', end: '18:00' },
    });
    assert.strictEqual(bloqueio.status, 200);

    const livres = p.app.agenda.slotsFor(dia, { professionalId: 'dr-exemplo', serviceId: 'retorno', includePast: true });
    assert.ok(livres.length > 0, 'a manhã continua aberta');
    assert.ok(livres.every((s) => s.start < '14:00'), 'e nada é oferecido à tarde');

    // Liberar devolve o dia inteiro
    await p.chamar(`/api/professionals/dr-exemplo/bloqueio/${dia}`, { method: 'DELETE' });
    const depois = p.app.agenda.slotsFor(dia, { professionalId: 'dr-exemplo', serviceId: 'retorno', includePast: true });
    assert.ok(depois.some((s) => s.start >= '14:00'), 'a tarde volta');
  } finally {
    await p.fechar();
  }
});

test('bloqueio sem horário fecha o dia inteiro', async () => {
  const p = await painel();
  try {
    const dia = p.app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'retorno' })[0].date;
    await p.chamar('/api/professionals/dr-exemplo/bloqueio', { method: 'POST', body: { date: dia } });

    assert.strictEqual(
      p.app.agenda.slotsFor(dia, { professionalId: 'dr-exemplo', serviceId: 'retorno', includePast: true }).length,
      0,
    );
  } finally {
    await p.fechar();
  }
});

test('bloqueio recusa data e horário inválidos', async () => {
  const p = await painel();
  try {
    const semData = await p.chamar('/api/professionals/dr-exemplo/bloqueio', { method: 'POST', body: {} });
    assert.strictEqual(semData.status, 400);

    const invertido = await p.chamar('/api/professionals/dr-exemplo/bloqueio', {
      method: 'POST', body: { date: '2026-10-10', start: '16:00', end: '14:00' },
    });
    assert.strictEqual(invertido.status, 400);
    assert.match(invertido.corpo.error, /nessa ordem/);
  } finally {
    await p.fechar();
  }
});
