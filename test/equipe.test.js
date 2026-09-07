'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { createServer } = require('../src/server');

/** Painel autenticado, para exercitar as rotas como a recepção faria. */
async function painel(overrides) {
  const app = makeApp(overrides);
  const { server } = createServer(app);
  const http = await new Promise((resolve) => { const s = server.listen(0, () => resolve(s)); });
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

/**
 * Minutos de um horário livre.
 *
 * Os testes olhavam o primeiro horário do dia pelo nome ("08:00"): passavam de
 * manhã e falhavam à tarde, porque o que já passou sai da lista. O que a grade
 * promete é a duração, e é isso que se verifica.
 */
function duracao(slot) {
  const min = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return min(slot.end) - min(slot.start);
}

test('cadastrar, editar e remover um profissional', async () => {
  const p = await painel();
  try {
    const criado = await p.chamar('/api/professionals', {
      method: 'POST',
      body: { name: 'Dra. Júlia Menezes', specialty: 'Dermatologia', crm: 'CRM/SP 123456', slotMinutes: 20 },
    });
    assert.strictEqual(criado.status, 200);
    assert.strictEqual(criado.corpo.id, 'dra-julia-menezes', 'id sem acento nem espaço');
    assert.strictEqual(criado.corpo.specialty, 'Dermatologia');

    const editado = await p.chamar(`/api/professionals/${criado.corpo.id}`, {
      method: 'PUT', body: { name: 'Dra. Júlia M. Menezes', specialty: 'Dermatologia clínica' },
    });
    assert.strictEqual(editado.corpo.name, 'Dra. Júlia M. Menezes');
    assert.strictEqual(editado.corpo.id, criado.corpo.id, 'o id não muda ao renomear');

    const removido = await p.chamar(`/api/professionals/${criado.corpo.id}`, { method: 'DELETE' });
    assert.strictEqual(removido.status, 200);
    assert.strictEqual(p.app.store.clinic.professionals.some((x) => x.id === criado.corpo.id), false);
  } finally {
    await p.fechar();
  }
});

test('renomear o médico atualiza o nome nas consultas já marcadas', async () => {
  const p = await painel();
  try {
    const paciente = p.app.store.upsertContact('5511900060001', 'Íris Lopes');
    const dia = p.app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'retorno' })[0];
    const consulta = p.app.agenda.book(paciente.id, {
      professionalId: 'dr-exemplo', serviceId: 'retorno', date: dia.date, start: dia.slots[0].start,
    });

    await p.chamar('/api/professionals/dr-exemplo', { method: 'PUT', body: { name: 'Dr. Exemplo Silva Neto' } });
    assert.strictEqual(p.app.store.getBooking(consulta.id).professionalName, 'Dr. Exemplo Silva Neto');
  } finally {
    await p.fechar();
  }
});

test('não remove profissional com consulta futura nem o último da equipe', async () => {
  const p = await painel();
  try {
    const paciente = p.app.store.upsertContact('5511900060002', 'João Reis');
    const dia = p.app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'retorno' })[0];
    p.app.agenda.book(paciente.id, {
      professionalId: 'dr-exemplo', serviceId: 'retorno', date: dia.date, start: dia.slots[0].start,
    });

    const comAgenda = await p.chamar('/api/professionals/dr-exemplo', { method: 'DELETE' });
    assert.strictEqual(comAgenda.status, 409);
    assert.match(comAgenda.corpo.error, /consulta\(s\) futura\(s\)/);

    await p.chamar('/api/professionals/dra-exemplo', { method: 'DELETE' });
    p.app.store.state.bookings.length = 0; // sem agenda, ainda assim é o último
    const ultimo = await p.chamar('/api/professionals/dr-exemplo', { method: 'DELETE' });
    assert.strictEqual(ultimo.status, 409);
    assert.match(ultimo.corpo.error, /pelo menos um profissional/);
  } finally {
    await p.fechar();
  }
});

test('cadastrar e editar um tipo de atendimento', async () => {
  const p = await painel();
  try {
    const criado = await p.chamar('/api/services', {
      method: 'POST',
      body: {
        name: 'Consulta de urgência',
        durationMin: 25,
        price: 'R$ 500,00',
        includes: 'avaliação imediata\nrelatório para o convênio',
        prep: 'Traga documento com foto.',
        returnDays: 7,
      },
    });
    assert.strictEqual(criado.status, 200);
    assert.strictEqual(criado.corpo.id, 'consulta-de-urgencia');
    assert.deepStrictEqual(criado.corpo.includes, ['avaliação imediata', 'relatório para o convênio']);
    assert.strictEqual(criado.corpo.durationMin, 25);

    // A duração nova passa a valer na grade de horários. O primeiro horário
    // livre depende da hora em que o teste roda — o que importa é que cada um
    // dure os 25 minutos cadastrados, não que comece às 08:00.
    const dia = p.app.agenda.nextAvailableDays(1, {
      professionalId: 'dr-exemplo', serviceId: 'consulta-de-urgencia',
    })[0];
    for (const slot of dia.slots) assert.strictEqual(duracao(slot), 25);

    const editado = await p.chamar('/api/services/consulta-de-urgencia', {
      method: 'PUT', body: { durationMin: 45 },
    });
    assert.strictEqual(editado.corpo.durationMin, 45);
    assert.strictEqual(editado.corpo.name, 'Consulta de urgência', 'o resto do cadastro é preservado');
  } finally {
    await p.fechar();
  }
});

