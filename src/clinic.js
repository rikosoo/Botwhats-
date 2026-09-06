'use strict';

/**
 * Configuracao do consultorio. Tudo aqui aparece nas respostas do bot e pode
 * ser editado pelo painel (aba Consultorio) ou pela API /api/clinic.
 */
const CLINICA_PADRAO = {
  name: 'Consultorio Dr. Exemplo',
  specialty: 'Clinica Geral',
  assistantName: 'Bia',
  greetingName: 'Consultorio Dr. Exemplo',
  address: 'Rua das Flores, 123 - sala 45, Centro, Sao Paulo/SP',
  addressHint: 'Predio comercial em frente a praca, com estacionamento conveniado no subsolo.',
  mapsUrl: 'https://maps.google.com/?q=Rua+das+Flores+123',
  phone: '(11) 4000-0000',
  hoursText: 'segunda a sexta, das 8h as 18h',
  // Convenios cadastrados. `active: false` deixa o plano no cadastro sem
  // oferece-lo ao paciente — util quando o credenciamento fica suspenso.
  acceptsInsurance: true,
  insurances: [
    { name: 'Unimed', active: true },
    { name: 'Bradesco Saude', active: true },
    { name: 'SulAmerica', active: true },
    { name: 'Amil', active: false },
  ],
  privatePrice: 'R$ 400,00 (consulta particular, com retorno em ate 30 dias incluso)',
  paymentInfo: 'Aceitamos Pix, dinheiro e cartao (credito em ate 3x).',
  documents: ['documento com foto', 'carteirinha do convenio', 'pedido medico (quando houver)', 'exames anteriores'],

  professionals: [
    {
      id: 'dr-exemplo',
      name: 'Dr. Exemplo Silva',
      specialty: 'Clinica Geral',
      crm: 'CRM/SP 000000',
      slotMinutes: 20,
      weekly: {
        0: [],
        1: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
        2: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
        3: [{ start: '08:00', end: '12:00' }],
        4: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
        5: [{ start: '08:00', end: '12:00' }],
        6: [],
      },
      exceptions: {},
    },
    {
      id: 'dra-exemplo',
      name: 'Dra. Exemplo Souza',
      specialty: 'Cardiologia',
      crm: 'CRM/SP 111111',
      slotMinutes: 30,
      weekly: {
        0: [],
        1: [{ start: '13:00', end: '19:00' }],
        2: [],
        3: [{ start: '13:00', end: '19:00' }],
        4: [],
        5: [{ start: '09:00', end: '13:00' }],
        6: [],
      },
      exceptions: {},
    },
  ],

  services: [
    {
      id: 'primeira-consulta',
      name: 'Primeira consulta',
      durationMin: 40,
      returnDays: 30,
      price: 'R$ 400,00',
      includes: [
        'avaliacao completa e exame fisico',
        'leitura dos exames que voce trouxer',
        'plano de tratamento por escrito',
        'retorno em ate 30 dias, sem custo',
      ],
      prep: 'Traga exames anteriores e a lista dos medicamentos que voce usa.',
    },
    {
      id: 'retorno',
      name: 'Retorno',
      durationMin: 20,
      returnDays: 0,
      price: 'sem custo em ate 30 dias da consulta; depois disso, R$ 250,00',
      includes: ['revisao do plano de tratamento', 'leitura dos exames solicitados'],
      prep: 'Traga os exames solicitados na ultima consulta.',
    },
    {
      id: 'exame',
      name: 'Exame / procedimento',
      durationMin: 30,
      returnDays: 0,
      price: 'varia conforme o exame — a recepcao confirma o valor exato',
      includes: ['realizacao do exame', 'laudo entregue em ate 5 dias uteis'],
      prep: 'Jejum de 8 horas. Pode beber agua. Nao suspenda medicamentos sem orientacao do medico.',
    },
  ],

  // Textos reescritos pelo painel (vazio = usa o padrao de core/messages.js).
  messages: {},

  policies: {
    arriveMinutes: 15,
    cancelHours: 24,
    lateToleranceMinutes: 15,
    privacyNotice:
      'Suas mensagens sao usadas apenas para agendamento e lembretes. '
      + 'Nao envie sintomas, laudos ou exames por aqui — esses assuntos sao tratados na consulta.',
  },
};

/** Aceita tanto o formato antigo (lista de nomes) quanto o novo. */
function normalizarConvenios(lista) {
  return (lista || [])
    .map((item) => (typeof item === 'string' ? { name: item, active: true } : item))
    .filter((item) => item && item.name && item.name.toLowerCase() !== 'particular');
}

/** Convenios que o consultorio esta atendendo agora. */
function conveniosAtivos(clinic) {
  if (!clinic.acceptsInsurance) return [];
  return normalizarConvenios(clinic.insurances).filter((c) => c.active).map((c) => c.name);
}

/** Convenio cadastrado porem suspenso — vale uma resposta diferente de "nao atendemos". */
function convenioSuspenso(clinic, nome) {
  return normalizarConvenios(clinic.insurances)
    .some((c) => !c.active && c.name.toLowerCase() === String(nome).toLowerCase());
}

/** Opcoes que o paciente ve na hora de escolher. */
function opcoesDePagamento(clinic) {
  return [...conveniosAtivos(clinic), 'Particular'];
}

/** Servico pelo id, com fallback no primeiro cadastrado. */
function findService(clinic, serviceId) {
  return clinic.services.find((s) => s.id === serviceId) || clinic.services[0];
}

/** Profissional pelo id. */
function findProfessional(clinic, professionalId) {
  return clinic.professionals.find((p) => p.id === professionalId) || null;
}

module.exports = {
  CLINICA_PADRAO,
  findService,
  findProfessional,
  normalizarConvenios,
  conveniosAtivos,
  convenioSuspenso,
  opcoesDePagamento,
};
