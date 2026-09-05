'use strict';

const { formatDateBr } = require('./agenda');

/**
 * Disparo de mensagens escritas pela recepção para um grupo de pacientes.
 *
 * Cuidados embutidos, porque disparo em massa é onde um número do WhatsApp
 * costuma ser bloqueado (e onde se incomoda paciente):
 *  - quem pediu "sair" nunca entra, mesmo se estiver selecionado;
 *  - o mesmo número não recebe duas vezes no mesmo disparo;
 *  - o envio é espaçado, não em rajada;
 *  - existe um teto de destinatários por disparo.
 */

/** Segmentos prontos. Cada um recebe { contato, store, agenda, agora }. */
const SEGMENTOS = {
  contatos: {
    label: 'Já entraram em contato',
    descricao: 'Qualquer pessoa que já mandou mensagem para o consultório',
    filtro: ({ contato, store }) => store.messagesOf(contato.id).some((m) => m.direction === 'in'),
  },
  sem_consulta: {
    label: 'Sem consulta marcada',
    descricao: 'Já falaram com a gente, mas não têm horário futuro',
    filtro: ({ contato, store, agenda }) => store.messagesOf(contato.id).some((m) => m.direction === 'in')
      && !agenda.nextBookingOf(contato.id),
  },
  agendados: {
    label: 'Com consulta marcada',
    descricao: 'Têm consulta futura confirmada na agenda',
    filtro: ({ contato, agenda }) => !!agenda.nextBookingOf(contato.id),
  },
  a_confirmar: {
    label: 'Aguardando confirmação',
    descricao: 'Têm consulta futura, mas ainda não confirmaram presença',
    filtro: ({ contato, agenda }) => {
      const consulta = agenda.nextBookingOf(contato.id);
      return !!consulta && consulta.confirmation !== 'confirmado';
    },
  },
  faltaram: {
    label: 'Faltaram alguma vez',
    descricao: 'Tiveram falta registrada pela recepção',
    filtro: ({ contato, store }) => store.bookingsOf(contato.id).some((b) => b.attendance === 'faltou'),
  },
  atendidos: {
    label: 'Já foram atendidos',
    descricao: 'Compareceram a pelo menos uma consulta',
    filtro: ({ contato, store }) => store.bookingsOf(contato.id).some((b) => b.attendance === 'compareceu'),
  },
  inativos: {
    label: 'Sem falar há 30 dias',
    descricao: 'Último contato há mais de 30 dias',
    filtro: ({ contato, agora }) => contato.lastInboundAt
      && agora - new Date(contato.lastInboundAt).getTime() > 30 * 86400000,
  },
  todos: {
    label: 'Todos os cadastros',
    descricao: 'Inclui quem foi cadastrado pela recepção sem ter escrito',
    filtro: () => true,
  },
};

/** Variáveis que a recepção pode usar no texto. */
const VARIAVEIS = {
  '{nome}': ({ contato }) => contato.name || '',
  '{primeiro_nome}': ({ contato }) => (contato.name ? contato.name.trim().split(/\s+/)[0] : ''),
  '{telefone}': ({ contato }) => contato.phone,
  '{convenio}': ({ contato }) => contato.insurance || 'particular',
  '{consultorio}': ({ clinic }) => clinic.name,
  '{telefone_consultorio}': ({ clinic }) => clinic.phone,
  '{endereco}': ({ clinic }) => clinic.address,
  '{data_consulta}': ({ consulta }) => (consulta ? formatDateBr(consulta.date) : ''),
  '{hora_consulta}': ({ consulta }) => (consulta ? consulta.start : ''),
  '{medico}': ({ consulta, clinic }) => (consulta ? consulta.professionalName : clinic.professionals[0].name),
};

class Broadcast {
  /**
   * @param {import('../db/store').Store} store
   * @param {import('./agenda').Agenda} agenda
   * @param {object} config
   * @param {(phone: string, text: string) => Promise<any>} send
   */
  constructor(store, agenda, config, send) {
    this.store = store;
    this.agenda = agenda;
    this.config = config;
    this.send = send;
  }

  get clinic() {
    return this.store.clinic;
  }

  /** Contatos de um segmento (sem aplicar as regras de envio ainda). */
  segmentar(segmento, agora = Date.now()) {
    const definicao = SEGMENTOS[segmento] || SEGMENTOS.contatos;
    return this.store.state.contacts.filter((contato) => definicao.filtro({
      contato, store: this.store, agenda: this.agenda, agora,
    }));
  }