test('o bot passa a oferecer o atendimento recém-criado', async () => {
  const p = await painel();
  try {
    await p.chamar('/api/services', { method: 'POST', body: { name: 'Teleconsulta', durationMin: 30 } });
    const phone = '5511900060003';
    await p.chamar('/api/simulate', { method: 'POST', body: { phone, body: 'oi' } });
    const resposta = await p.chamar('/api/simulate', { method: 'POST', body: { phone, body: 'quero marcar' } });
    assert.match(resposta.corpo.replies.join('\n'), /Teleconsulta/);
  } finally {
    await p.fechar();
  }
});

test('as regras dos lembretes podem ser mudadas pelo painel', async () => {
  const p = await painel();
  try {
    const salvo = await p.chamar('/api/clinic', {
      method: 'PUT',
      body: {
        reminders: {
          followUp: [2, 10], booking: [5, 1], waitlistOfferMinutes: 45, scarcityThreshold: 60,
        },
      },
    });
    assert.strictEqual(salvo.status, 200);

    const paciente = p.app.store.upsertContact('5511900060010', 'Kátia Silva');
    assert.deepStrictEqual(
      p.app.reminders.scheduleFollowUps(paciente).map((r) => r.offsetDays),
      [2, 10],
      'a régua nova vale para os próximos lembretes',
    );
    assert.strictEqual(p.app.waitlist.prazoMs / 60000, 45);
    assert.strictEqual(p.app.reminders.regra('scarcityThreshold', 80), 60);

    // O painel passa a mostrar as regras em vigor, não as do .env.
    const estado = await p.chamar('/api/state');
    assert.deepStrictEqual(estado.corpo.offsets.followUp, [2, 10]);
    assert.strictEqual(estado.corpo.offsets.waitlistOfferMinutes, 45);
  } finally {
    await p.fechar();
  }
});

test('horários livres respondem à combinação de médico e atendimento', async () => {
  const p = await painel();
  try {
    const daDra = await p.chamar('/api/slots-dias?professionalId=dra-exemplo&serviceId=retorno');
    const doDr = await p.chamar('/api/slots-dias?professionalId=dr-exemplo&serviceId=primeira-consulta');

    assert.ok(daDra.corpo.dias.length > 0);
    assert.ok(doDr.corpo.dias.length > 0);
    // A Dra. atende à tarde; o Dr. começa de manhã.
    assert.ok(daDra.corpo.dias[0].slots.every((s) => s.start >= '13:00'));
    assert.ok(doDr.corpo.dias.some((d) => d.slots.some((s) => s.start === '08:00')),
      'a grade do Dr. começa às 08:00 em algum dos dias oferecidos');
    // E a duração do atendimento muda o tamanho do horário.
    assert.strictEqual(duracao(doDr.corpo.dias[0].slots[0]), 40);
    assert.strictEqual(duracao(daDra.corpo.dias[0].slots[0]), 20);
  } finally {
    await p.fechar();
  }
});

test('bloquear e desbloquear um dia da agenda', async () => {
  const p = await painel();
  try {
    const dia = p.app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'retorno' })[0].date;
    const antes = p.app.agenda.slotsFor(dia, { professionalId: 'dr-exemplo', serviceId: 'retorno' }).length;
    assert.ok(antes > 0, 'o dia tinha horários');

    // Bloqueia (férias, congresso, feriado)
    await p.chamar('/api/professionals/dr-exemplo', {
      method: 'PUT', body: { exceptions: { [dia]: [] } },
    });
    assert.strictEqual(
      p.app.agenda.slotsFor(dia, { professionalId: 'dr-exemplo', serviceId: 'retorno' }).length,
      0,
      'bloqueado, o dia some da agenda',
    );

    // E o bot deixa de oferecer aquele dia
    const phone = '5511900100001';
    await p.chamar('/api/simulate', { method: 'POST', body: { phone, body: 'oi' } });
    await p.chamar('/api/simulate', { method: 'POST', body: { phone, body: 'quero marcar um retorno' } });
    const dias = p.app.store.findContactByPhone(phone).state.data.opcoesDias || [];
    assert.ok(!dias.includes(dia), 'o dia bloqueado não é oferecido ao paciente');

    // Desbloqueia — é o que o ✕ do painel faz: manda as exceções sem essa data
    await p.chamar('/api/professionals/dr-exemplo', { method: 'PUT', body: { exceptions: {} } });
    assert.strictEqual(
      p.app.agenda.slotsFor(dia, { professionalId: 'dr-exemplo', serviceId: 'retorno' }).length,
      antes,
      'desbloqueado, os horários voltam exatamente como eram',
    );
  } finally {
    await p.fechar();
  }
});

test('bloquear um dia não mexe nas consultas já marcadas nele', async () => {
  const p = await painel();
  try {
    const paciente = p.app.store.upsertContact('5511900100002', 'Lúcia Prado');
    const dia = p.app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'retorno' })[0];
    const consulta = p.app.agenda.book(paciente.id, {
      professionalId: 'dr-exemplo', serviceId: 'retorno', date: dia.date, start: dia.slots[0].start,
    });

    await p.chamar('/api/professionals/dr-exemplo', {
      method: 'PUT', body: { exceptions: { [dia.date]: [] } },
    });

    // A consulta continua de pé: quem já marcou não perde o horário sozinho.
    assert.strictEqual(p.app.store.getBooking(consulta.id).status, 'confirmado');
    const visao = p.app.agenda.dayView(dia.date).find((v) => v.professional.id === 'dr-exemplo');
    assert.strictEqual(visao.bookings.length, 1, 'e continua aparecendo na agenda do dia');
  } finally {
    await p.fechar();
  }
});
