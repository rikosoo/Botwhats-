'use strict';

/**
 * Mensagens editáveis pelo painel.
 *
 * O texto padrão continua no código (`messages.js`); aqui ficam os campos que o
 * consultório pode reescrever sem programar. Campo vazio = usa o padrão, então
 * apagar o texto é sempre o caminho de volta.
 *
 * As variáveis são preenchidas na hora do envio. Uma variável que não existir
 * naquele contexto vira string vazia — nunca aparece `{nome}` cru para o paciente.
 */

/** Campos oferecidos no painel, na ordem em que aparecem. */
const CAMPOS = [
  {
    id: 'saudacao',
    titulo: 'Saudação (primeira mensagem)',
    descricao: 'Abre a conversa. O "Bom dia/Boa tarde/Boa noite" entra sozinho em {saudacao}.',
    variaveis: ['{saudacao}', '{primeiro_nome}', '{consultorio}', '{assistente}', '{especialidade}', '{horario_funcionamento}'],
  },
  {
    id: 'privacidade',
    titulo: 'Aviso de privacidade',
    descricao: 'Enviado uma única vez, no primeiro contato.',
    variaveis: ['{consultorio}'],
  },
  {
    id: 'agendamentoConfirmado',
    titulo: 'Confirmação do agendamento',
    descricao: 'Vai logo depois de reservar o horário.',
    variaveis: ['{primeiro_nome}', '{nome}', '{data}', '{hora}', '{medico}', '{atendimento}',
      '{endereco}', '{referencia}', '{documentos}', '{preparo}', '{antecedencia}', '{horas_cancelamento}'],
  },
  {
    id: 'lembreteVespera',
    titulo: 'Lembrete da véspera (pede sim ou não)',
    descricao: 'Um dia antes da consulta. É a mensagem que mais reduz falta.',
    variaveis: ['{primeiro_nome}', '{data}', '{hora}', '{medico}', '{duracao}', '{endereco}',
      '{documentos}', '{preparo}', '{antecedencia}'],
  },
  {
    id: 'lembreteAntes',
    titulo: 'Lembretes de 7 e 3 dias antes',
    descricao: 'Sem contagem regressiva: sirva para algo, não para cobrar.',
    variaveis: ['{primeiro_nome}', '{data}', '{hora}', '{medico}', '{preparo}'],
  },
  {
    id: 'followup1',
    titulo: 'Follow-up de 1 dia (não agendou)',
    descricao: 'Um dia depois do contato de quem não marcou.',
    variaveis: ['{primeiro_nome}', '{consultorio}', '{telefone}'],
  },
  {
    id: 'followup7',
    titulo: 'Follow-up de 7 dias',
    descricao: 'Uma semana depois, para quem continua sem marcar.',
    variaveis: ['{primeiro_nome}', '{consultorio}', '{telefone}'],
  },
  {
    id: 'followup15',
    titulo: 'Follow-up de 15 dias (último)',
    descricao: 'Último contato. Deixe claro que é o último e ofereça a saída.',
    variaveis: ['{primeiro_nome}', '{consultorio}', '{telefone}'],
  },
  {
    id: 'posConsulta',
    titulo: 'Check-in do dia seguinte',
    descricao: 'Enviado no dia seguinte, para quem compareceu. Não pergunte sobre sintomas.',
    variaveis: ['{primeiro_nome}', '{consultorio}'],
  },
  {
    id: 'semHorarios',
    titulo: 'Sem horário livre',
    descricao: 'Quando a agenda está fechada; é aqui que a lista de espera é oferecida.',
    variaveis: ['{primeiro_nome}', '{consultorio}', '{telefone}'],
  },
  {
    id: 'atendente',
    titulo: 'Transferência para a recepção',
    descricao: 'Quando o paciente pede uma pessoa — ou quando o bot desiste de entender.',
    variaveis: ['{primeiro_nome}', '{consultorio}', '{horario_funcionamento}', '{telefone}'],
  },
];

const IDS = CAMPOS.map((c) => c.id);

/** Troca as variáveis pelos valores; o que não existir vira vazio. */
function render(texto, contexto = {}) {
  return String(texto).replace(/\{([a-z_]+)\}/gi, (_, chave) => {
    const valor = contexto[chave];
    return valor === undefined || valor === null ? '' : String(valor);
  });
}

/**
 * Texto personalizado para este campo, ou null quando o consultório não mexeu.
 * @param {object} clinic
 * @param {string} id
 * @param {object} contexto
 */
function personalizado(clinic, id, contexto = {}) {
  const guardado = clinic && clinic.messages ? clinic.messages[id] : null;
  if (!guardado || !String(guardado).trim()) return null;
  return render(guardado, contexto).trim();
}

/** Só aceita os campos conhecidos, e guarda apenas o que tem conteúdo. */
function sanitizar(entrada) {
  const limpo = {};
  for (const id of IDS) {
    const valor = entrada && entrada[id];
    if (typeof valor === 'string' && valor.trim()) limpo[id] = valor.trim();
  }
  return limpo;
}

module.exports = { CAMPOS, IDS, render, personalizado, sanitizar };
