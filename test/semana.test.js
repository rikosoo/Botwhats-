'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { createServer } = require('../src/server');
const { addDaysToKey, weekdayOf } = require('../src/core/agenda');

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

/** Primeira data a partir de hoje que cai no dia da semana pedido. */
function proximo(agenda, diaSemana) {
  let cursor = agenda.today();
  for (let i = 0; i < 14; i += 1) {
    if (weekdayOf(cursor) === diaSemana) return cursor;
    cursor = addDaysToKey(cursor, 1);
  }
  throw new Error('não achei o dia');
}

test('a semana começa na segunda-feira, venha a data que vier', () => {
  const { agenda } = makeApp();
  const quinta = proximo(agenda, 4);
  const segunda = agenda.segundaDe(quinta);
  assert.strictEqual(weekdayOf(segunda), 1);
  assert.strictEqual(addDaysToKey(segunda, 3), quinta);

  // Domingo pertence à semana que já passou, não à que começa no dia seguinte.
  const domingo = proximo(agenda, 0);
  assert.strictEqual(addDaysToKey(agenda.segundaDe(domingo), 6), domingo);
});

test('cada dia mostra o que está marcado e quanto sobrou', async () => {
  const app = makeApp();
  const { agenda, store } = app;
  const clinic = store.clinic;
  const terca = proximo(agenda, 2);
  const paciente = store.upsertContact('5511900220001', 'Marina');
  const profissional = clinic.professionals[0];
  const servico = clinic.services[0];

  const antes = agenda.semana(agenda.segundaDe(terca))
    .find((d) => d.date === terca);
  assert.ok(antes.livres > 0, 'terça-feira precisa ter horário livre para o teste valer');

  const livre = agenda.slotsFor(terca, {
    professionalId: profissional.id, serviceId: servico.id, includePast: true,
  })[0];
  agenda.book(paciente.id, {
    professionalId: profissional.id,
    serviceId: servico.id,
    date: terca,
    start: livre.start,
  });

  const dias = agenda.semana(agenda.segundaDe(terca));
  assert.strictEqual(dias.length, 7);
  const depois = dias.find((d) => d.date === terca);
  assert.strictEqual(depois.marcadas, 1);
  assert.ok(depois.livres < antes.livres, 'o horário reservado sai dos livres');
  assert.strictEqual(depois.profissionais[0].marcadas[0].contactId, paciente.id);
  assert.ok(depois.atende);
});

test('dia bloqueado aparece como fechado, não como lotado', async () => {
  const { app, chamar, fechar } = await painel();
  const alvo = proximo(app.agenda, 3);      // quarta-feira
  const profissional = app.store.clinic.professionals[0];

  const { status } = await chamar(`/api/professionals/${profissional.id}/bloqueio`, {
    method: 'POST', body: { date: alvo },
  });
  assert.strictEqual(status, 200);

  const dia = app.agenda.semana(app.agenda.segundaDe(alvo)).find((d) => d.date === alvo);
  assert.strictEqual(dia.profissionais[0].atende, false);
  assert.strictEqual(dia.profissionais[0].livres, 0);

  await fechar();
});

test('o painel entrega a semana pedida e cai na atual sem parâmetro', async () => {
  const { app, chamar, fechar } = await painel();

  const atual = await chamar('/api/semana');
  assert.strictEqual(atual.status, 200);
  assert.strictEqual(atual.corpo.inicio, app.agenda.segundaDe());
  assert.strictEqual(atual.corpo.hoje, app.agenda.today());
  assert.strictEqual(atual.corpo.dias.length, 7);

  const proximaSemana = addDaysToKey(atual.corpo.inicio, 7);
  const seguinte = await chamar(`/api/semana?inicio=${proximaSemana}`);
  assert.strictEqual(seguinte.corpo.inicio, proximaSemana);
  assert.strictEqual(seguinte.corpo.dias[0].date, proximaSemana);

  // Lixo na querystring não derruba a tela: cai na semana corrente.
  const invalida = await chamar('/api/semana?inicio=amanha');
  assert.strictEqual(invalida.corpo.inicio, app.agenda.segundaDe());

  await fechar();
});

test('sem sessão a semana não é servida', async () => {
  const app = makeApp();
  const { server } = createServer(app);
  const http = await new Promise((r) => { const s = server.listen(0, () => r(s)); });
  const res = await fetch(`http://127.0.0.1:${http.address().port}/api/semana`);
  assert.strictEqual(res.status, 401);
  await new Promise((r) => http.close(r));
});
