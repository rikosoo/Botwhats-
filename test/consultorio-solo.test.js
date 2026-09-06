'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const M = require('../src/core/messages');

/** Consultório de um médico só — o caso mais comum. */
function soloApp(overrides) {
  const app = makeApp(overrides);
  app.store.clinic.professionals = app.store.clinic.professionals.filter((p) => p.id === 'dr-exemplo');
  return app;
}

test('com um médico só, o bot não pergunta com quem a pessoa prefere', async () => {
  const app = soloApp();
  const phone = '5511900070001';

  await app.conversa(phone, ['oi', 'quero marcar uma consulta', 'primeira consulta', 'unimed']);
  assert.doesNotMatch(app.textoEnviado(), /Com quem você prefere/);
  assert.match(app.ultima(), /primeiros dias com Dr\. Exemplo Silva/);
  assert.strictEqual(app.store.findContactByPhone(phone).state.step, 'agendar_dia');
});

test('agendamento completo funciona sem escolha de profissional', async () => {
  const app = soloApp();
  const phone = '5511900070002';

  await app.conversa(phone, ['oi', 'quero marcar', 'primeira consulta', 'unimed', '1', '1',
    'Ana Paula Reis', '10/10/1985', 'sim']);

  const consulta = app.store.state.bookings[0];
  assert.ok(consulta, 'consulta criada');
  assert.strictEqual(consulta.professionalId, 'dr-exemplo');
  assert.match(app.textoEnviado(), /reservada/i);
});

test('"tanto faz" na escolha do dia pega o primeiro disponível', async () => {
  const app = soloApp();
  const phone = '5511900070003';
  // Com um médico só, o bot pula a escolha de profissional e cai direto nos dias.
  await app.conversa(phone, ['oi', 'preciso de um retorno', 'particular', 'tanto faz']);

  assert.match(app.ultima(), /eu tenho:/i, 'avançou para os horários');
  const dados = app.store.findContactByPhone(phone).state.data;
  assert.ok(dados.date, 'já escolheu o dia');

  await app.handleIncoming({ phone, body: 'o quanto antes' });
  assert.strictEqual(
    app.store.findContactByPhone(phone).state.data.start,
    dados.opcoesHorarios[0],
    'e o primeiro horário do dia',
  );
});

test('a resposta de preço cita o único médico do consultório', () => {
  const app = soloApp();
  assert.match(M.valores(app.store.clinic), /Dr\. Exemplo Silva/);
});

test('lista de espera oferece a vaga normalmente', async () => {
  const app = soloApp();
  const marcado = '5511900070004';
  await app.conversa(marcado, ['oi', 'quero marcar', 'retorno', 'particular', '1', '1',
    'Bruno Cardoso', '01/02/1980', 'sim']);
  const consulta = app.store.state.bookings[0];

  const esperando = '5511900070005';
  await app.conversa(esperando, ['oi', 'me avisa se abrir vaga']);
  app.sent.length = 0;

  app.agenda.cancel(consulta.id, 'teste');
  await app.waitlist.emAndamento;

  assert.strictEqual(app.sent.length, 1);
  assert.match(app.sent[0].text, /abriu uma vaga/i);
  assert.match(app.sent[0].text, /Dr\. Exemplo Silva/);
});

test('agenda do dia, ocupação e taxa de falta seguem funcionando', async () => {
  const app = soloApp();
  const phone = '5511900070006';
  await app.conversa(phone, ['oi', 'quero marcar', 'retorno', 'particular', '1', '1',
    'Célia Prado', '03/03/1975', 'sim']);
  const consulta = app.store.state.bookings[0];

  const visao = app.agenda.dayView(consulta.date);
  assert.strictEqual(visao.length, 1, 'um bloco na agenda do dia');
  assert.strictEqual(visao[0].bookings.length, 1);
  assert.ok(app.agenda.ocupacao(7).total > 0);

  consulta.attendance = 'faltou';
  consulta.startsAt = new Date(Date.now() - 86400000).toISOString();
  const { indicadores } = require('../src/core/metrics');
  const m = indicadores(app.store);
  assert.strictEqual(m.geral.taxaFalta, 100);
  assert.strictEqual(m.porProfissional.length, 1);
});
