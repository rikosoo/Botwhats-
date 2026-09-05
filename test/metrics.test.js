'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { indicadores } = require('../src/core/metrics');

const DAY = 86400000;

function consulta(app, { diasAtras, attendance, confirmation = 'aguardando', professionalId = 'dr-exemplo', status = 'confirmado' }) {
  const paciente = app.store.upsertContact(`5511${Math.random().toString().slice(2, 11)}`, 'Paciente');
  const startsAt = new Date(Date.now() - diasAtras * DAY);
  return app.store.addBooking({
    contactId: paciente.id,
    professionalId,
    professionalName: 'Dr. Exemplo Silva',
    serviceId: 'retorno',
    date: startsAt.toISOString().slice(0, 10),
    start: '09:00',
    end: '09:20',
    startsAt: startsAt.toISOString(),
    attendance,
    confirmation,
    status,
  });
}

test('taxa de falta considera só o que foi registrado', () => {
  const app = makeApp();
  consulta(app, { diasAtras: 3, attendance: 'compareceu' });
  consulta(app, { diasAtras: 4, attendance: 'compareceu' });
  consulta(app, { diasAtras: 5, attendance: 'compareceu' });
  consulta(app, { diasAtras: 6, attendance: 'faltou' });
  consulta(app, { diasAtras: 7, attendance: null }); // recepção não marcou

  const m = indicadores(app.store);
  assert.strictEqual(m.geral.total, 5);
  assert.strictEqual(m.geral.registradas, 4);
  assert.strictEqual(m.geral.semRegistro, 1);
  assert.strictEqual(m.geral.taxaFalta, 25, '1 falta em 4 registros');
});

test('consulta futura e cancelada ficam fora da taxa', () => {
  const app = makeApp();
  consulta(app, { diasAtras: 2, attendance: 'faltou' });
  consulta(app, { diasAtras: -5, attendance: null });                    // ainda vai acontecer
  consulta(app, { diasAtras: 3, attendance: null, status: 'cancelado' }); // desmarcada

  const m = indicadores(app.store);
  assert.strictEqual(m.geral.total, 1);
  assert.strictEqual(m.geral.taxaFalta, 100);
  assert.strictEqual(m.canceladas, 1);
});

test('compara falta de quem confirmou com quem não confirmou', () => {
  const app = makeApp();
  consulta(app, { diasAtras: 2, attendance: 'compareceu', confirmation: 'confirmado' });
  consulta(app, { diasAtras: 3, attendance: 'compareceu', confirmation: 'confirmado' });
  consulta(app, { diasAtras: 4, attendance: 'compareceu', confirmation: 'confirmado' });
  consulta(app, { diasAtras: 5, attendance: 'faltou', confirmation: 'confirmado' });
  consulta(app, { diasAtras: 6, attendance: 'faltou', confirmation: 'aguardando' });
  consulta(app, { diasAtras: 7, attendance: 'compareceu', confirmation: 'aguardando' });

  const m = indicadores(app.store);
  assert.strictEqual(m.confirmacao.confirmadas.taxaFalta, 25);
  assert.strictEqual(m.confirmacao.naoConfirmadas.taxaFalta, 50);
  assert.strictEqual(m.confirmacao.diferenca, 25, 'confirmar derruba a falta em 25 pontos');
});

test('separa a taxa por profissional e respeita a janela', () => {
  const app = makeApp();
  consulta(app, { diasAtras: 2, attendance: 'faltou', professionalId: 'dr-exemplo' });
  consulta(app, { diasAtras: 2, attendance: 'compareceu', professionalId: 'dra-exemplo' });
  consulta(app, { diasAtras: 40, attendance: 'faltou', professionalId: 'dra-exemplo' }); // fora da janela

  const m = indicadores(app.store, 30);
  const dr = m.porProfissional.find((p) => p.id === 'dr-exemplo');
  const dra = m.porProfissional.find((p) => p.id === 'dra-exemplo');
  assert.strictEqual(dr.taxaFalta, 100);
  assert.strictEqual(dra.taxaFalta, 0);

  const m90 = indicadores(app.store, 90);
  assert.strictEqual(m90.porProfissional.find((p) => p.id === 'dra-exemplo').taxaFalta, 50);
});

test('sem consultas registradas a taxa é zero, não NaN', () => {
  const app = makeApp();
  const m = indicadores(app.store);
  assert.strictEqual(m.geral.taxaFalta, 0);
  assert.strictEqual(m.confirmacao.diferenca, 0);
});