  /** Troca as variáveis pelo dado real do paciente. */
  personalizar(texto, contato) {
    const consulta = this.agenda.nextBookingOf(contato.id);
    const ctx = { contato, consulta, clinic: this.clinic };
    return Object.entries(VARIAVEIS).reduce(
      (acc, [chave, valor]) => acc.split(chave).join(valor(ctx)),
      String(texto),
    );
  }

  /**
   * Aplica as regras de envio: tira opt-out, repetidos e quem não existe.
   * Devolve { destinatarios, ignorados }.
   */
  preparar(contactIds) {
    const vistos = new Set();
    const destinatarios = [];
    const ignorados = [];

    for (const id of contactIds) {
      const contato = this.store.getContact(id);
      if (!contato) { ignorados.push({ id, motivo: 'não encontrado' }); continue; }
      if (contato.optOut) { ignorados.push({ id, nome: contato.name, motivo: 'pediu para não receber' }); continue; }
      if (vistos.has(contato.phone)) { ignorados.push({ id, nome: contato.name, motivo: 'número repetido' }); continue; }
      vistos.add(contato.phone);
      destinatarios.push(contato);
    }
    return { destinatarios, ignorados };
  }

  /** Prévia: como a mensagem fica para os primeiros destinatários. */
  previa(contactIds, texto, limite = 3) {
    const { destinatarios, ignorados } = this.preparar(contactIds);
    return {
      total: destinatarios.length,
      ignorados,
      exemplos: destinatarios.slice(0, limite).map((c) => ({
        nome: c.name || c.phone,
        phone: c.phone,
        texto: this.personalizar(texto, c),
      })),
    };
  }

  /** Cria o disparo. Sem `scheduledAt`, começa a enviar em seguida. */
  criar({ contactIds, texto, segmento = null, scheduledAt = null }) {
    if (!texto || !texto.trim()) throw new Error('Escreva a mensagem antes de disparar');
    const { destinatarios, ignorados } = this.preparar(contactIds || []);
    if (!destinatarios.length) throw new Error('Nenhum destinatário válido para este disparo');

    const teto = this.config.broadcastMaxRecipients || 200;
    if (destinatarios.length > teto) {
      throw new Error(`Disparo acima do limite de ${teto} destinatários (selecionados: ${destinatarios.length})`);
    }

    const campanha = this.store.addCampaign({
      texto,
      segmento,
      scheduledAt,
      total: destinatarios.length,
      skipped: ignorados.length,
      contactIds: destinatarios.map((c) => c.id),
      status: scheduledAt ? 'agendado' : 'enviando',
    });

    if (scheduledAt) {
      // Agendado: vira um lembrete por paciente, com o texto já personalizado.
      for (const contato of destinatarios) {
        this.store.addReminder({
          contactId: contato.id,
          campaignId: campanha.id,
          kind: 'campanha',
          offsetDays: 0,
          dueAt: new Date(scheduledAt).toISOString(),
          text: this.personalizar(texto, contato),
        });
      }
      this.store.logEvent('disparo', `Disparo agendado para ${destinatarios.length} paciente(s) em ${new Date(scheduledAt).toLocaleString('pt-BR')}`);
      return campanha;
    }

    this.store.logEvent('disparo', `Disparo iniciado para ${destinatarios.length} paciente(s)`);
    // Guardado para quem quiser esperar o fim (testes e encerramento do servidor).
    this.emAndamento = this.executar(campanha, destinatarios).catch((err) => {
      campanha.status = 'erro';
      campanha.error = err.message;
      this.store.commit('campaign', campanha);
    });
    return campanha;
  }

  /** Envia um a um, com intervalo entre as mensagens. */
  async executar(campanha, destinatarios) {
    const intervalo = this.config.broadcastDelayMs || 0;
    for (let i = 0; i < destinatarios.length; i += 1) {
      const contato = destinatarios[i];
      if (contato.optOut) { campanha.skipped += 1; continue; } // pediu para sair no meio do disparo
      try {
        await this.send(contato.phone, this.personalizar(campanha.texto, contato));
        campanha.sent += 1;
      } catch (err) {
        campanha.failed += 1;
        campanha.error = err.message;
      }
      this.store.commit('campaign', campanha);
      if (intervalo && i < destinatarios.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalo));
      }
    }
    campanha.status = campanha.failed ? 'concluído com falhas' : 'concluído';
    campanha.finishedAt = new Date().toISOString();
    this.store.commit('campaign', campanha);
    this.store.logEvent('disparo', `Disparo concluído: ${campanha.sent} enviada(s), ${campanha.failed} falha(s), ${campanha.skipped} ignorada(s)`);
    return campanha;
  }
}

module.exports = { Broadcast, SEGMENTOS, VARIAVEIS };
