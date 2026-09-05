'use strict';

/**
 * Popula o painel com um dia típico de consultório, para ver o
 * autoatendimento funcionando. Uso: npm run seed
 */

const config = require('../src/config');
const { createApp } = require('../src/app');

const ROTEIROS = [
  {
    phone: '5511988880001',
    nome: 'Ana Ribeiro',
    mensagens: ['Oi, bom dia!', 'gostaria de marcar uma consulta', 'é a primeira vez',
      'unimed', '1', '1', '1', 'Ana Ribeiro Costa', '14/03/1985', 'sim'],
  },
  {
    phone: '5511988880002',
    nome: 'Bruno Alves',
    mensagens: ['boa tarde', 'vocês atendem qual convênio?', 'e quanto custa particular?'],
  },
  {
    phone: '5511988880003',
    nome: 'Carla Dias',
    mensagens: ['oi', 'preciso de um retorno', 'particular', 'tanto faz', '1', '2',
      'Carla Dias Moreira', '02/11/1978', 'sim', 'confirmo'],
  },
  {
    phone: '5511988880004',
    nome: null,
    mensagens: ['Bom dia', 'estou com dor no peito e falta de ar'],
  },
  {
    phone: '5511988880005',
    nome: 'Eduardo Lima',
    mensagens: ['oi', 'onde fica o consultório?', 'preciso de jejum para o exame?',
      'quero falar com a secretária'],
  },
];

/** Histórico do último mês, para a aba Números ter o que mostrar. */
function historico(app) {
  const DAY = 86400000;
  const passado = [
    { dias: 2, nome: 'Marta Bueno', attendance: 'compareceu', confirmation: 'confirmado' },
    { dias: 3, nome: 'Paulo Freire', attendance: 'compareceu', confirmation: 'confirmado' },
    { dias: 5, nome: 'Rita Campos', attendance: 'faltou', confirmation: 'aguardando' },
    { dias: 8, nome: 'Sergio Maia', attendance: 'compareceu', confirmation: 'confirmado' },
    { dias: 9, nome: 'Tania Rocha', attendance: 'faltou', confirmation: 'aguardando' },
    { dias: 12, nome: 'Ulisses Prado', attendance: 'compareceu', confirmation: 'aguardando' },
    { dias: 14, nome: 'Vera Lima', attendance: 'compareceu', confirmation: 'confirmado' },
    { dias: 16, nome: 'Wagner Reis', attendance: 'faltou', confirmation: 'confirmado' },
    { dias: 19, nome: 'Xenia Alves', attendance: 'compareceu', confirmation: 'confirmado' },
    { dias: 22, nome: 'Yara Souza', attendance: null, confirmation: 'aguardando' },
  ];

  passado.forEach((registro, i) => {
    const paciente = app.store.upsertContact(`551197777${String(1000 + i)}`, registro.nome);
    const startsAt = new Date(Date.now() - registro.dias * DAY);
    const profissional = i % 3 === 0 ? app.store.clinic.professionals[1] : app.store.clinic.professionals[0];
    app.store.addBooking({
      contactId: paciente.id,
      professionalId: profissional.id,
      professionalName: profissional.name,
      serviceId: i % 2 ? 'retorno' : 'primeira-consulta',
      serviceName: i % 2 ? 'Retorno' : 'Primeira consulta',
      date: startsAt.toISOString().slice(0, 10),
      start: '10:00',
      end: '10:40',
      startsAt: startsAt.toISOString(),
      attendance: registro.attendance,
      confirmation: registro.confirmation,
      insurance: i % 2 ? 'Unimed' : 'Particular',
    });
    paciente.stage = 'ativo';
  });
}

async function main() {
  const app = createApp({ ...config, channel: 'mock', typingDelayMs: 0 });
  for (const roteiro of ROTEIROS) {
    for (const body of roteiro.mensagens) {
      await app.handleIncoming({ phone: roteiro.phone, name: roteiro.nome, body });
    }
  }
  historico(app);

  // Alguém que respondeu "não" ao lembrete de véspera: a vaga precisa voltar
  // para a agenda antes do dia.
  const carla = app.store.findContactByPhone('5511988880003');
  const consultaDaCarla = carla && app.agenda.nextBookingOf(carla.id);
  if (consultaDaCarla) {
    consultaDaCarla.confirmation = 'recusado';
    app.store.logEvent('confirmacao', `⚠️ ${carla.name} avisou que não vem em ${consultaDaCarla.date}`);
  }

  app.store.saveNow();

  const s = app.store.state;
  console.log(`Painel populado: ${s.contacts.length} pacientes, `
    + `${s.bookings.filter((b) => b.status === 'confirmado').length} consultas, `
    + `${s.reminders.filter((r) => r.status === 'pending').length} lembretes programados, `
    + `${s.events.filter((e) => e.type === 'urgencia').length} urgência(s), `
    + `${s.bookings.filter((b) => b.attendance).length} consulta(s) com presença registrada.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
